// #971 (panel) — the recovery told the caller to do the thing that had just
// failed, using the thing that was missing.
//
// The reporter's trace is a loop:
//
//   1. panel_set_workflow_target(mode:"current")  -> reports `bound`
//   2. panel_set_widget                           -> [root-workflow-uuid-mismatch]
//   3. the prescribed recovery, panel_open_workflow
//        -> "no reachable panel tab yet … or rebind with
//            panel_set_workflow_target({mode:'current'})"
//   4. which is step 1 — and whose only probe is a `workflow_list` call TO A TAB,
//      so it needs exactly what step 3 just said is missing.
//
// The message folded two causes into one remedy, and they want different advice:
//
//   nothing connected       -> a rebind DEFERS (it clears the stale binding and
//                              takes effect on the first tab that reconnects), so
//                              it does not make this retryable now
//   connected, none is ours -> a rebind is precisely right: it re-points the
//                              session at the live tab
//
// The bridge can tell them apart, so the remedy now matches the cause. What the
// zero-tab branch says was MEASURED against the real handler, not reasoned — see
// the first test.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** A bridge that reports `tabs` but never becomes reachable, which is the state
 *  `awaitReachable` gives up on. */
function bridgeWith(tabs: Array<{ tab_id: string; headless?: boolean }>) {
  return {
    send: async () => ({ ok: true }),
    push: () => 1,
    canReach: () => false,
    isHeadless: (id: string) => tabs.find((t) => t.tab_id === id)?.headless === true,
    tabs: () => tabs.map((t) => ({ tab_id: t.tab_id, title: "wf", connected_at: 0 })),
    resolveActiveTabId: () => tabs[0]?.tab_id ?? TAB,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function openWorkflow(bridge: PanelToolCtx["bridge"]): Promise<string> {
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  // The pre-send reachability wait is what produces this failure; make it give up
  // immediately rather than waiting out the real budget.
  (ctx as { awaitReachable?: () => Promise<boolean> }).awaitReachable = async () => false;
  const def = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow");
  if (!def) throw new Error("panel_open_workflow is not registered");
  const res: ToolResult = await def.handler({ path: "workflows/b.json" }, ctx);
  return (res.content[0] as { text: string }).text;
}

describe("the no-reachable-tab remedy matches its cause (#971)", () => {
  it("NOTHING connected: says the rebind DEFERS rather than repairs", async () => {
    // MEASURED, and it corrected me. My first version of this asserted the
    // rebind "cannot help" with zero tabs. Probed against the real handler: it
    // returns `deferred: true`, CLEARS the stale binding, and arms a bind onto
    // the first tab that reconnects. So it is worth doing — it simply does not
    // make the command retryable now, which is what the caller is asking. The
    // loop the reporter hit comes from not saying which of those it does.
    const text = await openWorkflow(bridgeWith([]));

    expect(text).toMatch(/NO panel tab is connected at all/);
    expect(text).toMatch(/will NOT make this retryable yet/);
    expect(text).toMatch(/clears the stale binding and DEFERS/);
    // …and it names what actually brings a tab back.
    expect(text).toMatch(/Wait for the reconnect|open\/refresh the ComfyUI browser tab/);
    // The false claim must not come back.
    expect(text).not.toMatch(/CANNOT help/);
  });

  it("CONNECTED but not ours: the rebind IS the right move, and is offered", async () => {
    // The other half of the old sentence, and here the advice is correct: there
    // is a live tab to re-point the session at.
    const text = await openWorkflow(bridgeWith([{ tab_id: "wf:workflows/other.json" }]));

    expect(text).toMatch(/1 panel tab\(s\) are connected/);
    expect(text).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);
    expect(text).not.toMatch(/will NOT make this retryable yet/);
  });

  it("headless tabs do not count as something to rebind onto", async () => {
    // A headless tab is not a panel a user is looking at; counting it would give
    // the "rebind onto the live one" advice when there is no live one.
    const text = await openWorkflow(bridgeWith([{ tab_id: "hl:1", headless: true }]));
    expect(text).toMatch(/NO panel tab is connected at all/);
  });

  it("an unreadable bridge keeps the old, cause-neutral wording", async () => {
    // Fail toward what was there before rather than guessing which cause it is:
    // asserting either one would be a claim we cannot support.
    const blind = {
      ...(bridgeWith([]) as object),
      tabs: () => {
        throw new Error("bridge is not enumerable here");
      },
    } as unknown as PanelToolCtx["bridge"];
    const text = await openWorkflow(blind);

    expect(text).toMatch(/no reachable panel tab yet/);
    expect(text).not.toMatch(/NO panel tab is connected at all/);
    expect(text).not.toMatch(/are connected/);
  });

  it("every branch still says NOTHING WAS SENT — that fact must not move", async () => {
    // The pre-send wait exists so a mutating command is not fired into a dead
    // binding. A caller that cannot tell whether it was sent retries blindly,
    // which is the double-apply this guard prevents.
    for (const bridge of [bridgeWith([]), bridgeWith([{ tab_id: "wf:other" }])]) {
      expect(await openWorkflow(bridge)).toMatch(/Nothing was\s+sent/);
    }
  });
});
