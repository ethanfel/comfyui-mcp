// #1329 — the refusal already knew the answer, and billed the caller for it.
//
// The reporter uploaded two images and both `panel_add_node("LoadImage")` calls were
// refused:
//
//   "LoadImage" required input "image" was added or retyped since this page loaded its
//   node schema, so creating it now would build the OLD shape. Call panel_refresh_nodes
//   and retry.
//
// They called panel_refresh_nodes and retried, and it worked — both times. That is an
// agent-visible error plus two extra calls for something with exactly one correct
// response and no decision in it.
//
// WHY AUTOMATING THIS IS SAFE, and why the same reasoning does NOT license retrying
// mutations generally: the panel's guard throws BEFORE it creates anything ("Refuse
// before creating anything" — comfyui-mcp-panel.js), so the retry cannot leave two
// nodes on the canvas. A transport failure is the opposite case — the outcome is
// unknown, which is exactly why those are never re-issued on our own initiative.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

const STALE = () =>
  new Error(
    `"LoadImage" required input "image" was added or retyped since this page loaded its node ` +
      `schema, so creating it now would build the OLD shape. Call panel_refresh_nodes and retry.`,
  );

/**
 * `addOutcomes` is consumed one per graph_add_node call: "stale" throws the refusal,
 * "ok" succeeds. `refreshFails` makes refresh_nodes throw.
 */
function bridge(addOutcomes: Array<"stale" | "ok">, refreshFails = false) {
  const calls: string[] = [];
  let addIdx = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "refresh_nodes") {
        if (refreshFails) throw new Error("panel did not answer the refresh");
        return { refreshed: true };
      }
      if (cmd.cmd === "graph_add_node") {
        const outcome = addOutcomes[Math.min(addIdx, addOutcomes.length - 1)];
        addIdx += 1;
        if (outcome === "stale") throw STALE();
        return { ok: true, node_id: 42 };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function addNode(addOutcomes: Array<"stale" | "ok">, refreshFails = false) {
  const { b, calls } = bridge(addOutcomes, refreshFails);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
  if (!def) throw new Error("panel_add_node is not registered");
  const res: ToolResult = await def.handler({ class_type: "LoadImage" } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("a stale node schema is refreshed and retried once (#1329)", () => {
  it("the reporter's case: refuse → refresh → add, with no error surfaced", async () => {
    const { text, isError, calls } = await addNode(["stale", "ok"]);

    expect(isError).toBe(false);
    expect(calls).toEqual(["graph_add_node", "refresh_nodes", "graph_add_node"]);
    // The refusal never reaches the caller — it was actionable, and it was acted on.
    expect(text).not.toMatch(/added or retyped since this page loaded/);
  });

  it("EXACTLY once — a still-stale schema is not retried forever", async () => {
    const { isError, calls } = await addNode(["stale", "stale"]);

    expect(isError).toBe(true);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(2);
    expect(calls.filter((c) => c === "refresh_nodes")).toHaveLength(1);
  });

  it("…and when it is still stale, says the prescribed remedy will not clear it", async () => {
    // The caller must not follow the refusal's own advice into a loop we already ran.
    const { text } = await addNode(["stale", "stale"]);

    expect(text).toMatch(/already retried ONCE automatically/);
    expect(text).toMatch(/repeating panel_refresh_nodes will not clear it/);
    expect(text).toMatch(/Reload the ComfyUI browser tab/);
  });

  it("a FAILED refresh keeps the original refusal and discloses the attempt", async () => {
    // The schema refusal is the better error — it names what is wrong and what fixes
    // it. The refresh failure rides alongside so the caller is not left wondering
    // whether the automatic attempt happened.
    const { text, isError, calls } = await addNode(["stale", "ok"], true);

    expect(isError).toBe(true);
    expect(text).toMatch(/added or retyped since this page loaded/); // preserved verbatim
    expect(text).toMatch(/panel_refresh_nodes was dispatched and FAILED/);
    // The add is NOT retried after a failed refresh — the schema is unchanged.
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(1);
  });

  it("a healthy add is untouched — one call, no refresh", async () => {
    const { isError, calls } = await addNode(["ok"]);

    expect(isError).toBe(false);
    expect(calls).toEqual(["graph_add_node"]);
  });

  it("an UNRELATED failure is never retried", async () => {
    // The guard keys on the drift sentence, not on the word panel_refresh_nodes, which
    // appears in several other remedies. Keying on the recommendation would make any of
    // them trigger a second mutating add.
    const { b, calls } = bridge(["ok"]);
    const bridgeThatFails = {
      ...(b as object),
      send: async (cmd: Record<string, unknown>) => {
        calls.push(String(cmd.cmd));
        throw new Error(
          "something else went wrong entirely. Call panel_refresh_nodes and retry.",
        );
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridgeThatFails, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_add_node");
    if (!def) throw new Error("panel_add_node is not registered");
    const res = await def.handler({ class_type: "LoadImage" } as never, ctx);

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c === "graph_add_node")).toHaveLength(1);
    expect(calls).not.toContain("refresh_nodes");
  });
});
