// #1331 — the remedy for "no trusted identity" was right for one state and wrong for
// the other, and only one of them was ever printed.
//
// The reporter built a workflow in-session (new → paste → rename → save), survived a
// ComfyUI reconnect, and then every MUTATING panel_* call was refused:
//
//   "graph_set_widget" cannot be safely targeted to the active workflow: this workflow
//   has no trusted identity for the panel to fence the command against.
//
// wrapped with "Retry in a moment, or rebind with
// panel_set_workflow_target({mode:"current"})". They followed it. It did not work.
// Recovery took panel_open_workflow on the workflow that was ALREADY active — four
// calls to reach a state the panel already believed it was in.
//
// TWO STATES, ONE MESSAGE. The bridge cannot tell them apart; from its side both are
// "no identity":
//
//   session bound to a STALE tab, live canvas HAS an identity
//        → the rebind re-resolves it. Retry/rebind is CORRECT (#709).
//   the LIVE canvas itself has none
//        → the rebind READS an identity to adopt and finds none, so it reports success
//          while every mutation keeps failing. Only re-opening mints one.
//
// The orchestrator can tell them apart, with the same read-only re-derivation the
// documented recovery performs. So it measures once and names the remedy that fits.
//
// This is deliberately NOT a blanket replacement. My first attempt deleted the
// retry/rebind advice outright and #709's own test caught it — that advice is correct
// in its state, and removing it would have broken a working recovery to fix a broken
// one.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { markDispatched } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/niji_holo_impasto.json";
const LIVE_UUID = "55555555-5555-4555-8555-555555555555";

const identityRefusal = () =>
  markDispatched(
    new Error(
      `"graph_set_widget" cannot be safely targeted to the active workflow: this workflow has ` +
        `no trusted identity for the panel to fence the command against. Reads and view-only ` +
        `commands still work (graph_outline, graph_query, graph_get_state).`,
    ),
    false,
  );

/** `activeUuid: null` is #1331 — the live canvas has no identity either.
 *  `"throw"` is the unreadable case: the re-read itself fails. */
function bridge(activeUuid: string | null | "throw") {
  let listCalls = 0;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        listCalls += 1;
        if (activeUuid === "throw") throw new Error("panel did not answer");
        const active = {
          path: "workflows/niji_holo_impasto.json",
          routing_key: TAB,
          // The #1331 shape: a real saved path, and NO workflow_uuid on the record.
          ...(activeUuid ? { workflow_uuid: activeUuid } : {}),
        };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      throw identityRefusal();
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, reads: () => listCalls };
}

async function setWidget(activeUuid: string | null | "throw"): Promise<{ text: string; reads: number }> {
  const { b, reads } = bridge(activeUuid);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler({ node_id: 7, widget: "steps", value: 20 } as never, ctx);
  return { text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "), reads: reads() };
}

describe("a no-trusted-identity refusal names the remedy that fits (#1331)", () => {
  it("LIVE CANVAS HAS NONE: says the rebind cannot help, and names what can", async () => {
    const { text, reads } = await setWidget(null);

    // The re-derivation really ran — otherwise every assertion below could be satisfied
    // by a message that consulted nothing.
    expect(reads).toBeGreaterThan(0);

    expect(text).toMatch(/CHECKED, so this is not a guess/);
    expect(text).toMatch(/will NOT clear this/);
    expect(text).toMatch(/cannot mint an identity for one that has none/);
    // The remedy the reporter had to find by hand.
    expect(text).toMatch(/panel_open_workflow\(<path>\)/);
    // …and the case where there is no path to re-open.
    expect(text).toMatch(/panel_save_workflow/);
    // The cause is never replaced, only explained.
    expect(text).toMatch(/no trusted identity/);
  });

  it("LIVE CANVAS HAS ONE: the rebind is the right move and is performed, not prescribed", async () => {
    // #709's state. The advice that was wrong for #1331 is right here — and rather than
    // telling the caller to run the rebind, the orchestrator has already run it.
    const { text, reads } = await setWidget(LIVE_UUID);

    expect(reads).toBeGreaterThan(0);
    expect(text).toMatch(/CHECKED: the live canvas DOES carry an identity/);
    expect(text).toContain(LIVE_UUID);
    expect(text).toMatch(/RETRY THIS EXACT CALL ONCE/);
    // It must NOT send them re-opening a workflow that is perfectly fine.
    expect(text).not.toMatch(/panel_open_workflow\(<path>\)/);
  });

  it("UNREADABLE: refuses to pick a side, and names the recovery that works either way", async () => {
    // The failure direction that matters. Asserting either state here would be a claim
    // nothing supports — and half the time it would send the caller down the exact path
    // that cost the reporter four calls.
    const { text } = await setWidget("throw");

    expect(text).toMatch(/the answer is UNKNOWN/);
    expect(text).toMatch(/works in BOTH states/);
    expect(text).not.toMatch(/CHECKED, so this is not a guess/);
    expect(text).not.toMatch(/DOES carry an identity/);
  });

  it("every branch still REFUSES — nothing is applied, in any state", async () => {
    // The fence exists so a mutation cannot land on an unidentified graph. Explaining
    // the refusal better must never turn into letting one through.
    for (const state of [null, LIVE_UUID, "throw"] as const) {
      const { text } = await setWidget(state);
      expect(text).toMatch(/^Error:/);
    }
  });
});
