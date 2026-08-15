// #1468 — a command that was APPLIED came back as `isError:true` because its ack
// missed a bound tighter than this codebase's own default. The reporter proved the
// effect landed both times: `civitai_search` timed out at 10 s while `renderRev`
// had advanced and the grid reported `loading:true`, and `graph_exit_subgraph`
// timed out at 15 s while the very next `panel_graph_outline` showed scope `root`.
//
// The mechanism first published on that issue — "coupled to a slow external
// operation" — is WRONG, and this file exists partly so nobody restores it:
//
//   - `driveSearch` does NOT await the CivitAI fetch. It fires `void reload(...)`
//     and returns `{dispatched:true, renderRev}` with no await in the handler.
//     That is panel #282, shipped at panel 0.11.0; #1468 was filed from 0.11.44.
//   - `graph_exit_subgraph`'s own receipt (`confirmCanvasNavigation`) budgets
//     25 polls x 40 ms ~= 1 s and returns early on success — 15 s already clears
//     its worst case by 15x.
//
// With nothing external left to wait on, both are the #357/#694 shape: a
// busy-but-alive main thread missing a tight bound. So `civitai_search` takes the
// shared default, and `exit_subgraph` — whose effect is locally observable — asks
// rather than guessing.
//
// The timeout strings asserted below were MEASURED against a real UiBridge and a
// live-but-frozen tab, not written from the source template: `graph_exit_subgraph`
// reaches dispatch (it is fence-inert, #778) and produces the canonical
// `did not reply to "graph_exit_subgraph" within N ms` + the mutating-delivery
// disclosure. A graph_* command that the #570 write gate refuses PRE-dispatch
// would never take this path at all, and asserting against that refusal is how a
// suite goes green while proving nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { BRIDGE_DEFAULT_TIMEOUT_MS, markReplyTimeout } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";
/** A second live tab, which the session silently rebinds onto if TAB vanishes. */
const OTHER_TAB = "99999999-8888-7777-6666-555555555555";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");

/** The bridge's canonical no-reply for a MUTATING command, verbatim from a live
 *  UiBridge against a frozen tab. `ctx.call` surfaces it as `Error: ` + this. */
const ackTimeout = (cmd: string, ms: number): Error =>
  new Error(
    `Panel tab ${TAB} did not reply to "${cmd}" within ${ms} ms — the ComfyUI tab may be ` +
      `backgrounded or frozen. This command MUTATES and was already delivered to the tab, so it ` +
      `may have been applied despite the missing reply — check the current state before ` +
      `re-issuing it; a blind retry can apply it twice`,
  );

let sent: { cmd: string; timeoutMs?: number }[] = [];

/**
 * `exitReply` decides what `graph_exit_subgraph` does: "timeout" is the reported
 * bug; "acked-error" is a GENUINE executor failure the panel relayed. `probeScope`
 * decides what the settling read finds afterwards.
 */
function bridge(opts: {
  exitReply?: "timeout" | "acked-error" | "acked-error-timeout-worded";
  probeScope?: "root" | "subgraph" | "timeout";
  probeTitle?: string;
  /** The dispatch tab vanishes after the exit, so ctx.call silently rebinds. */
  loseTabAfterExit?: boolean;
}) {
  let tabGone = false;
  return {
    send: async (
      cmd: Record<string, unknown>,
      o?: { timeoutMs?: number; onDispatchedRid?: (rid: string) => void },
    ) => {
      sent.push({ cmd: String(cmd.cmd), timeoutMs: o?.timeoutMs });
      if (cmd.cmd === "graph_exit_subgraph") {
        if (opts.exitReply === "acked-error") {
          // The panel's OWN verdict, which already reasoned about this exact
          // uncertainty (#619) and prescribes a scope read as the next step.
          throw new Error(
            "panel_exit_subgraph could not confirm that the canvas returned to the parent " +
              "graph: no observation ever saw the canvas there.",
          );
        }
        if (opts.exitReply === "acked-error-timeout-worded") {
          // codex round 2's exact case, and the reason text was abandoned as the
          // discriminator: an ACKED executor error carrying the bridge's WHOLE
          // canonical sentence verbatim, then continuing. ACKed panel errors enter
          // as arbitrary `msg.error` text, so any sentence the bridge can write, a
          // panel error can also contain — no regex separates these two. It is NOT
          // markReplyTimeout-tagged, which is the difference that actually exists.
          throw new Error(
            `Panel tab ${TAB} did not reply to "graph_exit_subgraph" within 15000 ms — the ` +
              `ComfyUI tab may be backgrounded or frozen. Reported by the subgraph owner walk: ` +
              `nothing was applied.`,
          );
        }
        if (opts.loseTabAfterExit) tabGone = true;
        // Reproduce the PRODUCTION shape, not a simplified one. graph_exit_subgraph
        // is in RETRY_TOKEN_CMDS, so a *tagged* reply-timeout on a dispatched rid
        // makes ctx.call append its `retry_of` instruction to the message. A
        // fixture that skipped this would have hidden the defect this file now
        // pins: a "do not retry" note landing directly under "to retry, re-issue
        // with retry_of".
        o?.onDispatchedRid?.("rid-original-1468");
        throw markReplyTimeout(ackTimeout("graph_exit_subgraph", 15000));
      }
      if (cmd.cmd === "graph_query") {
        if (opts.probeScope === "timeout") throw ackTimeout("graph_query", 8000);
        return opts.probeScope === "subgraph"
          ? {
              viewing: { scope: "subgraph", owner_node_id: 7, title: opts.probeTitle ?? "Upscale" },
              total: 1,
            }
          : { viewing: { scope: "root" }, total: 1 };
      }
      if (cmd.cmd === "civitai_search") {
        return { tab: "models", query: "flux", creator: null, renderRev: 4, dispatched: true };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: (id: string) => (tabGone ? id === OTHER_TAB : id === TAB),
    isHeadless: () => false,
    tabs: () =>
      tabGone
        ? [{ tab_id: OTHER_TAB, title: "other", connected_at: 0 }]
        : [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => (tabGone ? OTHER_TAB : TAB),
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  opts: Parameters<typeof bridge>[0],
): Promise<{ text: string; isError: boolean; boundTab: string }> {
  const ctx = makePanelToolCtx(bridge(opts), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  const res: ToolResult = await def.handler(args as never, ctx);
  // The tab the session ENDED on. Exposed so the rebind case can assert the race
  // it guards actually occurred, rather than inferring it from the verdict — a
  // rebind that silently failed to happen would leave that test green while
  // exercising nothing.
  return { text: textOf(res), isError: res.isError === true, boundTab: ctx.tabId };
}

beforeEach(() => {
  sent = [];
});

describe("an unacknowledged exit is settled by a read, not by a guess (#1468)", () => {
  it("reports the exit as done when the read finds the canvas at ROOT", async () => {
    const out = await runTool("panel_exit_subgraph", {}, { probeScope: "root" });

    // The probe really ran — without this the assertions could pass on a branch
    // that merely stopped failing, which is a claim rather than a measurement.
    expect(sent.map((s) => s.cmd)).toContain("graph_query");

    expect(out.isError).toBe(false);
    expect(out.text).toMatch(/CHECKED FOR YOU/);
    expect(out.text).toMatch(/canvas at the ROOT graph/);
    expect(out.text).toMatch(/No recovery step is needed/);
    // The distinction the whole issue is about: a missing ack is not a failure.
    expect(out.text).toMatch(/not evidence the navigation failed/);
  });

  it("does NOT claim failure when the read finds a subgraph — that is ambiguous", async () => {
    // exit pops to the IMMEDIATE PARENT (#412), so "inside a subgraph" is equally
    // consistent with "never landed" and with "landed, from a NESTED subgraph".
    // Calling this a failure and prescribing a retry would pop a level the caller
    // wanted to keep — the same harm as the false failure, pointed the other way.
    const out = await runTool(
      "panel_exit_subgraph",
      {},
      { probeScope: "subgraph", probeTitle: "Refiner" },
    );

    expect(sent.map((s) => s.cmd)).toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/does NOT settle it/);
    expect(out.text).toMatch(/Refiner/);
    expect(out.text).toMatch(/IMMEDIATE PARENT/);
    // It must not resolve the ambiguity in EITHER direction.
    expect(out.text).not.toMatch(/canvas at the ROOT graph/);
    expect(out.text).not.toMatch(/No recovery step is needed/);
  });

  it("does not contradict the retry_of instruction it is appended beneath", async () => {
    // ctx.call appends "To retry this exact mutation, re-issue identical args plus
    // retry_of:<rid>" for every RETRY_TOKEN_CMDS timeout, and exit_subgraph is one.
    // A flat "do not retry" underneath that would leave the caller two opposite
    // instructions in one message. The two are reconcilable and the note has to do
    // the reconciling: a TOKEN retry is answered from the original's ledger entry
    // with no second executor run (#694), a BARE one executes fresh and pops again.
    const out = await runTool(
      "panel_exit_subgraph",
      {},
      { probeScope: "subgraph", probeTitle: "Refiner" },
    );

    // The instruction really is present — otherwise this test asserts about a
    // message that never renders, which is the trap it exists to close.
    expect(out.text).toMatch(/retry_of:"rid-original-1468"/);
    expect(out.text).toMatch(/retry_of token above rather than a bare repeat/);
    expect(out.text).toMatch(/WITHOUT running the executor again/);
    expect(out.text).not.toMatch(/Do NOT retry/);
  });

  it("claims nothing when the settling read itself cannot answer", async () => {
    // #1473's rule. A backgrounded tab fails the probe too, and reading that as
    // proof in either direction invents a verdict out of a transport failure.
    const out = await runTool("panel_exit_subgraph", {}, { probeScope: "timeout" });

    expect(sent.map((s) => s.cmd)).toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/does NOT settle it/);
    // The original disclosure survives untouched.
    expect(out.text).toMatch(/may have been applied despite the missing reply/);
  });

  it("claims nothing when the probe lands on a DIFFERENT tab (codex P1)", async () => {
    // ctx.call runs ensureReachable first, which silently rebinds an unpinned
    // current-mode session onto the sole remaining interactive tab when the bound
    // one has gone — exactly what an unanswered command makes likely. That tab
    // sitting at root is not evidence about the navigation we dispatched
    // elsewhere, and reporting it as success would be a WRONG-TARGET success:
    // worse than the false failure this issue is about.
    const out = await runTool(
      "panel_exit_subgraph",
      {},
      { probeScope: "root", loseTabAfterExit: true },
    );

    // The rebind really happened — asserted directly, not inferred from the
    // verdict. Without this the test would stay green if ensureReachable silently
    // declined to rebind, proving only that a root read reports root.
    expect(out.boundTab).toBe(OTHER_TAB);
    expect(sent.some((s) => s.cmd === "graph_query")).toBe(true);
    expect(out.isError).toBe(true);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
    expect(out.text).not.toMatch(/canvas at the ROOT graph/);
  });

  it("does not settle an ACKED error reproducing the canonical sentence VERBATIM (codex P1)", async () => {
    // The decisive test for choosing the bridge's tag over message text. This
    // error is textually indistinguishable from a real no-reply for the whole
    // length of the canonical sentence — every regex that admits the genuine
    // timeout admits this too. It must still be refused, and it is, because the
    // bridge never tagged it: the tab ANSWERED, with a failure.
    const out = await runTool("panel_exit_subgraph", {}, { exitReply: "acked-error-timeout-worded" });

    // The premise really holds — if this stopped matching the canonical opening,
    // the test would pass while no longer testing the collision it exists for.
    expect(out.text).toMatch(
      /did not reply to "graph_exit_subgraph" within 15000 ms — the ComfyUI tab may be backgrounded or frozen/,
    );
    expect(sent.map((s) => s.cmd)).not.toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/nothing was applied/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });

  it("does not second-guess an ACKED executor error", async () => {
    // A relayed panel verdict is not a no-reply. The panel had the canvas in front
    // of it and already prescribes a scope read; re-deciding that from out here
    // would overwrite a better-informed verdict with a worse-informed one.
    const out = await runTool("panel_exit_subgraph", {}, { exitReply: "acked-error" });

    expect(sent.map((s) => s.cmd)).not.toContain("graph_query");
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/no observation ever saw the canvas there/);
    expect(out.text).not.toMatch(/CHECKED FOR YOU/);
  });
});

describe("civitai_search waits as long as every other panel command (#1468)", () => {
  it("dispatches on the shared default bound, not a tighter private one", async () => {
    await runTool("panel_civitai_search", { query: "flux" }, {});

    const search = sent.find((s) => s.cmd === "civitai_search");
    expect(search).toBeDefined();
    // The literal that was there is the bug; pin the value AND its identity so a
    // future edit cannot quietly reintroduce a private bound under a new number.
    expect(search?.timeoutMs).toBe(BRIDGE_DEFAULT_TIMEOUT_MS);
    expect(search?.timeoutMs).not.toBe(10000);
  });
});
