// comfyui-mcp-panel#1097 — "SIMPLY RETRY" MUST STOP BEING SAID TO SOMEONE WHOSE
// RETRIES ARE NOT WORKING.
//
// The panel refuses commands while it switches the canvas workflow, which is
// right. The orchestrator retries once and then explains, ending with "it normally
// clears in well under a second, so simply retry". For the reporter it never
// cleared — a switch can be held open indefinitely by a load dialog or an
// unsaved-changes prompt waiting on a person — and every refusal read identically
// to the momentary case, so nothing ever noticed that the advice was not working.
//
// This times the RUN of refusals per tab. It decides nothing: no guard is
// bypassed, no command is retried differently. It only lets the message tell the
// two cases apart.

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSwitchHold,
  describeSwitchHold,
  recordSwitchHold,
  resetSwitchHolds,
  switchHoldFor,
} from "../../orchestrator/switch-hold.js";

const T0 = 1_800_000_000_000;

beforeEach(() => resetSwitchHolds());

describe("panel#1097 timing a run of switch refusals", () => {
  it("starts a run on the first refusal and counts the rest", () => {
    expect(recordSwitchHold("tab", T0)).toEqual({ since: T0, last: T0, count: 1 });
    expect(recordSwitchHold("tab", T0 + 1000)).toEqual({ since: T0, last: T0 + 1000, count: 2 });
    expect(recordSwitchHold("tab", T0 + 9000)).toEqual({ since: T0, last: T0 + 9000, count: 3 });
  });

  it("keeps runs per TAB — one stuck canvas must not age another's", () => {
    recordSwitchHold("tab-a", T0);
    recordSwitchHold("tab-b", T0 + 60_000);
    expect(switchHoldFor("tab-a")?.since).toBe(T0);
    expect(switchHoldFor("tab-b")?.since).toBe(T0 + 60_000);
  });

  it("a SUCCESS clears the run, so the next refusal starts fresh", () => {
    recordSwitchHold("tab", T0);
    recordSwitchHold("tab", T0 + 30_000);
    clearSwitchHold("tab");
    expect(switchHoldFor("tab")).toBeUndefined();
    // …and the fresh run is dated from now, not from the old start.
    expect(recordSwitchHold("tab", T0 + 60_000)).toEqual({
      since: T0 + 60_000,
      last: T0 + 60_000,
      count: 1,
    });
  });

  it("a backwards clock restarts the run rather than reporting a negative age", () => {
    recordSwitchHold("tab", T0);
    expect(recordSwitchHold("tab", T0 - 5000)).toEqual({
      since: T0 - 5000,
      last: T0 - 5000,
      count: 1,
    });
  });
});

describe("panel#1097 what it says, and when it says nothing", () => {
  it("says NOTHING for the common momentary case", () => {
    // The refusal is already correct for a switch that clears in under a second;
    // adding a paragraph to it would be noise on the overwhelmingly common path.
    const brief = recordSwitchHold("tab", T0);
    expect(describeSwitchHold(brief, T0 + 200)).toBe("");
    const secondQuick = recordSwitchHold("tab", T0 + 400);
    expect(describeSwitchHold(secondQuick, T0 + 500)).toBe("");
  });

  it("says nothing on a FIRST refusal however old the clock claims it is", () => {
    // One refusal is not a run — and "held for 9s across 1 attempt" would be
    // describing a single call's own latency, not a stuck canvas.
    const first = recordSwitchHold("tab", T0);
    expect(describeSwitchHold(first, T0 + 90_000)).toBe("");
  });

  it("speaks up once the hold contradicts the advice being given", () => {
    recordSwitchHold("tab", T0);
    const held = recordSwitchHold("tab", T0 + 4000);
    const text = describeSwitchHold(held, T0 + 4000);
    expect(text).toContain("HELD FOR 4s");
    expect(text).toContain("across 2 failed calls");
  });

  it("offers BOTH explanations and asserts neither", () => {
    // codex review, P1: elapsed time does not prove a modal. A very large graph, a
    // slow disk or a remote canvas can legitimately switch for longer than this,
    // and telling that user the canvas is "not busy" and that retrying cannot work
    // would be wrong in the one direction that costs them the fix.
    recordSwitchHold("tab", T0);
    const held = recordSwitchHold("tab", T0 + 240_000);
    const text = describeSwitchHold(held, T0 + 240_000);
    expect(text).toContain("HELD FOR 4m");
    expect(text).toContain("it may still be loading");
    expect(text).toMatch(/load dialog|unsaved-changes prompt/);
    expect(text).toContain("Retrying clears the first and never the second");
    // The verdicts that are not established by elapsed time.
    expect(text).not.toContain("waiting for a person, not as busy");
    expect(text).not.toContain("no number of retries will clear it");
  });

  it("counts FAILED CALLS, and says so — that is what it measures", () => {
    // codex rounds 1-2: "attempts" overstated it, and "refusals" understated what
    // the panel saw. Each failed call refuses, settles, retries and refuses again,
    // so the panel sees roughly twice this. "Failed calls" is the number this
    // counts and the one a caller can compare against what they actually did.
    recordSwitchHold("tab", T0);
    const held = recordSwitchHold("tab", T0 + 5000);
    expect(describeSwitchHold(held, T0 + 5000)).toContain("across 2 failed calls");
  });

  it("evicts runs nobody has touched, so the map cannot grow forever", () => {
    // codex round 1, P2: without eviction an entry survives per tab id for the life
    // of the process, and a reused id inherits a stale age.
    recordSwitchHold("old-tab", T0);
    recordSwitchHold("new-tab", T0 + 11 * 60_000);
    expect(switchHoldFor("old-tab")).toBeUndefined();
    expect(switchHoldFor("new-tab")).toBeTruthy();
  });

  it("does NOT evict a hold that is still being retried — the most stuck case", () => {
    // codex round 3, P2: eviction keyed on the run's START dropped a hold that had
    // been retried for over ten minutes, resetting it to the momentary wording at
    // exactly the moment it was most obviously stuck.
    recordSwitchHold("stuck", T0);
    for (let m = 1; m <= 15; m++) recordSwitchHold("stuck", T0 + m * 60_000);
    const hold = switchHoldFor("stuck");
    expect(hold, "still tracked after 15 minutes of retrying").toBeTruthy();
    expect(hold?.since).toBe(T0); // and still aged from the START of the run
    expect(describeSwitchHold(hold, T0 + 15 * 60_000)).toContain("HELD FOR 15m");
  });

  it("renders minutes past 90s and seconds below it", () => {
    recordSwitchHold("tab", T0);
    const a = recordSwitchHold("tab", T0 + 80_000);
    expect(describeSwitchHold(a, T0 + 80_000)).toContain("HELD FOR 80s");
    const b = recordSwitchHold("tab", T0 + 200_000);
    expect(describeSwitchHold(b, T0 + 200_000)).toContain("HELD FOR 3m");
  });

  it("says nothing at all when there is no run", () => {
    expect(describeSwitchHold(undefined, T0)).toBe("");
  });
});
