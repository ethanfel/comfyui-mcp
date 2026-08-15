#!/usr/bin/env node
/**
 * Background progress monitor for ComfyUI jobs.
 *
 * Usage: node monitor-progress.mjs <prompt_id> [prompt_id...]
 *
 * Connects to ComfyUI's WebSocket for real-time step progress.
 * Falls back to HTTP polling if WebSocket is unavailable.
 * Detects stalls (no progress for too long) and unreachable servers.
 * Exits when all tracked jobs complete.
 *
 * Env: COMFYUI_PORT (or COMFY_PORT, default 8000), COMFYUI_HOST (or COMFY_HOST, default 127.0.0.1),
 *      COMFYUI_SSL (default false — set "true" to use https:// + wss://)
 */

import { timeoutVerdict, describeTimeout, classifyHistoryMessages } from "./monitor-timeout.mjs";

const HOST = process.env.COMFYUI_HOST || process.env.COMFY_HOST || "127.0.0.1";
const PORT = Number(process.env.COMFYUI_PORT || process.env.COMFY_PORT) || 8000;
const SSL = process.env.COMFYUI_SSL === "true";
const HTTP_PROTOCOL = SSL ? "https" : "http";
const WS_PROTOCOL = SSL ? "wss" : "ws";
const TIMEOUT_MS = 10 * 60 * 1000;
const THROTTLE_MS = 2000;
const THROTTLE_PCT = 10;
const POLL_INTERVAL_MS = 3000;
const HISTORY_DELAY_MS = 500;
const STALL_WARN_MS = 60_000; // Warn after 60s with no progress
const STALL_CHECK_MS = 15_000; // Check for stalls every 15s
const HEALTH_TIMEOUT_MS = 5000; // Startup health check timeout

const promptIds = new Set(process.argv.slice(2));
if (promptIds.size === 0) {
  console.error(
    "Usage: node monitor-progress.mjs <prompt_id> [prompt_id...]",
  );
  process.exit(1);
}

// ── State ───────────────────────────────────────────────────────────────

const jobs = new Map();
for (const id of promptIds) {
  jobs.set(id, {
    status: "pending", // pending | running | done | error
    step: 0,
    maxSteps: 0,
    node: "",
    lastPrint: 0,
    lastPct: -1,
    startTime: Date.now(),
    lastActivity: Date.now(), // last WS event or status change
    stallWarned: false,
    // #1385 — the terminal re-entry guard. A FLAG, not a status comparison: markDone
    // assigns "success", which never matched a guard testing for "done", so one
    // completion was counted twice and the monitor exited while another job ran.
    finished: false,
  });
}

const short = (id) => id.slice(0, 8);
/** How long the timeout waits for post-processing once every job has reported. Short: the
 *  case it exists for is a fetch that already has its headers and needs a moment, not a
 *  second monitoring window. */
const POST_PROCESSING_GRACE_MS = 15_000;

let doneCount = 0;
let successCount = 0;
let errorCount = 0;
/** Interrupted runs. Its own tally, because folding them into either of the other two says
 *  something untrue: a cancelled job did not succeed, and nothing failed. */
let cancelledCount = 0;

console.log(
  `[MONITOR] Tracking ${jobs.size} job(s): ${[...promptIds].map(short).join(", ")}`,
);

// ── HTTP helpers ────────────────────────────────────────────────────────

async function fetchJSON(path, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${HTTP_PROTOCOL}://${HOST}:${PORT}${path}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function getOutputFilenames(promptId) {
  try {
    const history = await fetchJSON(`/history/${promptId}`);
    const entry = history[promptId];
    if (!entry) return [];
    const filenames = [];
    for (const nodeOutput of Object.values(entry.outputs || {})) {
      if (Array.isArray(nodeOutput.images)) {
        for (const img of nodeOutput.images) {
          filenames.push(img.filename);
        }
      }
    }
    return filenames;
  } catch {
    return [];
  }
}

async function getErrorDetails(promptId) {
  try {
    const history = await fetchJSON(`/history/${promptId}`);
    const entry = history[promptId];
    if (!entry) return null;
    const messages = entry.status?.messages || [];
    const errorMsg = messages.find((m) => m[0] === "execution_error");
    if (!errorMsg) return null;
    const d = errorMsg[1];
    return {
      node_id: d.node_id || "",
      node_type: d.node_type || "",
      message: d.exception_message || "Unknown error",
    };
  } catch {
    return null;
  }
}

// ── Health check ────────────────────────────────────────────────────────

async function checkServerHealth() {
  try {
    const stats = await fetchJSON("/system_stats", HEALTH_TIMEOUT_MS);
    const gpu = stats.devices?.[0];
    if (gpu) {
      const vramFreeMB = (gpu.vram_free / 1024 / 1024).toFixed(0);
      const vramTotalMB = (gpu.vram_total / 1024 / 1024).toFixed(0);
      console.log(
        `[MONITOR] ComfyUI online (${HOST}:${PORT}) | VRAM: ${vramFreeMB}/${vramTotalMB} MB free`,
      );
    } else {
      console.log(`[MONITOR] ComfyUI online (${HOST}:${PORT})`);
    }
    return true;
  } catch {
    console.log(
      `[WARNING] ComfyUI not reachable at ${HOST}:${PORT} — try restart_comfyui or start it manually. Will keep retrying.`,
    );
    return false;
  }
}

// ── Completion handler ──────────────────────────────────────────────────

async function markDone(promptId, status) {
  const job = jobs.get(promptId);
  // RE-ENTRY GUARD, on a flag rather than the status string (#1385).
  //
  // This used to test `status === "done" || "error"` and then assign `status`, which the
  // callers pass as "success" — so a successfully finished job never matched its own
  // guard. Two callers reach here for one completion (the WS `execution_success` event and
  // the history poller), and the second went straight through: `[DONE]` printed twice,
  // `successCount` and `doneCount` incremented twice, and `checkAllDone` then saw two of
  // two finished while the other job was still executing. The monitor exited 0 on a job
  // that had not produced its file yet.
  //
  // SET BEFORE ANY await, which is the other half. `doneCount++` sits after a
  // HISTORY_DELAY_MS sleep and a /history fetch, so even a correct status guard leaves a
  // window where both callers are past the check before either increments. A flag written
  // in the same tick as the check cannot be raced on a single-threaded event loop.
  //
  // It is also independent of the status vocabulary: adding a new terminal status can no
  // longer silently reopen this.
  if (!job || job.finished) return;
  job.finished = true;

  job.status = status;
  const elapsed = ((Date.now() - job.startTime) / 1000).toFixed(1);

  if (status === "error") {
    errorCount++;
    await new Promise((r) => setTimeout(r, HISTORY_DELAY_MS));
    const err = await getErrorDetails(promptId);
    if (err) {
      console.log(
        `[ERROR] ${short(promptId)} | Node ${err.node_id} (${err.node_type}): ${err.message}`,
      );
    } else {
      console.log(`[ERROR] ${short(promptId)} | Failed after ${elapsed}s`);
    }
  } else if (status === "cancelled") {
    // A NEW TERMINAL STATUS NEEDS A HOME EVERYWHERE IT LANDS (codex round 3). Teaching the
    // classifier to say "cancelled" while `markDone` still had two branches meant the new
    // value fell into the `else` — so an interrupted run printed `| success |` and counted
    // toward successCount, which is the very claim the classifier was added to stop making.
    // Fixing the vocabulary in one place and not the other is worse than not fixing it: the
    // code now looks like it handles interruption.
    cancelledCount++;
    console.log(`[CANCELLED] ${short(promptId)} | interrupted after ${elapsed}s | no outputs`);
  } else {
    successCount++;
    await new Promise((r) => setTimeout(r, HISTORY_DELAY_MS));
    const files = await getOutputFilenames(promptId);
    const fileStr =
      files.length > 0
        ? `${files.length} image(s): ${files.join(", ")}`
        : "no output images";
    console.log(
      `[DONE] ${short(promptId)} | success | ${elapsed}s | ${fileStr}`,
    );
  }

  doneCount++;
  checkAllDone();
}

function checkAllDone() {
  if (doneCount >= jobs.size) {
    const totalElapsed = (
      (Date.now() - Math.min(...[...jobs.values()].map((j) => j.startTime))) /
      1000
    ).toFixed(1);
    console.log(
      `[COMPLETE] All ${jobs.size} jobs finished: ${successCount} success, ${errorCount} error` +
        `${cancelledCount > 0 ? `, ${cancelledCount} cancelled` : ""} (total: ${totalElapsed}s)`,
    );
    // The exit code is unchanged for cancellations. A user who interrupts a job did not
    // hit a failure, and the summary above names what happened; turning their own action
    // into a non-zero exit would make every deliberate cancel look like a broken run.
    process.exit(0);
  }
}

// ── Check for already-completed jobs ────────────────────────────────────

async function checkAlreadyDone() {
  for (const promptId of promptIds) {
    try {
      const history = await fetchJSON(`/history/${promptId}`);
      const entry = history[promptId];
      if (entry?.status?.completed) {
        const messages = entry.status.messages || [];
        // A CANCELLED RUN IS NOT A SUCCESSFUL ONE (codex, pre-existing). ComfyUI marks
        // an interrupted prompt `completed` and reports `execution_interrupted`;
        // testing only for `execution_error` counted it as a success and printed it
        // as one. This repo's own history reader already treats that message as a
        // non-success terminal state (src/services/job-history.ts) — this script was
        // the odd one out, in two places with two copies of the same test.
        await markDone(promptId, classifyHistoryMessages(messages));
      }
    } catch {
      // Not in history yet — still pending/running
    }
  }
}

// ── Progress printing (throttled) ───────────────────────────────────────

function printProgress(promptId, step, max, node) {
  const job = jobs.get(promptId);
  // Same stale-status pattern as markDone (#1385): a finished job kept printing progress
  // because its status reads "success", not "done".
  if (!job || job.finished) return;

  job.step = step;
  job.maxSteps = max;
  job.node = node;
  job.lastActivity = Date.now();
  job.stallWarned = false;
  if (job.status === "pending") job.status = "running";

  const pct = max > 0 ? Math.round((step / max) * 100) : 0;
  const now = Date.now();

  const pctDelta = Math.abs(pct - job.lastPct);
  const timeDelta = now - job.lastPrint;
  if (
    step === 1 ||
    step === max ||
    pctDelta >= THROTTLE_PCT ||
    timeDelta >= THROTTLE_MS
  ) {
    console.log(
      `[PROGRESS] ${short(promptId)} | ${node} step ${step}/${max} (${pct}%)`,
    );
    job.lastPrint = now;
    job.lastPct = pct;
  }
}

// ── Stall detection ─────────────────────────────────────────────────────

function checkStalls() {
  const now = Date.now();
  for (const [promptId, job] of jobs) {
    if (job.finished) continue;

    const idleSec = ((now - job.lastActivity) / 1000).toFixed(0);
    const totalSec = ((now - job.startTime) / 1000).toFixed(0);

    if (now - job.lastActivity > STALL_WARN_MS && !job.stallWarned) {
      job.stallWarned = true;
      if (job.status === "running" && job.step > 0) {
        console.log(
          `[STALL] ${short(promptId)} | No progress for ${idleSec}s (stuck at step ${job.step}/${job.maxSteps}, elapsed ${totalSec}s) — possible OOM or hang. Try queue (action:"cancel") then clear_vram, or restart_comfyui.`,
        );
      } else if (job.status === "running") {
        console.log(
          `[STALL] ${short(promptId)} | Running but no step progress for ${idleSec}s (elapsed ${totalSec}s) — model may still be loading`,
        );
      } else {
        console.log(
          `[STALL] ${short(promptId)} | Pending for ${totalSec}s — queue may be blocked or ComfyUI unresponsive`,
        );
      }
    }
  }
}

// ── WebSocket connection ────────────────────────────────────────────────

let wsConnected = false;
let wsRetries = 0;
const MAX_WS_RETRIES = 3;

function connectWebSocket() {
  try {
    // Must match the clientId used by the MCP server's SDK Client (set in client.ts).
    // ComfyUI routes progress/executing events only to the WS client whose clientId
    // matches the client_id in the POST /prompt body.
    const ws = new WebSocket(
      `${WS_PROTOCOL}://${HOST}:${PORT}/ws?clientId=comfyui-mcp`,
    );

    ws.onopen = () => {
      wsConnected = true;
      wsRetries = 0;
      console.log(`[MONITOR] WebSocket connected`);
    };

    ws.onmessage = (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(raw);
        const type = msg.type;
        const data = msg.data;

        if (!data?.prompt_id || !promptIds.has(data.prompt_id)) return;

        // Update activity timestamp for any event about our jobs
        const job = jobs.get(data.prompt_id);
        if (job) {
          job.lastActivity = Date.now();
          job.stallWarned = false;
        }

        if (type === "progress") {
          printProgress(data.prompt_id, data.value, data.max, data.node || "");
        } else if (type === "executing" && data.node) {
          if (job && job.status === "pending") job.status = "running";
        } else if (type === "execution_success") {
          markDone(data.prompt_id, "success");
        } else if (type === "execution_error") {
          markDone(data.prompt_id, "error");
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      if (wsRetries < MAX_WS_RETRIES && doneCount < jobs.size) {
        wsRetries++;
        setTimeout(connectWebSocket, 2000);
      } else if (doneCount < jobs.size) {
        console.log(
          `[WARNING] WebSocket disconnected after ${MAX_WS_RETRIES} retries — using HTTP polling only (no step progress)`,
        );
      }
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  } catch {
    wsConnected = false;
    console.log(
      `[WARNING] WebSocket unavailable — using HTTP polling only (no step progress)`,
    );
  }
}

// ── HTTP polling fallback ───────────────────────────────────────────────

let consecutiveFailures = 0;

function startPolling() {
  const timer = setInterval(async () => {
    if (doneCount >= jobs.size) {
      clearInterval(timer);
      return;
    }

    for (const [promptId, job] of jobs) {
      if (job.finished) continue;

      try {
        const history = await fetchJSON(`/history/${promptId}`);
        consecutiveFailures = 0;
        const entry = history[promptId];
        if (entry?.status?.completed) {
          const messages = entry.status.messages || [];
          // A CANCELLED RUN IS NOT A SUCCESSFUL ONE (codex, pre-existing). ComfyUI marks
          // an interrupted prompt `completed` and reports `execution_interrupted`;
          // testing only for `execution_error` counted it as a success and printed it
          // as one. This repo's own history reader already treats that message as a
          // non-success terminal state (src/services/job-history.ts) — this script was
          // the odd one out, in two places with two copies of the same test.
          await markDone(promptId, classifyHistoryMessages(messages));
        }
      } catch {
        consecutiveFailures++;
        if (consecutiveFailures === 5) {
          console.log(
            `[WARNING] ComfyUI API unreachable for ${((consecutiveFailures * POLL_INTERVAL_MS) / 1000).toFixed(0)}s — server may have crashed. Try restart_comfyui or start it manually.`,
          );
        } else if (consecutiveFailures > 0 && consecutiveFailures % 20 === 0) {
          console.log(
            `[WARNING] ComfyUI still unreachable (${((consecutiveFailures * POLL_INTERVAL_MS) / 1000).toFixed(0)}s)`,
          );
        }
      }
    }
  }, POLL_INTERVAL_MS);

  return timer;
}

// ── Stall checker interval ──────────────────────────────────────────────

function startStallChecker() {
  return setInterval(() => {
    if (doneCount >= jobs.size) return;
    checkStalls();
  }, STALL_CHECK_MS);
}

// ── Timeout ─────────────────────────────────────────────────────────────

setTimeout(() => {
  // The decision lives in monitor-timeout.mjs so the tests can call the real one — see the
  // comment there for why all three outcomes exist and which two used to be conflated.
  const verdict = timeoutVerdict(jobs, { postProcessingDone: doneCount >= jobs.size });
  const line = describeTimeout(verdict, {
    jobCount: jobs.size,
    graceSeconds: POST_PROCESSING_GRACE_MS / 1000,
  });
  if (line) console.log(line);
  if (verdict.kind === "incomplete") process.exit(1);
  if (verdict.kind === "clean") return; // the normal exit path is a moment away

  // STALLED. Every job reported a terminal state, so the run is not waiting on ComfyUI; it
  // is waiting on its own post-processing, and nothing bounds that — `fetchJSON` clears its
  // abort timer once response HEADERS arrive, so a body that never finishes streaming keeps
  // an open socket and the process alive forever (codex P1). Returning here is the hang the
  // old unconditional exit(1) was accidentally preventing. A short grace first, because a
  // job finishing a moment before the timeout is exactly the near-miss this whole fix is
  // about, and it resolves in well under a second.
  setTimeout(() => {
    if (doneCount >= jobs.size) return; // it landed during the grace; let the normal exit run
    console.log(
      `[TIMEOUT] giving up: ${jobs.size} job(s) finished but their history/outputs never ` +
        `finished being read. The jobs themselves completed — check ComfyUI directly for results.`,
    );
    process.exit(1);
  }, POST_PROCESSING_GRACE_MS);
}, TIMEOUT_MS);

// ── Main ────────────────────────────────────────────────────────────────

const serverUp = await checkServerHealth();
await checkAlreadyDone();

if (doneCount < jobs.size) {
  if (serverUp) {
    connectWebSocket();
  }
  startPolling();
  startStallChecker();
}
