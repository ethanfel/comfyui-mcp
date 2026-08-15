// #1589 — `panel_strip_workflow`'s reply could not be parsed as JSON.
//
// The tool's whole purpose is to hand back a resolved graph, and it did — glued to
// the end of a summary sentence inside ONE text block:
//
//   Stripped to 12 nodes
//   Node types: 3× KSampler, …
//
//   { "1": { … } }
//
// so `JSON.parse(content[0].text)` died on the "S". Every programmatic caller had to
// find the first `{` and slice from there, which is not merely inconvenient — it is
// WRONG whenever a conversion note quotes a brace, and the notes name widget values,
// so they can. The "hostile" test below is that exact case.
//
// The fix keeps the prose ordering #361 chose (notes BEFORE the graph they apply to)
// and stops concatenating: block 0 is the summary, block 1 is the graph alone, and
// `structuredContent.graph` carries the parsed form for callers that read it.
//
// The protocol test at the bottom is the one that matters. A handler can return
// whatever it likes; whether `structuredContent` SURVIVES depends on the MCP SDK,
// which drops or rejects it under some declarations (a tool that declares an
// `outputSchema` and returns no structured half is a hard protocol error). So this
// asserts through a real McpServer + real Client over the SDK's own transport,
// registered by the same `registerPanelTools` production uses.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  // The live-canvas path must never reach this (#1359); it is mocked to throw so a
  // regression that reintroduces the COMFYUI_URL fetch fails loudly here too.
  getObjectInfo: async () => {
    throw new Error("COMFYUI_URL must not be consulted for a live-canvas strip");
  },
  backfillObjectInfo: async (bulk: unknown) => bulk,
  resetClient: () => {},
  resetObjectInfoCache: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { buildPanelToolDefs, makePanelToolCtx, registerPanelTools } = await import(
  "../../orchestrator/panel-tools.js"
);
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/**
 * A node type carrying a BRACE in its name. An unknown type is reported as a
 * conversion warning quoting the type, so this puts a `{` into the prose — ahead of
 * the graph — which is precisely what breaks a "slice from the first brace" caller.
 */
const BRACED_TYPE = 'Weird{"node"}Type';

const KSAMPLER_DEF = {
  input: { required: { seed: ["INT"], steps: ["INT"] } },
  output: [],
  name: "KSampler",
};

function liveNodes(includeBraced: boolean) {
  const nodes: Array<Record<string, unknown>> = [
    { id: 1, type: "KSampler", widgets_values: [7, 20], inputs: [], outputs: [] },
    { id: 2, type: "KSampler", widgets_values: [8, 25], inputs: [], outputs: [] },
  ];
  if (includeBraced) nodes.push({ id: 3, type: BRACED_TYPE, widgets_values: [], inputs: [], outputs: [] });
  return nodes;
}

function bridge(includeBraced: boolean) {
  const nodes = liveNodes(includeBraced);
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "graph_serialize" || cmd.cmd === "graph_get_state") {
        return { workflow: { nodes, links: [] }, nodes, links: [] };
      }
      if (cmd.cmd === "graph_get_object_info") {
        // Defines KSampler and NOT the braced type — the uninstalled-custom-node
        // case, which converts with a warning rather than refusing.
        return { ok: true, served_by: "http://127.0.0.1:8188", object_info: { KSampler: KSAMPLER_DEF } };
      }
      return { ok: true, workflow: { nodes: [], links: [] } };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabServerOrigin: () => "http://127.0.0.1:8188",
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

function ctxFor(includeBraced: boolean): PanelToolCtx {
  return makePanelToolCtx(bridge(includeBraced), TAB, new WorkflowTargetStore());
}

async function strip(includeBraced = false): Promise<ToolResult> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_strip_workflow");
  if (!def) throw new Error("panel_strip_workflow is not registered");
  return (await def.handler({}, ctxFor(includeBraced))) as ToolResult;
}

const textAt = (res: ToolResult, i: number): string => (res.content[i] as { text?: string }).text ?? "";

describe("panel_strip_workflow returns a graph a script can parse (#1589)", () => {
  it("puts the graph in its OWN block, which JSON.parse accepts as-is", async () => {
    const res = await strip();
    expect(res.content).toHaveLength(2);
    const graphText = textAt(res, 1);
    // No slicing, no trimming to a brace — the raw block text.
    const parsed = JSON.parse(graphText) as Record<string, { class_type?: string }>;
    expect(Object.keys(parsed)).toHaveLength(2);
    expect(parsed["1"]?.class_type).toBe("KSampler");
  });

  it("keeps the summary FIRST and free of the graph — the #361 ordering is unchanged", async () => {
    const res = await strip();
    const prose = textAt(res, 0);
    expect(prose).toMatch(/^Stripped to 2 nodes/);
    expect(prose).toContain("Node types: 2× KSampler");
    // The regression itself: the summary block must not carry the document.
    expect(prose).not.toContain("class_type");
    expect(prose).not.toContain(textAt(res, 1));
    // NOT "the prose contains no brace" — it does, and that is the point of the
    // hostile test below. The #959 widget-capture note this very fixture produces
    // ends by suggesting `panel_query_graph {fields:'detail'}`, so a real reply's
    // FIRST `{` has always been able to belong to the prose. Measured, not assumed.
    expect(prose).toContain("{");
  });

  it("carries the parsed graph as structuredContent.graph, matching the text block byte for byte", async () => {
    const res = await strip();
    expect(res.structuredContent).toBeDefined();
    const structured = res.structuredContent as { graph: unknown; node_count: number; node_types: unknown };
    expect(structured.graph).toEqual(JSON.parse(textAt(res, 1)));
    expect(structured.node_count).toBe(2);
    expect(structured.node_types).toEqual({ KSampler: 2 });
  });

  it("HOSTILE: a conversion note containing a brace no longer poisons the reply", async () => {
    // The case that makes "slice from the first `{`" wrong rather than merely ugly.
    // The old single-block reply put this warning BEFORE the graph, so the first
    // brace in the text belonged to the warning and the slice produced garbage.
    const res = await strip(true);
    const prose = textAt(res, 0);
    expect(prose).toContain(BRACED_TYPE);
    expect(prose).toContain("conversion note");
    // Prove the old heuristic really would have failed on this reply…
    const oldStyleSingleBlock = `${prose}\n\n${textAt(res, 1)}`;
    expect(() => JSON.parse(oldStyleSingleBlock.slice(oldStyleSingleBlock.indexOf("{")))).toThrow();
    // …while the block the tool actually returns parses.
    const parsed = JSON.parse(textAt(res, 1)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(2); // the braced type is unknown, so it is skipped
    expect((res.structuredContent as { warnings: string[] }).warnings.length).toBeGreaterThan(0);
  });
});

describe("WIRING: structuredContent survives the real MCP transport (#1589)", () => {
  it("a real Client sees structuredContent.graph on the tool result", async () => {
    // The reachability claim. `registerPanelTools` casts the handler result to the
    // SDK's type (`res as never`), so nothing in TypeScript proves the field is
    // forwarded — and the SDK's validateToolOutput is the layer that would reject
    // it if these tools ever declared an outputSchema. Assert it over the wire.
    const server = new McpServer({ name: "strip-structured-test", version: "1.0.0" });
    registerPanelTools(server, ctxFor(false));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "strip-structured-test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: "panel_strip_workflow", arguments: {} });
      expect(res.isError).toBeFalsy();
      const structured = res.structuredContent as { graph: Record<string, { class_type?: string }> } | undefined;
      expect(structured, "structuredContent did not survive the MCP round trip").toBeDefined();
      expect(structured?.graph?.["1"]?.class_type).toBe("KSampler");
      // …and the mirrored text block is still there for clients that ignore it.
      const blocks = res.content as Array<{ text?: string }>;
      expect(JSON.parse(blocks[1]?.text ?? "")).toEqual(structured?.graph);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("SOURCE: the handler returns structuredContent rather than concatenating the graph", () => {
    // A protocol test proves TODAY's build forwards the field. It cannot see a future
    // edit that puts the JSON back on the end of the summary string while leaving a
    // structuredContent that happens to still be produced elsewhere. Read the source,
    // bounded by the enclosing def(...) block rather than a character window.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../orchestrator/panel-tools.ts"),
      "utf8",
    );
    // Anchor on the NAME (line endings and indentation are not the claim), then walk
    // back to the `def(` that opens its registration.
    const nameAt = src.indexOf('"panel_strip_workflow",');
    expect(nameAt, "panel_strip_workflow is not registered by name any more").toBeGreaterThan(0);
    const start = src.lastIndexOf("def(", nameAt);
    expect(start, "no def( opens the panel_strip_workflow registration").toBeGreaterThan(0);
    // Walk to the matching close of this def( … ) call, so the slice is the tool's
    // own body and nothing of panel_flatten_workflow below it.
    const open = src.indexOf("(", start + 3);
    let depth = 0;
    let end = open;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = src.slice(start, end);
    // The slice must be THIS tool and only this tool: an unbalanced paren inside a
    // string would run the window on into the next def and make the negative
    // assertion below meaningless.
    expect(body, "the def( walk overran into the next tool").not.toContain('"panel_flatten_workflow",');
    expect(body).toContain("structuredContent");
    expect(body).toContain("graph: workflow");
    // The exact shape of the bug: the summary template ending in the serialized graph.
    expect(body).not.toMatch(/\+\s*`\\n\\n\$\{JSON\.stringify\(workflow/);
  });
});
