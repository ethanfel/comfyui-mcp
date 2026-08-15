/**
 * What the monitor's 10-minute timeout should DO. (#1385)
 *
 * Its own module so the tests can call the real thing. The previous test reimplemented
 * this decision inline and asserted against its own copy, which is a test of the test: a
 * regression that inverted the production condition would have left it green (codex P3).
 * `monitor-progress.mjs` connects to ComfyUI at import, so the decision has to live
 * somewhere importable on its own for that to be possible.
 *
 * THREE OUTCOMES, because there are three situations and the old code had one:
 *
 *  - "incomplete" — jobs are genuinely still running. The timeout's reason for existing.
 *  - "stalled"    — every job reported a terminal state, but the run has not exited, so
 *                   post-processing (the history/output fetch) is still in flight or wedged.
 *                   Returning here hangs forever: the abort timer in `fetchJSON` is cleared
 *                   once response HEADERS arrive, so a body that never finishes streaming
 *                   is not bounded by anything, and the open socket keeps the process
 *                   alive. The old unconditional `exit(1)` masked that.
 *  - "clean"      — everything finished and the normal exit path is a moment away. This is
 *                   the case the previous version got wrong: `doneCount++` lands after an
 *                   awaited fetch, so a job that finished just before the timeout left an
 *                   EMPTY list and still exited 1, reporting a clean run as a failure.
 */
export function timeoutVerdict(jobs, { now = Date.now(), postProcessingDone = false } = {}) {
  const unfinished = [...jobs.entries()].filter(([, j]) => !j.finished);
  if (unfinished.length > 0) {
    return {
      kind: "incomplete",
      remaining: unfinished.map(([id, j]) => ({
        id,
        // DISPLAY only — the decision above is the flag, which is set synchronously before
        // any await; `status` is a local observation that can lag the server.
        status: j.status,
        seconds: Math.round((now - j.startTime) / 1000),
      })),
    };
  }
  return { kind: postProcessingDone ? "clean" : "stalled", remaining: [] };
}

/** One line describing the verdict, or null when there is nothing to say. */
export function describeTimeout(verdict, { jobCount, graceSeconds }) {
  if (verdict.kind === "incomplete") {
    const list = verdict.remaining.map((r) => `${r.id} (${r.status}, ${r.seconds}s)`).join(", ");
    return `[TIMEOUT] ${verdict.remaining.length} job(s) still incomplete after 10 minutes: ${list}`;
  }
  if (verdict.kind === "stalled") {
    // Named precisely, because "0 job(s) still incomplete" — the old message for this
    // state — reads as a script that cannot count.
    return (
      `[TIMEOUT] all ${jobCount} job(s) reported a terminal state, but the run has not ` +
      `finished fetching their history/outputs. Waiting ${graceSeconds}s more, then giving up.`
    );
  }
  return null;
}

/**
 * What a completed history entry's messages say the run actually DID. (#1385, codex)
 *
 * Shared, because the two places that asked — the startup catch-up scan and the poller —
 * each had their own copy of `hasError ? "error" : "success"`, and both therefore reported
 * a CANCELLED run as a success. ComfyUI marks an interrupted prompt `completed` and emits
 * `execution_interrupted`; this repo's own history reader already treats that as a
 * non-success terminal state (src/services/job-history.ts). Only this script disagreed.
 */
export function classifyHistoryMessages(messages) {
  const has = (name) => (messages ?? []).some((m) => m?.[0] === name);
  if (has("execution_error")) return "error";
  if (has("execution_interrupted")) return "cancelled";
  return "success";
}
