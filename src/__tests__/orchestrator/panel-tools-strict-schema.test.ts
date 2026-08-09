// panel#754 — an unrecognized argument key was silently DROPPED, not rejected.
// Measured: a real call and one carrying an extra `utterly_bogus_param` key
// returned byte-identical replies. zod's default `z.object()` is "strip" mode,
// so an unknown key vanishes before the handler ever sees it — a caller with a
// misspelled or hallucinated field name gets no signal anything was wrong; the
// call just quietly does less than asked.
//
// These tests exercise the REAL dispatch path, not just the schema object in
// isolation: a genuine `@modelcontextprotocol/sdk` McpServer, registered via
// `registerPanelTools` exactly as production does, connected to a real Client
// over an in-memory transport. The unrecognized-key rejection has to survive
// `normalizeObjectSchema` + `safeParseAsync` inside the SDK's own
// `validateToolInput` — nothing here is mocked at the validation layer.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildPanelToolDefs, registerPanelTools, type PanelToolCtx } from "../../orchestrator/panel-tools.js";

const BOGUS_KEY = "__e2e_bogus_marker_754__";

function makeFakeCtx(): PanelToolCtx {
  return {
    call: async (cmd) => ({ content: [{ type: "text", text: JSON.stringify(cmd) }] }),
    confirm: async () => "yes" as const,
    bridge: {
      send: async () => ({}),
    } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
}

describe("panel-tools #754: strict schemas reject unknown argument keys", () => {
  let client: Client;
  let server: McpServer;

  beforeAll(async () => {
    server = new McpServer({ name: "panel-tools-strict-test", version: "1.0.0" });
    registerPanelTools(server, makeFakeCtx());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "panel-tools-strict-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  const defs = buildPanelToolDefs();
  const allOptional = defs.filter((d) => z.object(d.schema).safeParse({}).success);
  const hasRequired = defs.filter((d) => !z.object(d.schema).safeParse({}).success);

  it("the survey itself is meaningful — both groups are non-trivial", () => {
    // If either group collapsed to 0 the tests below would pass vacuously.
    expect(allOptional.length).toBeGreaterThan(10);
    expect(hasRequired.length).toBeGreaterThan(10);
    expect(allOptional.length + hasRequired.length).toBe(defs.length);
  });

  describe.each(allOptional.map((d) => d.name))("all-optional tool: %s", (name) => {
    it("an empty call is NOT rejected for carrying an unknown key (there isn't one)", async () => {
      const r = await client.callTool({ name, arguments: {} });
      const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
      // May still be isError for OPERATIONAL reasons against the fake ctx/bridge
      // (e.g. "no connected tab") — that is fine and expected; what must NOT
      // appear is the schema-validation rejection this test exists to check for.
      expect(text).not.toMatch(/Unrecognized key|Input validation error/);
    });

    it("the SAME call plus one unknown key IS rejected, naming the key", async () => {
      const r = await client.callTool({ name, arguments: { [BOGUS_KEY]: true } });
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
      expect(text).toContain(BOGUS_KEY);
      expect(text).toMatch(/Unrecognized key|unrecognized_keys/);
    });
  });

  describe.each(hasRequired.map((d) => d.name))("required-field tool: %s", (name) => {
    it("an unknown key is flagged even when required fields are also missing", async () => {
      // Weaker than the all-optional case (this call was never going to validate
      // cleanly), but it proves strictness reaches EVERY tool uniformly — the
      // combined zod error still names the unknown key alongside the missing
      // required ones, rather than being silently absorbed into "just missing
      // fields".
      const r = await client.callTool({ name, arguments: { [BOGUS_KEY]: true } });
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ text?: string }>)?.[0]?.text ?? "";
      expect(text).toContain(BOGUS_KEY);
    });
  });

  it("SPOT CHECK — a VALID required-field call succeeds at the schema layer; the same call plus a bogus key does not", async () => {
    // panel_add_node requires only class_type; a fresh /object_info refresh isn't
    // needed for the fake ctx to accept the call — this isolates the schema-layer
    // effect from anything the real handler would do against a live panel.
    const valid = await client.callTool({ name: "panel_add_node", arguments: { class_type: "KSampler" } });
    const validText = (valid.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(validText).not.toMatch(/Unrecognized key|Input validation error/);

    const poisoned = await client.callTool({
      name: "panel_add_node",
      arguments: { class_type: "KSampler", [BOGUS_KEY]: true },
    });
    expect(poisoned.isError).toBe(true);
    const poisonedText = (poisoned.content as Array<{ text?: string }>)?.[0]?.text ?? "";
    expect(poisonedText).toContain(BOGUS_KEY);
  });

  it("WIRING: both registration call sites route through strictPanelSchema, not the raw shape", () => {
    // A green protocol-dispatch test above proves the CURRENT registration works;
    // it says nothing about whether a future edit reverts one of the two call
    // sites back to the raw (non-strict) shape while leaving the other fixed.
    // Read the source directly for both.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../orchestrator/panel-tools.ts"), "utf8");

    // registerPanelTools (MCP SDK / Codex HTTP transport).
    const registerIdx = src.indexOf("export function registerPanelTools(");
    expect(registerIdx).toBeGreaterThan(0);
    const registerBlock = src.slice(registerIdx, registerIdx + 1200);
    expect(registerBlock).toMatch(/inputSchema:\s*strictPanelSchema\(d\.schema\)/);
    expect(registerBlock).not.toMatch(/inputSchema:\s*d\.schema[,\s]/);

    // createPanelMcpServer (Anthropic Agent SDK / Claude in-process transport).
    const createIdx = src.indexOf("export function createPanelMcpServer(");
    expect(createIdx).toBeGreaterThan(0);
    const createBlock = src.slice(createIdx, createIdx + 1800);
    expect(createBlock).toMatch(/strictPanelSchema\(d\.schema\)/);
  });
});
