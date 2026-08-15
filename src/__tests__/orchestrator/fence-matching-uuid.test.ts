// #1401 — THE SAME UUID IS NOT THE SAME SITUATION.
//
// After a restart the panel answers `workflow_list` but marks its active record
// UNCONFIRMED. Corroboration refuses to adopt through that, and it is right to:
// a stale or mixed reply can carry ANOTHER canvas's perfectly valid uuid.
//
// What was wrong is the consequence asserted afterwards. The caller was told this
// session is "STILL fenced to the previous workflow instance and graph tools will
// keep failing", and sent to hard-refresh the tab — while the uuid the panel had
// just reported was the SAME one the session was already fenced to. The reporter's
// very next call was a panel_graph_outline that succeeded.
//
// So: the refusal does not move, nothing is adopted, and the fence is not written.
// Only the DIAGNOSIS splits, on evidence that was already in hand and discarded.

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const STALE = "11111111-1111-4111-8111-111111111111";
const LIVE = "22222222-2222-4222-8222-222222222222";

let listReplies: Array<Record<string, unknown>>;
let listCalls: number;
let stamp: string | undefined;
let adopted: string | undefined;

/** The reporter's shape: the panel answers, and says its own active record is NOT
 *  confirmed — the post-restart reconciliation window. */
function reconciling(uuid: string): Record<string, unknown> {
  const active = { path: "workflows/a.json", routing_key: TAB, workflow_uuid: uuid };
  return { active, workflows: [{ ...active, active: true }], active_confirmed: false };
}

function bridge() {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_list") {
        const n = listCalls;
        listCalls += 1;
        return listReplies[Math.min(n, listReplies.length - 1)];
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      adopted = uuid; // must never fire on any path below
      stamp = uuid;
      return true;
    },
    workflowUuidFor: () => ({ known: true, uuid: stamp }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function setCurrent(): Promise<{ res: ToolResult; text: string }> {
  const ctx = makePanelToolCtx(bridge(), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target");
  if (!def) throw new Error("panel_set_workflow_target is not registered");
  const res: ToolResult = await def.handler({ mode: "current" }, ctx);
  return { res, text: (res.content[0] as { text: string }).text };
}

beforeEach(() => {
  listCalls = 0;
  adopted = undefined;
});

describe("#1401 an uncorroborated uuid that MATCHES the fence", () => {
  beforeEach(() => {
    stamp = LIVE; // the session is already fenced to the canvas the panel names
    listReplies = [reconciling(LIVE)]; // never corroborates, however often re-read
  });

  it("does NOT claim graph tools will keep failing", async () => {
    // The false statement the reporter acted on. Their next call worked.
    const { text } = await setCurrent();
    expect(text).not.toContain("graph tools will keep failing");
  });

  it("says the fence was not re-derived, and names what that rules OUT", async () => {
    const { text } = await setCurrent();
    expect(text).toContain("NOT re-derived");
    expect(text).toContain(LIVE);
    expect(text).toContain("matches the fence this session already holds");
    expect(text).toContain("DIFFERENT workflow instance");
  });

  it("does NOT promise the graph tools work — that is what could not be confirmed", async () => {
    // codex review: a matching uuid rules OUT "fenced to another instance"; it does
    // not rule IN liveness, because a stale or background record can carry the right
    // uuid and still not be the canvas in front of the user. Claiming health here
    // would be the mirror image of the bug being fixed — turning "could not confirm"
    // into "is fine" instead of into "is broken".
    const { text } = await setCurrent();
    expect(text).toContain("NOT a claim that graph tools work");
    expect(text).not.toMatch(/likely to work|should work|will work/i);
  });

  it("prescribes a cheap probe FIRST, not a hard refresh", async () => {
    // A hard refresh throws away the user's canvas state; it must not be the
    // opening move for a case where the binding is probably fine.
    const { text } = await setCurrent();
    const probeAt = text.indexOf("panel_graph_outline");
    const refreshAt = text.search(/hard[- ]refresh|refresh the ComfyUI tab|F5/i);
    expect(probeAt, "the probe must be mentioned").toBeGreaterThan(-1);
    if (refreshAt > -1) expect(probeAt).toBeLessThan(refreshAt);
  });

  it("still ADOPTS NOTHING — the fail-closed rule does not move", async () => {
    await setCurrent();
    expect(adopted, "no uncorroborated identity may be written").toBeUndefined();
    expect(stamp).toBe(LIVE); // unchanged, because it already was LIVE
  });

  it("is still reported as a FAILURE, not as success", async () => {
    // Softening the DIAGNOSIS must not soften the RESULT: the rebind genuinely
    // did not happen, and the caller must still see an error rather than a
    // reassuring success. (The failure path answers as an error result, not the
    // JSON body the success path returns.)
    const { res, text } = await setCurrent();
    expect(res.isError).toBe(true);
    expect(text).toContain("did NOT restore this session's graph binding");
  });
});

describe("#1401 an uncorroborated uuid that DIFFERS keeps the hard wording", () => {
  // The over-broad direction. If this softened too, the fix would be hiding a
  // genuinely wedged session behind "probably fine" — worse than the bug.
  beforeEach(() => {
    stamp = STALE; // fenced to one canvas…
    listReplies = [reconciling(LIVE)]; // …while the panel names a different one
  });

  it("still says graph tools will keep failing", async () => {
    const { text } = await setCurrent();
    expect(text).toContain("graph tools will keep failing");
    expect(text).toContain(STALE);
  });

  it("still adopts nothing", async () => {
    await setCurrent();
    expect(adopted).toBeUndefined();
    expect(stamp).toBe(STALE);
  });
});

describe("#1401 a reply that names NO identity keeps the hard wording", () => {
  // Nothing to compare means nothing is known: absence of evidence must not be
  // rendered as the reassuring case.
  beforeEach(() => {
    stamp = STALE;
    const active = { path: "workflows/a.json", routing_key: TAB }; // no workflow_uuid
    listReplies = [{ active, workflows: [{ ...active, active: true }], active_confirmed: false }];
  });

  it("does not claim the fence still matches", async () => {
    const { text } = await setCurrent();
    expect(text).not.toContain("matches the fence this session already holds");
  });
});
