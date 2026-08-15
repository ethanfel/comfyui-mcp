// PROBE for panel#971 — not a fix, and not intended to be merged as-is.
//
// Reporter's wedge: after Save-As, panel_set_workflow_target({mode:"current"})
// reports BOUND, panel_set_widget still fails [root-workflow-uuid-mismatch], and
// the prescribed recovery panel_open_workflow then refuses with
// "this session has no reachable panel tab yet".
//
// The question this probe answers, and nothing more: does the recovery the
// refusal MESSAGE names actually restore reachability for the command that
// refused? awaitReachable's own comment justifies returning early by asserting
// that "panel_set_workflow_target proceeds to its explicit last-active rebind",
// so if that rebind does not move ctx.tabId, the advice is a loop.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { __resetPanelBaseCache } from "../../services/panel-workspace.js";

const resetClient = vi.fn();
const resetObjectInfoCache = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: () => resetClient(),
  resetObjectInfoCache: () => resetObjectInfoCache(),
}));

const { buildPanelToolDefs, makePanelToolCtx, __panelToolsTestHooks } = await import(
  "../../orchestrator/panel-tools.js"
);
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import { markDispatched } from "../../services/ui-bridge.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

function reconnectingBridge(initial: string[] = []) {
  const live = new Set(initial);
  const headless = new Set<string>();
  const sent: Array<{ cmd: Record<string, unknown>; tabId?: string }> = [];
  const bridge = {
    send: async (cmd: Record<string, unknown>, opts?: { tabId?: string }) => {
      const id = opts?.tabId;
      if (id && !live.has(id)) {
        const connected = [...live].map((t) => `${t.slice(0, 8)} ("${t}")`).join(", ") || "none";
        throw markDispatched(new Error(`no connected tab with id "${id}". Connected: ${connected}`), false);
      }
      sent.push({ cmd, tabId: id });
      if (cmd.cmd === "workflow_list") {
        return { workflows: [...live].map((t) => ({ key: t, active: true })), active: { key: id } };
      }
      return { ok: true, routedTo: id };
    },
    push: () => 1,
    canReach: (id: string) => live.has(id),
    isHeadless: (id: string) => headless.has(id),
    tabs: () => [...live].map((t) => ({ tab_id: t, title: t, connected_at: 0 })),
    resolveActiveTabId: () => {
      if (live.size === 1) return [...live][0];
      if (live.size === 0) throw new Error("Panel not reachable: no panel connected");
      throw new Error("Multiple panel tabs are connected and none is last active — pass tab_id.");
    },
  } as unknown as PanelToolCtx["bridge"];
  return { bridge, live, headless, sent };
}

beforeEach(() => {
  __resetPanelBaseCache();
  __panelToolsTestHooks.setReconnectWaitTiming({ budgetMs: 300, intervalMs: 5 });
});
afterEach(() => {
  __panelToolsTestHooks.setReconnectWaitTiming(null);
});

it("#971 the last-active case works — this is the path the design documents", async () => {
  const { bridge } = reconnectingBridge(["tab-a", "tab-b"]);
  (bridge as unknown as { resolveActiveTabId: () => string }).resolveActiveTabId = () => "tab-b";
  const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
  expect(await ctx.awaitReachable!()).toBe(false);

  const target = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;
  const res = (await target.handler({ mode: "current" }, ctx)) as ToolResult;
  expect(res.isError).toBeFalsy();
  expect(ctx.tabId).toBe("tab-b"); // the rebind moved the session
  expect(await ctx.awaitReachable!()).toBe(true);

  const open = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow")!;
  expect(((await open.handler({ path: "demo.json" }, ctx)) as ToolResult).isError).toBeFalsy();
});

it("#971 with NO last-active tab, the prescribed recovery is a dead end", async () => {
  // Reporter's wedge. panel_open_workflow refuses and names
  // panel_set_workflow_target({mode:"current"}) as the way out; that tool then
  // fails with the bridge's raw "pass tab_id" — and the tool has NO tab_id
  // parameter, with #754 strict schemas making an unknown key a hard validation
  // error. The agent is told to pass something it cannot pass.
  const { bridge } = reconnectingBridge(["tab-a", "tab-b"]); // resolveActiveTabId throws
  const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());

  const open = buildPanelToolDefs().find((d) => d.name === "panel_open_workflow")!;
  const refusal = textOf((await open.handler({ path: "demo.json" }, ctx)) as ToolResult);
  expect(refusal).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);

  const target = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;
  const rec2 = (await target.handler({ mode: "current" }, ctx)) as ToolResult;

  // The tool has no tab_id to offer, so an error demanding one cannot be followed.
  expect(Object.keys(target.schema ?? {})).not.toContain("tab_id");
  expect(textOf(rec2)).not.toMatch(/pass tab_id/i);

  // And whatever it says, it must leave the caller somewhere other than where it
  // started: either rebound, or told an action that does not require a parameter
  // this tool does not have.
  const recovered = ctx.tabId !== "stale-tab" || /sent from its Agent panel/i.test(textOf(rec2));
  expect(recovered).toBe(true);
});

it("#971 a NON-ambiguity failure keeps its own words", async () => {
  // The guard's false-positive direction is invisible in the tests above: if
  // ambiguousRebindGuidance rewrote everything, they would still pass while every
  // unrelated rebind failure was replaced by advice about switching tabs.
  const { bridge } = reconnectingBridge(["tab-a", "tab-b"]);
  (bridge as unknown as { resolveActiveTabId: () => string }).resolveActiveTabId = () => {
    throw new Error("bridge exploded while resolving");
  };
  const ctx = makePanelToolCtx(bridge, "stale-tab", new WorkflowTargetStore());
  const target = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;
  const res = (await target.handler({ mode: "current" }, ctx)) as ToolResult;
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/bridge exploded while resolving/);
  expect(textOf(res)).not.toMatch(/Agent panel/);
});

it("#971 no recovery message tells the user to do something that does not work", async () => {
  // The mechanism, from ui-bridge.ts: setLastActiveTab is documented as the ONLY
  // writer of lastActiveTabId and is called on `msg.type === "user_message"`. A tab
  // becomes last-active when a MESSAGE IS SENT from its Agent panel. Focusing or
  // clicking the browser tab never touches it.
  //
  // Four messages in panel-tools.ts prescribe this recovery, and three of them said
  // "Switch to the tab you want" — an instruction that leaves the state exactly as it
  // was and sends the user around the loop again. This asserts on the SOURCE because
  // three of the four are on paths (mobile-client, panel_reload) this file cannot
  // reach, and a message that is wrong is wrong whether or not a test can drive it.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf8");

  const prescribes = src.split(/\r?\n/).filter((l) => /panel_set_workflow_target\(\{mode:"current"\}\)/.test(l));
  expect(prescribes.length).toBeGreaterThan(0);

  // No user-facing recovery TEXT may claim that switching/focusing a tab does it.
  // Comment lines are excluded deliberately: the doc comment on
  // ambiguousRebindGuidance quotes the wrong advice in order to explain why it is
  // wrong, and a gate that cannot tell an explanation from an instruction would
  // force that explanation to be deleted. Checked against a known site below.
  const codeLines = src
    .split(String.fromCharCode(10))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join(String.fromCharCode(10));
  expect(codeLines).not.toMatch(/Switch to (the|\(click\) the) (ComfyUI )?tab you want/i);
  // The filter must not be so aggressive that it would miss a real one: prove it
  // still sees ordinary string content on these same lines.
  expect(codeLines).toMatch(/panel_set_workflow_target/);
  // And the real mechanism must be stated wherever the recovery is prescribed.
  expect((src.match(/not focusing the tab/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect(src).toMatch(/sent from its Agent panel|send a message from the Agent panel/i);
});
