// Orchestrator-hosted HTTP MCP server for the panel_* live-graph tools (Codex).
//
// The Codex `codex app-server` can only host CONFIG-DECLARED MCP servers — it
// can't run an in-process SDK MCP server the way the Claude Agent SDK does. So
// to give Codex the SAME live-canvas control Claude has, the orchestrator stands
// up an HTTP MCP endpoint here and declares its loopback route to Codex as
// `mcp_servers.panel.url = http://127.0.0.1:<port>/<tabId>`.
//
// ROUTING: the URL path is the panel tab id. Each tab gets its OWN McpServer
// instance whose tools forward to `bridge.send(cmd, { tabId })` for THAT tab —
// exactly like the in-process per-tab server the Claude path uses. The tool
// SURFACE is shared (registerPanelTools / buildPanelToolDefs in panel-tools.ts),
// so Codex and Claude expose an identical panel toolset and parity is automatic.
//
// REMOTE OPT-IN: the default remains loopback-only. An operator may explicitly
// bind a LAN interface and publish a base URL, but every non-loopback request is
// then bearer-authenticated. Loopback callers stay credential-free so the
// orchestrator's own Codex/Gemini backends keep working unchanged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { UiBridge } from "../services/ui-bridge.js";
import type { WorkflowTargetStore } from "../services/workflow-target-store.js";
import { makePanelToolCtx, registerPanelTools } from "./panel-tools.js";
import { logger } from "../utils/logger.js";

/** A live MCP session: one McpServer + its streamable-HTTP transport, bound to a
 *  panel tab. Keyed by the transport's session id within a tab's session map. */
interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface PanelMcpHttpServer {
  /** The bound port. */
  readonly port: number;
  /** Build the loopback URL used by orchestrator-owned agent backends. */
  urlFor(tabId: string): string;
  /** Authenticated externally reachable base URL, when explicitly configured. */
  readonly publicBaseUrl: string | null;
  /** Stop the HTTP server and tear down every live session. */
  stop(): Promise<void>;
}

export interface PanelMcpHttpOptions {
  host?: string;
  workflowTargets?: WorkflowTargetStore;
  /** Required for every non-loopback request. Never included in advertised URLs. */
  bearerToken?: string | null;
  /** Reachable origin/base advertised to panels, e.g. http://192.168.1.12:9181. */
  publicBaseUrl?: string | null;
}

export const PANEL_MCP_BEARER_TOKEN_ENV = "COMFYUI_MCP_PANEL_MCP_TOKEN";

interface RequestSecurityInput {
  remoteAddress?: string;
  hostHeader?: string;
  originHeader?: string;
  authorizationHeader?: string;
  port: number;
  publicHost: string | null;
  bearerToken: string | null;
}

interface RequestSecurityResult {
  ok: boolean;
  status: number;
  message?: string;
}

function loopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function loopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function bearerMatches(header: string | undefined, token: string | null): boolean {
  if (!header || !token) return false;
  const actual = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Shared by the HTTP handler and focused tests. Remote access fails closed. */
export function authorizePanelMcpRequest(input: RequestSecurityInput): RequestSecurityResult {
  if (input.originHeader) {
    return { ok: false, status: 403, message: "Cross-origin requests are not allowed." };
  }

  const local = loopbackAddress(input.remoteAddress);
  const loopbackHost =
    input.hostHeader === `127.0.0.1:${input.port}` || input.hostHeader === `localhost:${input.port}`;
  if (loopbackHost) {
    return local
      ? { ok: true, status: 200 }
      : { ok: false, status: 403, message: "Forbidden host." };
  }

  if (!input.publicHost || input.hostHeader !== input.publicHost) {
    return { ok: false, status: 403, message: "Forbidden host." };
  }
  // A request aimed at the public route always authenticates, even if a local
  // reverse proxy makes its socket peer appear loopback.
  if (!bearerMatches(input.authorizationHeader, input.bearerToken)) {
    return { ok: false, status: 401, message: "Valid bearer authentication is required." };
  }
  return { ok: true, status: 200 };
}

function normalizePublicBaseUrl(raw: string | null | undefined): { baseUrl: string | null; host: string | null } {
  const value = raw?.trim();
  if (!value) return { baseUrl: null, host: null };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("COMFYUI_MCP_PANEL_MCP_PUBLIC_URL must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("COMFYUI_MCP_PANEL_MCP_PUBLIC_URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("COMFYUI_MCP_PANEL_MCP_PUBLIC_URL must not contain credentials, a query, or a fragment.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return { baseUrl: parsed.toString().replace(/\/$/, ""), host: parsed.host };
}

/** Read the raw request body (Codex POSTs JSON-RPC). The transport wants the
 *  parsed body passed alongside the req/res. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined); // let the transport reject malformed JSON
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/** Extract the tab id from the request URL path (`/<tabId>`). */
function tabIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0].replace(/^\/+|\/+$/g, "");
  return path.length ? decodeURIComponent(path) : null;
}

/**
 * Start the HTTP MCP server that exposes the panel_* tools to Codex, routed by
 * tab id. It is loopback-only unless a host, public URL, and strong bearer token
 * are all explicitly supplied.
 */
export function startPanelMcpHttpServer(
  bridge: UiBridge,
  port: number,
  options: PanelMcpHttpOptions = {},
): Promise<PanelMcpHttpServer> {
  const host = options.host?.trim() || "127.0.0.1";
  const bearerToken = options.bearerToken?.trim() || null;
  const { baseUrl: publicBaseUrl, host: publicHost } = normalizePublicBaseUrl(options.publicBaseUrl);
  const remoteEnabled = !loopbackBindHost(host) || publicBaseUrl !== null;
  if (remoteEnabled && host !== "0.0.0.0") {
    throw new Error(
      "Remote panel MCP requires COMFYUI_MCP_PANEL_MCP_HOST=0.0.0.0 so the same listener remains reachable through 127.0.0.1 by internal agents.",
    );
  }
  if (remoteEnabled && (!bearerToken || bearerToken.length < 24)) {
    throw new Error(
      "Remote panel MCP requires COMFYUI_MCP_PANEL_MCP_TOKEN containing at least 24 characters.",
    );
  }
  if (remoteEnabled && !publicBaseUrl) {
    throw new Error(
      "Remote panel MCP requires COMFYUI_MCP_PANEL_MCP_PUBLIC_URL so clients and Host validation use the intended address.",
    );
  }

  // tabId -> (sessionId -> Session). A tab can hold multiple Codex sessions
  // across reconnects; each is its own server+transport over the SAME tab ctx.
  const tabs = new Map<string, Map<string, Session>>();

  // The port ACTUALLY bound, which is not always the port asked for: `listen(0)`
  // means "any free port", and the OS picks it. Everything downstream — the URL
  // handed to the backend, the transport's DNS-rebinding allowlist, and the Host
  // guard below — has to name the real one, or a server that came up fine is
  // unreachable at the address it advertises and rejects the requests that do
  // arrive. Kept in sync at `listen`, before any of those readers can run.
  let boundPort = port;

  const newSession = async (tabId: string): Promise<Session> => {
    const server = new McpServer({ name: "comfyui-panel", version: "1.0.0" });
    // Tab-bound context: every tool forwards to the bridge for THIS tab — the
    // same surface the Claude in-process server exposes (shared defs).
    registerPanelTools(server, makePanelToolCtx(bridge, tabId, options.workflowTargets));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Defense in depth against DNS rebinding (a malicious page resolving its own
      // host to 127.0.0.1 to reach this loopback server). We also Host/Origin-guard
      // in the request handler since we hand-roll http.createServer.
      enableDnsRebindingProtection: true,
      allowedHosts: [
        `127.0.0.1:${boundPort}`,
        `localhost:${boundPort}`,
        ...(publicHost ? [publicHost] : []),
      ],
      allowedOrigins: [], // no browser origin should ever reach this (Codex sends none)
      onsessioninitialized: (sid) => {
        let m = tabs.get(tabId);
        if (!m) {
          m = new Map();
          tabs.set(tabId, m);
        }
        m.set(sid, { server, transport });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        const m = tabs.get(tabId);
        m?.delete(sid);
        if (m && m.size === 0) tabs.delete(tabId); // don't leak empty per-tab maps
      }
    };
    await server.connect(transport);
    return { server, transport };
  };

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // SECURITY: loopback callers require exact local Host + no Origin. LAN
        // callers additionally require the advertised Host and a constant-time
        // bearer check. This runs before parsing any request body or creating a
        // tool session.
        const security = authorizePanelMcpRequest({
          remoteAddress: req.socket.remoteAddress,
          hostHeader: req.headers.host,
          originHeader: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
          authorizationHeader:
            typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
          port: boundPort,
          publicHost,
          bearerToken,
        });
        if (!security.ok) {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (security.status === 401) headers["www-authenticate"] = "Bearer";
          res.writeHead(security.status, headers).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: security.message }, id: null }),
          );
          return;
        }
        const tabId = tabIdFromUrl(req.url);
        if (!tabId) {
          res.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Missing tab id in path (/<tabId>)." }, id: null }),
          );
          return;
        }
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const tabSessions = tabs.get(tabId);
        const existing = sessionId ? tabSessions?.get(sessionId) : undefined;

        // #1524 — a session id we do not know is a SESSION problem, and the status
        // code is the only place the protocol says so. 404 means "that session is
        // gone", on which the client MUST open a new one with a fresh
        // InitializeRequest; 400 means "this request was malformed", which no
        // client retries and none re-initializes on. Answering the first case with
        // the second is why the panel half of a dropped session never came back
        // while the stdio `comfyui` half — which the client simply respawns, and
        // which needs no such signal — always did.
        //
        // Every session map here is process-local, so an orchestrator restart
        // invalidates every id at once. That is not an edge case on this install:
        // the dev build self-restarts on rebuild.
        //
        // Scoped deliberately to "an id was presented and is unknown". A request
        // with NO id keeps its 400 below: there is no session to recover, and
        // sending it to re-initialize something it never opened would loop it.
        if (sessionId && !existing) {
          res.writeHead(404, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message:
                  "Session not found — this session id is not known to this orchestrator " +
                  "(it may have restarted). Open a new session with an initialize request.",
              },
              id: null,
            }),
          );
          return;
        }

        if (existing) {
          // Established session — GET (SSE), POST (messages), DELETE (close).
          const body = req.method === "POST" ? await readJsonBody(req) : undefined;
          await existing.transport.handleRequest(req, res, body);
          return;
        }

        // No session yet: only an initialize POST may open one.
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (isInitializeRequest(body)) {
            const sess = await newSession(tabId);
            try {
              await sess.transport.handleRequest(req, res, body);
            } catch (e) {
              // Initialize failed before the session registered — tear down the
              // freshly-connected server/transport so it doesn't leak.
              try {
                await sess.transport.close();
              } catch {
                // best-effort
              }
              throw e;
            }
            return;
          }
          res.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "No valid session id, and not an initialize request." },
              id: null,
            }),
          );
          return;
        }

        // GET/DELETE without a known session.
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown or missing session id." }, id: null }),
        );
      } catch (err) {
        logger.error(`[panel-mcp-http] request error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" }).end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error." }, id: null }),
          );
        }
      }
    })();
  });

  return new Promise<PanelMcpHttpServer>((resolve, reject) => {
    httpServer.on("error", (err) => reject(err));
    httpServer.listen(port, host, () => {
      // Read the port back off the socket rather than echoing the request. They
      // are the same number for every caller that names one, and different for
      // `listen(0)` — where echoing produced a server advertising `:0`, which no
      // client can dial and whose own Host guard would reject anything that did.
      const addr = httpServer.address();
      boundPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info(
        `[panel-mcp-http] panel_* MCP listening on http://${host}:${boundPort}/<tabId>` +
          (publicBaseUrl ? `; authenticated external base ${publicBaseUrl}` : " (loopback only)"),
      );
      resolve({
        port: boundPort,
        // Always keep orchestrator-owned agents on loopback. Even when the
        // listener is 0.0.0.0, they neither need nor receive the external token.
        urlFor: (tabId: string) => `http://127.0.0.1:${boundPort}/${encodeURIComponent(tabId)}`,
        publicBaseUrl,
        stop: async () => {
          for (const tabSessions of tabs.values()) {
            for (const s of tabSessions.values()) {
              try {
                await s.transport.close();
              } catch {
                // best-effort during shutdown
              }
            }
          }
          tabs.clear();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}
