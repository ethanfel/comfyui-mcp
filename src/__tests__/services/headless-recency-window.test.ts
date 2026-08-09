// #1176 — a BACKGROUNDED phone is not a departed phone.
//
// #875 defers a self-restart while a paired phone is present, because a restart
// mints a NEW cloudflared quick-tunnel hostname and the old one stops resolving.
// The gate asked `hasLiveHeadlessClient()`, which reads currently-OPEN sockets —
// and a phone at work with its screen off has had its socket suspended or closed
// by the mobile OS. So the gate opened, the orchestrator self-updated
// 0.50.39 → 0.50.41, and the reporter picked up their phone to:
//
//   Failed host lookup: 'cameron-timing-face-spies.trycloudflare.com'
//   (No address associated with hostname, errno = 7)
//
// A DNS failure, not a timeout or a refusal: the hostname no longer existed.
//
// The sticky isHeadless() was rejected for this gate and that was right — a phone
// that paired once and left would defer updates forever. But those are not the
// only two options, and the state between them is the NORMAL one for a phone.

import { describe, expect, it } from "vitest";
import { UiBridge, HEADLESS_RECENCY_MS } from "../../services/ui-bridge.js";

/** A bridge with its headless-disconnect clock placed at a chosen age. */
function bridgeWithHeadlessGoneFor(ms: number | null): UiBridge {
  const b = new UiBridge() as UiBridge & {
    markHeadlessDisconnectForTests(at: number): void;
  };
  // Monotonic, matching the field — the recency window measures ELAPSED time,
  // which the wall clock does not (codex review: an NTP step could skip it).
  if (ms !== null) b.markHeadlessDisconnectForTests(performance.now() - ms);
  return b;
}

describe("the restart-deferral gate covers a pocketed phone (#1176)", () => {
  it("still defers seconds after the socket closed — the reported case", () => {
    // The mobile OS suspends a backgrounded socket within seconds.
    expect(bridgeWithHeadlessGoneFor(5_000).hasLiveHeadlessClient()).toBe(true);
  });

  it("still defers across a meeting", () => {
    expect(bridgeWithHeadlessGoneFor(20 * 60_000).hasLiveHeadlessClient()).toBe(true);
  });

  it("stops deferring once the phone has genuinely been gone", () => {
    // The property that killed the sticky option: this happens on its own, with
    // no unpairing step and no user action, so an install that lost its phone
    // still gets its updates.
    expect(bridgeWithHeadlessGoneFor(HEADLESS_RECENCY_MS + 1).hasLiveHeadlessClient()).toBe(false);
  });

  it("never defers on an install that has never seen a headless client", () => {
    // The clock is undefined until a headless socket actually disconnects, so a
    // desktop-only install can never be held back by this.
    expect(bridgeWithHeadlessGoneFor(null).hasLiveHeadlessClient()).toBe(false);
  });

  it("uses a window measured in minutes, not seconds", () => {
    // The duration IS the fix. A window short enough to still lapse while a
    // phone is in a pocket is the bug wearing the fix's shape — and the cost of
    // being generous is only a delayed update, while the cost of being stingy is
    // a phone that cannot get back in.
    expect(HEADLESS_RECENCY_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
