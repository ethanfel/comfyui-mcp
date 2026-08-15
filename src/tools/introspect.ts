/**
 * Ground-truth introspection of the registered MCP tool surface.
 *
 * Boots the REAL McpServer with the REAL registration pass and asks it over a
 * real MCP client, so the name, description, annotations and inputSchema are
 * exactly what a client is told in `tools/list` — in particular the JSON Schema
 * the SDK actually derives from each zod shape, which is where a registration can
 * silently normalise to `{}`.
 *
 * It is NOT the whole ToolSchema: `title`, `icons`, `outputSchema`, `execution` and
 * `_meta` are dropped, so a change to any of those is invisible here. Nor does it
 * see anything behind the CONFIGURED server — createConfiguredServer() (src/boot.ts)
 * chooses full versus compact registration, and this calls registerAllTools()
 * directly. Stated explicitly because "what a client sees" invites the reading that
 * anything a client could notice is covered, and it is not.
 *
 * Why this exists rather than `collectToolCatalog()` (src/tools/catalog.ts):
 * the catalog is a duck-typed stand-in that infers "description" and "schema"
 * positionally from the `server.tool(...)` arguments. That makes it blind to
 * anything the SDK would reject or transform — a registration the SDK drops, or
 * a schema it normalises to `{}`, still "counts" there. Going through the SDK
 * means a tool only counts if a client can genuinely see it.
 *
 * Used by: scripts/tools-dump.mts (the per-phase surface probe) and
 * src/__tests__/tools/registry-surface.test.ts (the CI surface gate).
 *
 * NOT yet used by scripts/asset-counts.mjs, which is `ci.yml`'s count gate and
 * still imports the duck-typed `collectToolCatalog()` from `dist/`. Until that
 * migrates (comfyui-mcp-3nh), the count CI publishes is derived from a stale
 * build by a capture that cannot see SDK rejection — the exact blindness this
 * module exists to remove. Stated here rather than implied, because a comment
 * describing intended wiring reads as a guarantee that CI already enforces it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools, registerFullTools } from "./index.js";

/**
 * Which registration pass to introspect.
 *
 * `"registration"` — `registerAllTools()`: the surface the vocabulary ledger
 * describes, one entry per `TOOL_NAMES` name. This is what the ledger gate compares
 * against.
 *
 * `"served"` — `registerFullTools()`: what a full-mode client is actually OFFERED,
 * which is the ledger surface PLUS the three facade meta-tools layered on top for
 * reconnect resilience (#616). The two counts differ by exactly 3, and that gap is
 * real rather than cosmetic — a client's `tools/list` returns `MAX_TOOLS + 3`, so any
 * consumer that expects the ledger count off the wire is off by three. Kept as an
 * explicit mode rather than a second copy of this function so the pagination and
 * cleanup below stay in one place.
 */
export type ToolSurface = "registration" | "served";

export interface RegisteredTool {
  name: string;
  description: string;
  /** The JSON Schema the SDK derived — `{type:"object",properties:{}}` if the
   *  shape was unrepresentable, which is itself a finding worth asserting on. */
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

/**
 * Every tool a client can see, in registration order.
 *
 * Follows `nextCursor` to completion: `tools/list` is a paginated request, and a
 * single-page assumption would silently under-report once the surface grows.
 */
export async function listRegisteredTools(
  surface: ToolSurface = "registration",
): Promise<RegisteredTool[]> {
  const server = new McpServer({ name: "comfyui-mcp-introspect", version: "0.0.0" });
  if (surface === "served") await registerFullTools(server);
  else await registerAllTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "comfyui-mcp-introspect", version: "0.0.0" });

  // The connects are INSIDE the try. With them outside it, a Promise.all where one
  // side connects and the other rejects skips the finally entirely and leaks the
  // connected half — which keeps the event loop alive, so a CLI probe hangs
  // instead of reporting the error that caused it.
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools: RegisteredTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}),
        });
      }
      cursor = page.nextCursor;
      // A server that returns the same nextCursor twice would spin forever,
      // appending duplicates until the process dies of memory exhaustion. Today's
      // in-process SDK server does not paginate at all, so this cannot trigger —
      // it guards a DEPENDENCY behaviour we do not control, in a probe that CI
      // depends on. Throwing beats a hang: a hang has no diagnosis.
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) {
          throw new Error(
            `tools/list returned a repeated nextCursor (${JSON.stringify(cursor)}) after ` +
              `${tools.length} tools — refusing to loop forever.`,
          );
        }
        seenCursors.add(cursor);
      }
    } while (cursor);
    return tools;
  } finally {
    // Close both ends: an unclosed in-memory pair keeps the event loop alive and
    // a CLI probe would hang instead of exiting.
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** Just the names, in registration order (which `tools/list` preserves). */
export async function listRegisteredToolNames(surface: ToolSurface = "registration"): Promise<string[]> {
  return (await listRegisteredTools(surface)).map((t) => t.name);
}
