import { describe, expect, it, vi } from "vitest";
import { waitFor } from "./wait-for.js";

/**
 * What this helper is allowed to change (#1325).
 *
 * Its whole job is to replace `vi.waitFor`'s 1-second DEFAULT, which no call site chose.
 * The first version also took the larger of the default and any explicit timeout, and
 * passed a 10ms interval — two changes nobody asked for, and both had teeth:
 *
 *   - `claude-stall-notice.test.ts` bounds a watchdog notice at `IDLE_MS * 20` (2.4s) with
 *     `IDLE_MS` deliberately set to 120. Raising that to 15s let a notice arriving 25x to
 *     125x late pass. It is a bounded-time assertion, and I had looked straight at it and
 *     decided it was not.
 *   - `run-template.test.ts` pairs a 10s wait with a 15s TEST timeout. Raising the wait to
 *     15s hands the failure to the runner's deadline, so a broken wait reports vitest's
 *     generic "test timed out" instead of its own reason.
 *   - vitest's default interval is 50ms; passing 10ms made 287 waits poll five times as
 *     hard, on the starved machine this exists to accommodate.
 *
 * So this asserts the CONTRACT rather than the behaviour of any one test: explicit wins,
 * the default fills in, and nothing else moves.
 */
describe("#1325 — the wait helper changes the default and nothing else", () => {
  it("passes an explicit timeout through UNCHANGED", async () => {
    const spy = vi.spyOn(vi, "waitFor");
    await waitFor(() => true, { timeout: 2400 });
    expect(spy.mock.calls[0][1]).toMatchObject({ timeout: 2400 });
    spy.mockRestore();
  });

  it("supplies the 15s default only when the caller gave none", async () => {
    const spy = vi.spyOn(vi, "waitFor");
    await waitFor(() => true);
    expect(spy.mock.calls[0][1]).toMatchObject({ timeout: 15_000 });
    spy.mockRestore();
  });

  it("leaves the polling interval at vitest's own default", async () => {
    const spy = vi.spyOn(vi, "waitFor");
    await waitFor(() => true);
    expect(spy.mock.calls[0][1]).toMatchObject({ interval: 50 });
    spy.mockRestore();
  });

  it("…and honours an explicit interval when one is given", async () => {
    const spy = vi.spyOn(vi, "waitFor");
    await waitFor(() => true, { interval: 20 });
    expect(spy.mock.calls[0][1]).toMatchObject({ interval: 20 });
    spy.mockRestore();
  });

  it("still resolves with the callback's value", async () => {
    // The point of the wrapper is the options; it must not change what a caller gets back.
    await expect(waitFor(() => "ready")).resolves.toBe("ready");
  });
});
