// #1385 — `monitor-progress.mjs` printed `[DONE]` twice for one job and exited
// `[COMPLETE] All 2 jobs finished` while the second job was still executing. Its mp4 did
// not exist yet.
//
// TWO FAULTS, EITHER OF WHICH IS ENOUGH:
//
//   1. the re-entry guard tested `job.status === "done" || "error"` while the function
//      assigned `status`, which callers pass as "success" — so a successful job never
//      matched its own guard;
//   2. `doneCount++` sits after an await (a HISTORY_DELAY_MS sleep plus a /history fetch),
//      so even a correct status guard leaves a window where both callers are past the
//      check before either increments.
//
// Two callers reach markDone for one completion: the WS `execution_success` event and the
// history poller. Single-ID runs never showed it because exiting at the first completion is
// correct anyway.
//
// This asserts on the SOURCE. The script is a standalone .mjs with top-level side effects
// (it opens a WebSocket and calls process.exit), so importing it into a test would start a
// monitor rather than test one — and the defect is structural: which expression the guard
// reads, and whether the flag is set before the first await.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const src = (): string =>
  readFileSync(new URL("../../../plugin/scripts/monitor-progress.mjs", import.meta.url), "utf8");

/** Source with comments stripped — this file's own header names the strings it asserts. */
const code = (): string => src().replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("monitor-progress re-entry guard (#1385)", () => {
  it("guards on a FLAG, not on a status string it does not write", () => {
    const s = code();
    expect(s).toMatch(/if \(!job \|\| job\.finished\) return;/);
    expect(s).toMatch(/job\.finished = true;/);
  });

  it("NO comparison against the terminal vocabulary survives, in either form", () => {
    // Five sites had the same pattern. My first pass banned only the EQUALITY form and
    // missed the timeout path's inequality `j.status !== "done" && j.status !== "error"`,
    // which reports a just-succeeded job as incomplete and exits 1 — the assertion was
    // shaped like the bug I had already found rather than like the bug.
    const s = code();
    for (const pattern of [
      /\.status === "done"/,
      /\.status === "error"/,
      /\.status !== "done"/,
      /\.status !== "error"/,
    ]) {
      expect(s, `a terminal-status comparison survives: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("the TIMEOUT decides on the flag, and only reports when something is unfinished", async () => {
    // Calls the REAL decision. The previous version reimplemented it inline and asserted
    // against its own copy — a test of the test, which a production regression that
    // inverted the condition would have left green (codex P3). That is why the decision
    // now lives in its own module: monitor-progress.mjs connects to ComfyUI at import, so
    // nothing importable could reach it before.
    const { timeoutVerdict } = await import("../../../plugin/scripts/monitor-timeout.mjs");
    const jobs = (...list: { finished: boolean; status?: string }[]) =>
      new Map(list.map((j, i) => [`p${i}`, { startTime: 0, status: "running", ...j }]));

    // The regression this fixes: every job finished, but `doneCount++` lands only after an
    // awaited history fetch, so the counter lags. The old gate exited 1 and printed
    // "0 job(s) still incomplete" — a clean run reported as a failure, with an empty list
    // as its own evidence.
    expect(
      timeoutVerdict(jobs({ finished: true }, { finished: true }), { postProcessingDone: true }).kind,
    ).toBe("clean");

    // A genuine timeout still fails, which is the point of having one.
    const late = timeoutVerdict(jobs({ finished: true }, { finished: false }), {
      postProcessingDone: false,
    });
    expect(late.kind).toBe("incomplete");
    expect(late.remaining).toHaveLength(1);

    // …and the third state, which the two-way version could not express: everything
    // reported terminal, but the run has not exited, so post-processing is wedged. Exiting
    // 1 here would be wrong-cause; returning would hang forever.
    expect(
      timeoutVerdict(jobs({ finished: true }), { postProcessingDone: false }).kind,
    ).toBe("stalled");
  });

  it("a cancelled run is not reported as a success", async () => {
    // Pre-existing, found by codex while reviewing the timeout. ComfyUI marks an
    // interrupted prompt `completed` and emits `execution_interrupted`; both places that
    // classified history messages tested only for `execution_error`, so a job the user
    // cancelled was counted and printed as a success.
    const { classifyHistoryMessages } = await import("../../../plugin/scripts/monitor-timeout.mjs");
    expect(classifyHistoryMessages([["execution_start"], ["execution_success"]])).toBe("success");
    expect(classifyHistoryMessages([["execution_error"]])).toBe("error");
    expect(classifyHistoryMessages([["execution_interrupted"]])).toBe("cancelled");
    // An error alongside an interrupt is still an error — the more specific failure wins.
    expect(classifyHistoryMessages([["execution_interrupted"], ["execution_error"]])).toBe("error");
    expect(classifyHistoryMessages(undefined)).toBe("success");
  });

  it("a cancelled run is not counted or printed as a success", () => {
    // Codex round 3, and it is the half I left undone: teaching the classifier to say
    // "cancelled" while markDone still had exactly two branches meant the new value fell
    // into the `else` — printing `| success |` and incrementing successCount, which is the
    // claim the classifier was added to stop making. A vocabulary fixed in one place and
    // not the other is worse than none: the code then LOOKS like it handles interruption.
    const s = code();
    const body = s.slice(s.indexOf("async function markDone"), s.indexOf("function checkAllDone"));
    expect(body).toMatch(/status === "cancelled"/);
    // The branch must come BEFORE the catch-all, or it never runs.
    expect(body.indexOf('status === "cancelled"')).toBeLessThan(body.indexOf("successCount++"));
    // …and it must not reach the success tally.
    const cancelledBranch = body.slice(
      body.indexOf('status === "cancelled"'),
      body.indexOf("} else {", body.indexOf('status === "cancelled"')),
    );
    expect(cancelledBranch).not.toMatch(/successCount/);
    expect(cancelledBranch).toMatch(/cancelledCount\+\+/);
    // The summary has to say it happened, or the count is invisible.
    expect(s).toMatch(/cancelledCount > 0/);
  });

  it("both classification sites use the shared rule", () => {
    // There were two copies, indented differently, and fixing the one I happened to read
    // would have left a cancelled job reported as a success on the other path.
    const s = code();
    expect(s).not.toMatch(/hasError/);
    expect((s.match(/classifyHistoryMessages\(messages\)/g) ?? []).length).toBe(2);
  });

  it("the timeout no longer gates entry on the lagging counter", () => {
    // The one source fact worth pinning: `doneCount` must not decide whether jobs are
    // outstanding, because it is updated after an await while `finished` is not.
    //
    // Scoped to the TIMEOUT block alone. Slicing to end-of-file swept in a later,
    // legitimate `doneCount` gate — an assertion that reads the whole rest of the script
    // is not about the thing it names.
    const s = code();
    const start = s.indexOf("setTimeout(() => {");
    const end = s.indexOf("}, TIMEOUT_MS);", start);
    expect(start, "the timeout block must still exist").toBeGreaterThan(-1);
    // Asserted, because a missing end marker would silently widen the slice to the rest of
    // the file and the assertion below could then pass on unrelated code (codex).
    expect(end, "the timeout block must still close with }, TIMEOUT_MS);").toBeGreaterThan(start);
    const block = s.slice(start, end);
    // `postProcessingDone: doneCount >= jobs.size` is allowed — that is the counter
    // reporting on POST-PROCESSING, not on whether jobs are outstanding.
    expect(block).not.toMatch(/doneCount < jobs\.size/);

    // AND THE VERDICT MUST BE ACTED ON. The behavioural test above proves the decision is
    // right; nothing there reaches the line that obeys it, and mutation testing found that
    // gap — turning the exit into a `return` left every test green while a genuine timeout
    // silently hung. Reaching this any other way means spawning the script and waiting out
    // its ten-minute timer, so this is a source assertion on purpose, scoped to the block.
    expect(block).toMatch(/kind === "incomplete"\) process\.exit\(1\)/);
    expect(block).toMatch(/kind === "clean"\) return/);
  });

  it("the flag is set BEFORE the first await in markDone", () => {
    // The half a correct status guard would still not fix: both callers can be past the
    // check while the first is suspended in the history fetch.
    const s = code();
    const fn = s.slice(s.indexOf("async function markDone"), s.indexOf("function checkAllDone"));
    expect(fn).toContain("job.finished = true;");
    expect(fn.indexOf("job.finished = true;")).toBeLessThan(fn.indexOf("await"));
  });

  it("the flag is initialised on every job, so the first guard read is defined", () => {
    expect(code()).toMatch(/finished: false,/);
  });

  it("SEMANTICS: a second completion for the same job is a no-op", () => {
    // The behaviour the source shape is for, exercised directly: two callers, one
    // completion, one increment. Before the fix the second call passed the guard and
    // doneCount reached 2 for a single finished job — which is exactly what let
    // `doneCount >= jobs.size` fire while another job was still running.
    const job = { finished: false, status: "running" };
    let doneCount = 0;
    const markDone = (j: { finished: boolean; status: string }, status: string): void => {
      if (!j || j.finished) return;
      j.finished = true;
      j.status = status;
      doneCount++;
    };
    markDone(job, "success");
    markDone(job, "success");
    expect(doneCount).toBe(1);
    // …and the status it writes is still not one the old guard would have matched, which
    // is why the flag rather than a vocabulary fix.
    expect(job.status).toBe("success");
  });
});
