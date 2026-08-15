/**
 * comfyui-mcp-panel#1097 — HOW LONG the panel has been refusing for.
 *
 * The panel refuses commands while it is switching or reloading the canvas
 * workflow, which is right: a command that landed mid-switch could apply to the
 * wrong graph. The orchestrator retries once and then explains, and it already
 * names the stuck case — "a load dialog or an unsaved-changes prompt can hold it
 * open awaiting the user".
 *
 * What it could not say is how long. A switch holding for 200ms and one holding
 * for four minutes produced the identical refusal, ending in "it normally clears
 * in well under a second, so simply retry". The reporter retried, and retried, and
 * the tool never had a way to notice it was telling them to do something that was
 * not working. "Never clears" was invisible to the only thing in a position to see
 * it.
 *
 * The orchestrator sees every one of those refusals, so it can time the RUN of
 * them per tab without the panel changing at all. Nothing here decides anything —
 * no guard is bypassed and no command is retried differently. It only lets the
 * message distinguish "wait a moment" from "this has been held for four minutes,
 * go and look at the canvas".
 */

/** A run of consecutive switch-guard refusals for one tab. */
interface Hold {
  /** When the FIRST refusal of this run was seen — what the age is measured from. */
  since: number;
  /** When the LAST one was. Eviction keys on THIS: a hold that is still being
   *  retried after ten minutes is the most stuck one there is, and evicting it by
   *  start time would reset it to the momentary wording exactly then (codex). */
  last: number;
  /** How many of those runs have ended in a terminal refusal. One per FAILED
   *  CALL, not per panel refusal: each call refuses, settles, retries and refuses
   *  again, so the panel sees roughly twice this (codex review). The message says
   *  "failed calls" because that is the number this counts and the one a caller
   *  can compare against what they did. */
  count: number;
}

const holds = new Map<string, Hold>();

/** A run nobody has touched for this long is over — the tab closed, rebound, or
 *  simply moved on without a routed success to clear it. Without eviction this map
 *  keeps an entry per tab id for the life of the process (codex review), and a
 *  reused id would inherit a stale age. */
const HOLD_TTL_MS = 10 * 60 * 1000;
/** A hard ceiling for the pathological case (many short-lived tab ids). Oldest
 *  runs go first: the freshest are the ones a message could still be built from. */
const MAX_HOLDS = 200;

function evict(now: number): void {
  for (const [tab, hold] of holds) {
    if (now - hold.last > HOLD_TTL_MS) holds.delete(tab);
  }
  if (holds.size <= MAX_HOLDS) return;
  const byAge = [...holds.entries()].sort((a, b) => a[1].last - b[1].last);
  for (const [tab] of byAge.slice(0, holds.size - MAX_HOLDS)) holds.delete(tab);
}

/**
 * Record a switch-guard refusal for `tabId` and return the run so far.
 *
 * `now` is injected so the wording is testable without faking a clock.
 */
export function recordSwitchHold(tabId: string, now: number = Date.now()): Hold {
  evict(now);
  const prev = holds.get(tabId);
  // A clock that jumped backwards must not produce a negative age: restart the run
  // rather than report something that cannot be true.
  const next: Hold =
    prev && now >= prev.since
      ? { since: prev.since, last: now, count: prev.count + 1 }
      : { since: now, last: now, count: 1 };
  holds.set(tabId, next);
  return next;
}

/**
 * Forget a tab's run.
 *
 * Called when a command SUCCEEDS on that tab: the switch cleared, so the next
 * refusal starts a fresh run rather than inheriting an age from an unrelated one.
 * Without this the elapsed time would only ever grow, and a message built on it
 * would eventually be as misleading as no message at all.
 */
export function clearSwitchHold(tabId: string): void {
  holds.delete(tabId);
}

/** Test seam. */
export function switchHoldFor(tabId: string): Hold | undefined {
  return holds.get(tabId);
}

/** Test seam: drop all state between tests. */
export function resetSwitchHolds(): void {
  holds.clear();
}

/**
 * How long a switch has been holding, in words, or "" when it is too brief to be
 * worth saying — which is the common case and must not be cluttered.
 *
 * The threshold is deliberately low: the refusal itself claims a switch "normally
 * clears in well under a second", so anything past a few seconds already
 * contradicts that claim and is worth surfacing.
 */
export function describeSwitchHold(hold: Hold | undefined, now: number = Date.now()): string {
  if (!hold) return "";
  const ms = now - hold.since;
  if (!Number.isFinite(ms) || ms < 3000 || hold.count < 2) return "";
  const secs = Math.round(ms / 1000);
  const howLong = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  // States the OBSERVATION and both explanations, never a verdict (codex review).
  // Elapsed time does not prove a modal: a very large graph, a slow disk or a
  // remote canvas can legitimately switch for longer than this, and telling that
  // user the canvas is "not busy" and that retrying cannot work would be wrong in
  // the one direction that costs them the thing that would have worked.
  return (
    ` THIS HAS BEEN HELD FOR ${howLong} across ${hold.count} failed calls, which is longer than a ` +
    `switch usually takes. Two things look like this: it may still be loading — a very large ` +
    `graph, a slow disk, a remote canvas — or it may be held open by something on the ComfyUI ` +
    `tab awaiting a person, such as a load dialog or an unsaved-changes prompt. Retrying clears ` +
    `the first and never the second, so if it keeps growing, look at the canvas.`
  );
}

/**
 * Is this command one the switch guard would refuse — i.e. does its success prove
 * the switch has cleared?
 *
 * Two review rounds pulled in opposite directions and this is what they agree on.
 * Clearing on EVERY routed success let an unguarded status read wipe the evidence
 * while graph commands stayed refused (round 2). Clearing only on the retry of a
 * switch refusal left a stale run behind after an ordinary first-attempt success,
 * so a later, unrelated switch inherited its age and was announced as stuck
 * immediately (round 4).
 *
 * The panel refuses "every graph and workflow executor" while switching — that is
 * the domain, and the success of one of those is exactly the evidence that the
 * switch is over.
 */
export function successProvesSwitchCleared(cmd: unknown): boolean {
  const name = typeof cmd === "string" ? cmd : undefined;
  return typeof name === "string" && /^(graph_|workflow_)/.test(name);
}
