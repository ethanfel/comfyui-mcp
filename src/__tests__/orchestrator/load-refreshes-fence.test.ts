// #1478 — an API-format load re-mints the workflow instance, and the fence is left stale.
//
// The reporter loaded a workflow, then had a READ-ONLY `panel_get_errors` refused for
// "workflow instance mismatch". Every later panel_* call was fenced against a uuid that the
// load itself had invalidated.
//
// `panel_load_workflow` already DETECTS this precisely: the panel's API path re-mints
// (`app.loadApiJson` passes no keep-instance option) while the UI path deliberately
// preserves the instance, and the reply carries `format:"api"` only on the re-minting
// branch. Having detected it, the tool appends a note saying the fence is now stale — and
// leaves it stale.
//
// It no longer has to. Panel 0.14.39+ publishes `workflow_uuid` on the graph_load reply
// (comfyui-mcp-panel#1225), which is the same race-proof shape `refreshFenceFromOwnReply`
// already trusts for workflow_save / workflow_save_as / workflow_new (#1161): the uuid is
// read from the command's OWN reply, never re-derived from "whatever is active now" — a
// re-derivation this project has rejected as a P1 more than once, because the active
// workflow can move during the await.
//
// So the fix is to adopt the uuid the load itself proved, and keep the warning for the case
// where nothing was published.
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

// WORKFLOW_UUID_RE requires a [1-5] version nibble and an [89ab] variant nibble — an
// arbitrary placeholder is rejected, which would make a positive test pass for the wrong
// reason.
const LOADED_UUID = "11111111-2222-4333-8444-555555555555";
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";

let fence: string | undefined;
let stamps: string[];

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/** A bridge whose graph_load answers with `reply`. */
function bridgeFor(reply: Record<string, unknown>) {
  return {
    send: async (c: Record<string, unknown>) => {
      if (c.cmd === "graph_load") return reply;
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
    workflowUuidFor: () => ({ known: true, uuid: fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      fence = uuid;
      stamps.push(uuid);
      return true;
    },
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

const ctxWith = (b: ReturnType<typeof bridgeFor>): PanelToolCtx => makePanelToolCtx(b, "tab-1");
const loadTool = () => buildPanelToolDefs().find((d) => d.name === "panel_load_workflow")!;
const API_GRAPH = { last_node_id: 1, nodes: [], links: [] };

beforeEach(() => {
  stamps = [];
  fence = PRIOR_UUID; // the fence the load is about to invalidate
});

describe("an API-format load adopts the uuid it proved (#1478)", () => {
  it("REFRESHES the fence from the load's own reply", async () => {
    // The reported case. The load re-mints, the reply says which instance it produced, and
    // the session should be fenced to THAT — not left pointing at the workflow it replaced.
    const res = await loadTool().handler(
      { graph: API_GRAPH },
      ctxWith(bridgeFor({ loaded: true, format: "api", workflow_uuid: LOADED_UUID })),
    );

    expect(res.isError).toBeFalsy();
    expect(fence, "the session must be fenced to the instance the load produced").toBe(
      LOADED_UUID,
    );
    expect(stamps).toEqual([LOADED_UUID]);
  });

  it("stops telling the caller the fence is stale once it has been refreshed", async () => {
    // Warning about a staleness we just repaired sends the user to fix something that is
    // already fixed — and the remedy it names costs them a tool call.
    const res = await loadTool().handler(
      { graph: API_GRAPH },
      ctxWith(bridgeFor({ loaded: true, format: "api", workflow_uuid: LOADED_UUID })),
    );
    expect(textOf(res)).not.toMatch(/re-mint/i);
  });

  it("KEEPS the warning when the reply publishes no uuid (older panel)", async () => {
    // Panels before 0.14.39 do not publish it. Nothing can be adopted, the fence really is
    // stale, and withdrawing the warning there would leave the reporter's exact bug silent.
    const res = await loadTool().handler(
      { graph: API_GRAPH },
      ctxWith(bridgeFor({ loaded: true, format: "api" })),
    );
    expect(fence, "nothing was published, so nothing may be adopted").toBe(PRIOR_UUID);
    expect(stamps).toEqual([]);
    expect(textOf(res)).toMatch(/re-mint/i);
  });

  it("does NOT touch the fence on a UI-format load", async () => {
    // The UI path passes __cmcpKeepInstance and deliberately PRESERVES the instance, so the
    // fence is still correct. Re-stamping it would be a write with no event behind it.
    const res = await loadTool().handler(
      { graph: API_GRAPH },
      ctxWith(bridgeFor({ loaded: true, format: "ui", workflow_uuid: LOADED_UUID })),
    );
    expect(res.isError).toBeFalsy();
    expect(fence).toBe(PRIOR_UUID);
    expect(stamps).toEqual([]);
  });

  it("does NOT touch the fence when the load reports it did not happen", async () => {
    // `loaded:false` in a non-error envelope replaced nothing. Adopting a uuid from a load
    // that did not occur is the fabricated-consequence defect the existing note guards.
    await loadTool().handler(
      { graph: API_GRAPH },
      ctxWith(bridgeFor({ loaded: false, format: "api", workflow_uuid: LOADED_UUID })),
    );
    expect(fence).toBe(PRIOR_UUID);
    expect(stamps).toEqual([]);
  });

  it("does NOT adopt a malformed uuid", async () => {
    // The stamp gates future mutations. A value that is not a canonical instance uuid must
    // not become the fence — better to keep the stale one and warn than to fence against
    // something no canvas will ever report.
    const res = await loadTool().handler(
      { graph: API_GRAPH },
      ctxWith(bridgeFor({ loaded: true, format: "api", workflow_uuid: "not-a-uuid" })),
    );
    expect(fence).toBe(PRIOR_UUID);
    expect(stamps).toEqual([]);
    expect(textOf(res)).toMatch(/re-mint/i);
  });
});
