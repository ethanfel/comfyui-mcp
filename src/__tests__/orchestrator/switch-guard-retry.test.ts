// #1027 — rapid read-only inspection across several workflow tabs produced a
// run of confusing errors: "canvas IS bound, but graph does not match loaded
// state", "workflow instance mismatch", "panel is switching/refreshing", and a
// 15s open timeout. The reporter read it as a wedge.
//
// It is a race, and the panel already handles its half correctly. While a
// workflow switch/reload is in flight it refuses every graph and workflow
// executor rather than queueing — refusing cannot reorder or double-apply — and
// says so explicitly:
//
//   the panel is switching/refreshing "<key>" right now, so "<cmd>" was NOT
//   applied — nothing changed. Retry in a moment.
//
// Nothing was applied, and the section lasts a fraction of a second. But that
// text matched none of the orchestrator's transient patterns, so a read issued
// right after panel_open_workflow surfaced the raw refusal instead of waiting
// the ~400ms the panel asked for.
//
// The second half matters as much: when the retry ALSO lands mid-switch, saying
// "still reconnecting after a restart/reload" would repeat #1001 exactly — the
// tab is connected and healthy, it is simply mid-switch.

import { beforeEach, describe, expect, it } from "vitest";

import {
  makePanelToolCtx,
  __panelToolsTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { resetSwitchHolds, switchHoldFor } from "../../orchestrator/switch-hold.js";

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/** Verbatim from the panel's activeWorkflowReloadGuard branch. */
function switchGuardError(cmd = "graph_outline"): Error {
  return new Error(
    `the panel is switching/refreshing "wf:workflows/a.json" right now, so "${cmd}" ` +
      `was NOT applied — nothing changed. Retry in a moment.`,
  );
}

let attempts: number;

/** Fails the first `failures` sends with the switch guard, then succeeds. */
function bridgeFailing(failures: number, err: () => Error = switchGuardError) {
  attempts = 0;
  return {
    send: async () => {
      attempts += 1;
      if (attempts <= failures) throw err();
      return { ok: true, nodes: [] };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
  } as unknown as PanelToolCtx["bridge"];
}

beforeEach(() => {
  __panelToolsTestHooks.setRetrySettleMs(0); // the real wait is ~400ms
  resetSwitchHolds(); // panel#1097 — the run is per tab and outlives one call
});

describe("#1027: a mid-switch refusal is retried, not surfaced", () => {
  it("retries a read that landed during the switch, and succeeds", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(1), "tab-1");
    const res = await ctx.call({ cmd: "graph_outline" });
    expect(res.isError).toBeFalsy();
    expect(attempts).toBe(2); // refused once, then applied
  });

  it("does not re-issue a MUTATING command on its own initiative", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(1), "tab-1");
    const res = await ctx.call({ cmd: "graph_add_node", class_type: "KSampler" });
    expect(res.isError).toBe(true);
    expect(attempts).toBe(1); // never retried — that is the double-apply rule
  });
});

describe("#1027: when the retry ALSO lands mid-switch", () => {
  it("does not call a connected panel 'reconnecting' — the #1001 mistake", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).not.toContain("still reconnecting");
    expect(text).not.toContain("restart/reload");
  });

  it("names the actual state, and that nothing was applied", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).toContain("was NOT applied");
    expect(text).toContain("switching or reloading");
    expect(text).toContain("this is not a");
    // The one thing that would genuinely explain a stuck switch.
    expect(text).toContain("unsaved-changes");
  });

  it("preserves the panel's own words for the reader", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    expect(textOf(await ctx.call({ cmd: "graph_outline" }))).toContain(
      "panel is switching/refreshing",
    );
  });
});

describe("#1027: the other refusals keep their own handling", () => {
  it("a genuine reconnect still reports as a reconnect", async () => {
    const ctx = makePanelToolCtx(
      bridgeFailing(99, () => new Error('no connected tab with id "tab-1". Connected: none')),
      "tab-1",
    );
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).toContain("still reconnecting");
    expect(text).not.toContain("switching or reloading");
  });

  // An instance mismatch is NOT retryable: the stamp names a workflow that is no
  // longer active, and waiting cannot change that. Retrying it would burn a round
  // trip and then report the same thing.
  it("an instance mismatch is not retried", async () => {
    const ctx = makePanelToolCtx(
      bridgeFailing(99, () =>
        new Error(
          "workflow instance mismatch: this command targets a different workflow than the active canvas",
        ),
      ),
      "tab-1",
    );
    const res = await ctx.call({ cmd: "graph_outline" });
    expect(res.isError).toBe(true);
    expect(attempts).toBe(1);
  });
});

describe("panel#1097: a switch that never clears stops reading like one that will", () => {
  // The reporter retried into this refusal indefinitely. Every one of them said
  // "it normally clears in well under a second, so simply retry", because nothing
  // timed the RUN — so the tool could not notice its own advice failing.
  it("says nothing extra while the hold is still momentary", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));
    expect(text).toContain("still switching or reloading");
    expect(text).not.toContain("HELD FOR");
  });

  it("reports the hold once a run of refusals contradicts that advice", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    // Each call refuses twice (initial + the one retry), so the run builds.
    await ctx.call({ cmd: "graph_outline" });
    await new Promise((r) => setTimeout(r, 3100)); // past the "worth saying" floor
    const text = textOf(await ctx.call({ cmd: "graph_outline" }));

    expect(text).toContain("HELD FOR");
    // Both explanations, neither asserted (codex review) — elapsed time does not
    // prove a modal, and a large graph or remote canvas can legitimately take this.
    expect(text).toContain("it may still be loading");
    expect(text).toContain("awaiting a person");
    expect(text).toContain("Retrying clears the first and never the second");
  }, 15_000);

  it("a SUCCESS between refusals resets the run — the age is not cumulative", async () => {
    const ctx = makePanelToolCtx(bridgeFailing(99), "tab-1");
    await ctx.call({ cmd: "graph_outline" });
    await new Promise((r) => setTimeout(r, 3100));

    // A command that was switch-refused and then SUCCEEDED on its retry clears the
    // hold. (An unrelated success does not — it proves nothing about the switch.)
    const okCtx = makePanelToolCtx(bridgeFailing(1), "tab-1");
    expect((await okCtx.call({ cmd: "graph_outline" })).isError).toBeFalsy();

    // …so the next refusal is a fresh, momentary one again.
    const after = textOf(await makePanelToolCtx(bridgeFailing(99), "tab-1").call({ cmd: "graph_outline" }));
    expect(after).not.toContain("HELD FOR");
  }, 15_000);
});

describe("panel#1097: the run belongs to the tab the command was DISPATCHED on", () => {
  // codex rounds 1-2. ctx.tabId is mutable: ensureReachable rebinds a current-mode
  // session onto whichever tab is live. Snapshotting it BEFORE that rebind filed
  // tab B's refusal under tab A — so an unrelated A command could later reset a
  // stuck B, and B's own age was never recorded.
  it("records under the REBOUND tab, not the one the call started on", async () => {
    // The tab must move BETWEEN the two attempts — that is the only ordering where
    // the reassignment matters. If it has already moved before the first send, the
    // pre-rebind and post-rebind reads are the same value and nothing is proven.
    let reachable = "tab-1";
    const bridge = {
      send: async () => {
        reachable = "tab-2"; // the session rebinds during the retry's ensureReachable
        throw switchGuardError();
      },
      push: () => 1,
      canReach: (id: string) => id === reachable,
      isHeadless: () => false,
      tabs: () => [{ tab_id: reachable, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => reachable,
    } as unknown as PanelToolCtx["bridge"];

    const ctx = makePanelToolCtx(bridge, "tab-1");
    await ctx.call({ cmd: "graph_outline" });

    expect(switchHoldFor("tab-2"), "the tab it was actually dispatched on").toBeTruthy();
    expect(switchHoldFor("tab-1"), "the tab the call merely started on").toBeUndefined();
  });
});

describe("panel#1097: only a SWITCH refusal that then succeeds clears the run", () => {
  // codex round 3, P2: clearing after a transient-reconnect retry resets the
  // evidence one step removed — reconnecting proves nothing about whether the
  // canvas switch cleared, and a status read can reconnect while graph commands
  // stay refused.
  it("a reconnect-retry success leaves a switch run intact", async () => {
    // Build a run first.
    const stuck = makePanelToolCtx(bridgeFailing(99), "tab-1");
    await stuck.call({ cmd: "graph_outline" });
    expect(switchHoldFor("tab-1")).toBeTruthy();

    // A DIFFERENT failure kind that retries and succeeds.
    let n = 0;
    const reconnecting = {
      send: async () => {
        n += 1;
        // A real transient-reconnect shape (isTransientReconnectError matches this).
        if (n === 1) throw new Error("socket hang up");
        return { ok: true, nodes: [] };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
    } as unknown as PanelToolCtx["bridge"];

    const res = await makePanelToolCtx(reconnecting, "tab-1").call({ cmd: "graph_outline" });
    expect(res.isError).toBeFalsy();
    expect(switchHoldFor("tab-1"), "the switch run is not evidence about a reconnect").toBeTruthy();
  });
});

describe("panel#1097: what a SUCCESS proves depends on the command", () => {
  // Two rounds pulled opposite ways here. Clearing on every routed success let an
  // unguarded read wipe the evidence while graph commands stayed refused (r2);
  // clearing only on a switch-retry left a stale run for the next, unrelated
  // switch to inherit (r4). The guard's domain is what both agree on.
  it("an ordinary first-attempt graph success clears the run", async () => {
    const stuck = makePanelToolCtx(bridgeFailing(99), "tab-1");
    await stuck.call({ cmd: "graph_outline" });
    expect(switchHoldFor("tab-1")).toBeTruthy();

    const healthy = makePanelToolCtx(bridgeFailing(0), "tab-1");
    expect((await healthy.call({ cmd: "graph_outline" })).isError).toBeFalsy();
    expect(switchHoldFor("tab-1"), "the switch is demonstrably over").toBeUndefined();
  });

  it("a NON-guard command's success does not — it was never refused", async () => {
    const stuck = makePanelToolCtx(bridgeFailing(99), "tab-1");
    await stuck.call({ cmd: "graph_outline" });
    expect(switchHoldFor("tab-1")).toBeTruthy();

    const healthy = makePanelToolCtx(bridgeFailing(0), "tab-1");
    expect((await healthy.call({ cmd: "panel_status" })).isError).toBeFalsy();
    expect(switchHoldFor("tab-1"), "a status read proves nothing about the switch").toBeTruthy();
  });
});
