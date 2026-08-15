import { vi } from "vitest";

/**
 * `vi.waitFor` with a deadline that is not the thing under test (#1325).
 *
 * ## The defect
 *
 * `vi.waitFor`'s default timeout is ONE SECOND, and `testTimeout` does not govern it — it
 * rejects on its own deadline long before the test budget is reached. So a starved runner
 * produces an ASSERTION failure (`expected false to be true`) instead of a timeout, which
 * is why this never looked like the problem vitest.config.ts already describes:
 *
 * > Nothing about the code under test is racy; the measurement apparatus was.
 *
 * That comment raised `testTimeout` to 30s for #852's "rotating cast of unrelated files".
 * The same starvation, one level down, has been reported separately ever since as #1325 —
 * and the two were never connected because one shape says TIMEOUT and the other says a
 * boolean was wrong.
 *
 * ## The measurement
 *
 * On `src/__tests__/services/ui-bridge.test.ts` (193 of these waits, every one a real
 * WebSocket handshake or command round-trip over loopback):
 *
 *     idle machine, file alone            0 failures / 10 runs
 *     14 CPU-burning PROCESSES alongside  2 failures /  6 runs
 *
 * Six different tests in that file have been observed failing this way. They have nothing
 * in common except this default — which is the tell.
 *
 * Separate PROCESSES matter: an earlier round on #1325 measured that a local event-loop lag
 * probe adapts to congestion inside its own loop and cannot see cross-process starvation at
 * all. The failures were seen while unrelated builds, agents and a smoke run had the machine
 * busy — not while other vitest workers did.
 *
 * ## Why this is not widening a tolerance to hide a race
 *
 * The same reasoning vitest.config.ts sets out for `testTimeout`: an untimed wait guards
 * the RUNNER being starved of CPU, not a race in product code. The waits this touches are
 * the ones that specified NO bound at all — they were never asserting a deadline, they
 * inherited one. Calls that DO state a bound keep it exactly, including the two that mean
 * something by it.
 *
 * The cost is bounded and falls only on failures: an unbounded wait that never settles
 * reports in 15s instead of 1s, inside the existing 30s test budget.
 *
 * If a wait ever needs MORE than this, make it deterministic — inject the clock, drive the
 * event — rather than raising the number.
 */
const DEADLINE_MS = 15_000;

/**
 * `vi.waitFor` with a deadline that is not the thing under test (#1325).
 *
 * THE DEFAULT IS THE ONLY THING THIS CHANGES. An explicit timeout is the author's
 * deliberate bound and is passed through untouched — my first version took the LARGER of
 * the two, which quietly rewrote two real assertions (codex):
 *
 *   - `claude-stall-notice.test.ts` configures `IDLE_MS = 120` and bounds the watchdog
 *     notice at `IDLE_MS * 20`. That is a bounded-time claim: the notice must arrive within
 *     ~20 idle windows. Raising it to 15s made a regression that took 3-14 seconds — 25x
 *     to 125x the configured idle period — pass. My "no wait here asserts that something
 *     happens quickly" was simply wrong, and I had checked it and talked myself past it.
 *   - `run-template.test.ts:262` pairs a 10s wait with a 15s TEST timeout. Raising the wait
 *     to 15s lets the runner's deadline win, so a broken wait reports vitest's generic
 *     "test timed out" instead of its own reason — the opposite of the point.
 *
 * A site whose explicit bound turns out to be too tight under load should be raised
 * individually, with a note about why that number.
 */
export function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(fn, {
    timeout: opts.timeout ?? DEADLINE_MS,
    // Vitest's default is 50ms, not 10ms. My first version passed 10ms and so made 287
    // waits poll five times as hard — on a machine this exists to stop starving (codex).
    interval: opts.interval ?? 50,
  });
}
