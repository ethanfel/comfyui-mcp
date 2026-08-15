/**
 * #1429 — what to tell an agent whose comfyui tools were stale for a whole turn.
 *
 * A ComfyUI retarget respawns every tab's comfyui MCP child, because `config` is
 * a module-load snapshot (src/config.ts) and a running child has no channel to
 * learn a new address. When the tab is mid-turn the respawn is DEFERRED to
 * turn-done (panel-agent.ts, applyPendingRestarts → "scheduled") — correct, since
 * an MCP server cannot be pulled out from under a running turn, but it means the
 * rest of that turn was served by a child still addressing the OLD target.
 *
 * The failure that gets reported is the dead-old-target one (a confusing "fetch
 * failed" naming an address the user believes they already left). The failure
 * that does NOT get reported, and is worse, is the LIVE-old-target one: the call
 * succeeds against the previous machine. A render lands on the pod the user just
 * left; an upload writes into its input/. Nothing in the transcript says so.
 *
 * This is the after-the-fact half of the fix: the agent is told, at turn-done,
 * which address its tools actually used. Preventing the wrong-machine call needs
 * the child to learn a target without a respawn, which is a larger change.
 */

/** Wording for the retry nudge. Both addresses are named — "the target moved" on
 *  its own leaves the agent unable to say WHICH of its calls went where, and the
 *  whole point is that the transcript is otherwise silent about it. These are the
 *  same base URLs the orchestrator already prints when it logs the retarget. */
export function staleTargetNudge(from: string, to: string): string {
  return (
    `ComfyUI's target changed from ${from} to ${to} while your previous turn was still running. ` +
    `Your comfyui tools were pointed at ${from} for that entire turn and switched to ${to} only just now. ` +
    `Anything you queued, uploaded, downloaded or listed during that turn went to ${from}, not ${to} — ` +
    `check whether it belonged on ${to} and re-run it there if so. ` +
    `If a comfyui tool failed during that turn, the stale address is the likely reason; retry it before concluding ComfyUI is unreachable.`
  );
}

/** True when a retarget is worth nudging about at all. A first-ever target (no
 *  previous) is a startup seed, not a switch — nothing ran against anything else,
 *  so a nudge would be a false alarm. Same-address is likewise not a move; the
 *  caller already skips those, and this keeps the helper honest on its own. */
export function retargetIsWorthNudging(from: string | null | undefined, to: string): boolean {
  if (typeof from !== "string" || from.length === 0) return false;
  return sameTarget(from, to) === false;
}

/**
 * Whether two target strings name the same ComfyUI, textual differences aside.
 *
 * The comparison CANNOT be `from !== to` (codex finding). The previous target is
 * seeded from the raw `COMFYUI_URL` the user set, while every retarget event
 * carries the canonical `getComfyUIBaseUrl()` — so booting with a trailing slash,
 * an uppercase host, or an explicit `:80`/`:443` and then reaffirming that very
 * same target reads as a MOVE, and a mid-turn tab gets told its ComfyUI changed
 * when nothing changed. A false nudge costs a real agent turn, so the false
 * direction here is the expensive one.
 *
 * Unparseable input falls back to exact string equality rather than guessing.
 */
function sameTarget(a: string, b: string): boolean {
  if (a === b) return true;
  let ua: URL, ub: URL;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  const norm = (u: URL) => {
    // URL already lowercases host+protocol and folds a default port to "".
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname}:${u.port}${path}`;
  };
  return norm(ua) === norm(ub);
}
