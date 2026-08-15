// #1337 — the fence-EXEMPT escape hatch could not clear the fence, and the session lost
// the canvas for the rest of the task.
//
// Every panel_* graph call refused with `workflow instance mismatch`. The documented
// recovery contract is that `workflow_open` is the one command the panel exempts, so it
// "re-derives this session's fence from its own reply". But it only does that on the
// SUCCESS branch, and the panel answered with this verdict, delivered as an error:
//
//   workflow_open RAN and the canvas IS bound to X — that much was proven — but the
//   graph on it does not match the state that was loaded … You are NOT on the wrong
//   workflow: X IS the active one.
//
// So control took the error branch, the fence was never re-derived, and the loop
// (mismatch → open → mismatch) ran three full cycles across two session resumes without
// ever self-clearing. The only remaining move was a browser reload, which destroys
// unsaved canvas work.
//
// TWO LEVELS WERE BEING CONFLATED. The verdict asserts IDENTITY was proven; what it
// withholds is CONTENT — the panel cannot tell frontend normalisation from a partial
// load. Content-level uncertainty was gating an identity-level fence.
//
// MEASURED, since the comment defending the old behaviour claims otherwise: the panel
// really does publish no workflow_uuid on this reply, so there is nothing to adopt from
// the reply — but `workflow_list` IS fence-exempt (commandIsCanvasTargetless), and the
// panel's own text names panel_list_workflows as the exempt recovery that "republishes
// the active identity". The fence could always be re-derived here; nothing tried.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const PATH = "workflows/a.json";
const LIVE = "77777777-7777-4777-8777-777777777777";

/** The reporter's verdict: identity PROVEN, content unknown, no fence refresh. */
const IDENTITY_PROVEN_DRIFT =
  `workflow_open RAN and the canvas IS bound to ${PATH} — that much was proven — but the graph ` +
  `on it does not match the state that was loaded, and the panel cannot tell whether the ComfyUI ` +
  `frontend merely normalized it (node sizes, widget values) or the load only partly applied. ` +
  `Treat the canvas as UNKNOWN and re-read it (panel_graph_outline) before editing. You are NOT ` +
  `on the wrong workflow: ${PATH} IS the active one. This reply carries NO fence refresh.`;

/** The other verdict class: identity itself unproven. Must NOT adopt. */
const IDENTITY_UNPROVEN =
  `workflow_open RAN but could not prove that the active canvas was rebound to ${PATH}, so treat ` +
  `the canvas as unknown rather than unchanged. The panel could not confirm which workflow is ` +
  `active, so the open may have left a different one active.`;

/** `listUuid: null` → the exempt workflow_list read establishes nothing.
 *  `"throw"` → it fails outright. */
function bridge(openVerdict: string, listUuid: string | null | "throw") {
  const calls: string[] = [];
  let stamp: string | undefined;
  const b = {
    send: async (cmd: Record<string, unknown>) => {
      calls.push(String(cmd.cmd));
      if (cmd.cmd === "workflow_list") {
        if (listUuid === "throw") throw new Error("panel did not answer");
        const active = {
          path: PATH,
          routing_key: TAB,
          ...(listUuid ? { workflow_uuid: listUuid } : {}),
        };
        return { active, workflows: [{ ...active, active: true }], active_confirmed: true };
      }
      if (cmd.cmd === "workflow_open") throw new Error(openVerdict);
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_t: string, uuid: string) => {
      calls.push(`adopt:${uuid}`);
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: Boolean(stamp), uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  return { b, calls };
}

async function openWorkflow(openVerdict: string, listUuid: string | null | "throw") {
  const { b, calls } = bridge(openVerdict, listUuid);
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow");
  if (!def) throw new Error("panel_open_workflow is not registered");
  const res: ToolResult = await def.handler({ path: PATH } as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
  };
}

describe("workflow_open clears the fence on the identity-PROVEN verdict (#1337)", () => {
  it("the reporter's wedge: the fence is re-derived via the exempt read", async () => {
    const { text, calls } = await openWorkflow(IDENTITY_PROVEN_DRIFT, LIVE);

    // The exempt read actually happened — the whole fix is that round trip.
    expect(calls).toContain("workflow_list");
    expect(text).toMatch(/FENCE: CLEARED/);
    expect(text).toContain(LIVE);
    // The thing that ends the wedge: no reload, so unsaved work survives.
    expect(text).toMatch(/do NOT need to reload the browser tab/i);
    expect(text).toMatch(/no unsaved canvas work is at risk/i);
  });

  it("the CONTENT warning is preserved verbatim — the open still fails", async () => {
    // Clearing the fence does not make the graph known. "Re-read before editing" is
    // still the right instruction, and the call is still an error.
    const { text, isError } = await openWorkflow(IDENTITY_PROVEN_DRIFT, LIVE);

    expect(isError).toBe(true);
    expect(text).toMatch(/Treat the canvas as UNKNOWN and re-read it/);
    expect(text).toMatch(/content warning above still stands/i);
  });

  it("the UNPROVEN verdict adopts NOTHING — identity itself is in doubt", async () => {
    // The direction that would be dangerous. Re-deriving a fence onto a canvas the
    // panel cannot identify is how an edit lands on the wrong graph, which is the
    // entire reason the fence exists.
    const { text, calls } = await openWorkflow(IDENTITY_UNPROVEN, LIVE);

    expect(text).not.toMatch(/FENCE: CLEARED/);
    expect(text).not.toMatch(/FENCE:/);
    // ADOPTION is the thing that must not happen. A workflow_list read still occurs on
    // this path — `observeActiveAfterOpen` performs one to check for drift, and that
    // predates this change — so asserting the read never happens would pin the wrong
    // property and pass for the wrong reason.
    expect(calls.some((c) => c.startsWith("adopt:"))).toBe(false);
  });

  it("an exempt read that establishes nothing says the fence is NOT cleared", async () => {
    // No identity on the active record — promising a cleared fence here would send the
    // caller straight back into the loop this issue is about.
    const { text } = await openWorkflow(IDENTITY_PROVEN_DRIFT, null);

    expect(text).toMatch(/FENCE: NOT cleared/);
    expect(text).toMatch(/Graph commands stay refused/);
    expect(text).not.toMatch(/FENCE: CLEARED/);
  });

  it("a THROWN exempt read reports the fence state as unknown, not cleared", async () => {
    const { text } = await openWorkflow(IDENTITY_PROVEN_DRIFT, "throw");

    expect(text).toMatch(/FENCE: NOT cleared/);
    expect(text).toMatch(/UNKNOWN/);
    expect(text).not.toMatch(/FENCE: CLEARED/);
  });
});
