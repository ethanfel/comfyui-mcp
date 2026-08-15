/**
 * #1479 — `download_model action:"status"` reported PROVEN-dead downloads as
 * "still streaming".
 *
 * After a session drop, three transfers that died with their owning process were
 * rendered as **downloading — still streaming**, with a note saying "the transfer may
 * still be running … Do not report this download as failed or missing." Nothing was
 * writing them: no `.partial`/`.part`/`.tmp` under `models/` or `%TEMP%`, and
 * `~/.comfyui-mcp/download-records/` was empty. `action:"cancel"` on the same ids
 * answered "that session is confirmed GONE — its process no longer exists".
 *
 * ## The evidence was already in the process
 *
 * `writerProcessGone()` settles it by probing the owner pid (ESRCH ⇒ proven dead), but
 * it was only reached from the CANCEL path. The status render branched solely on
 * `staleInflight`, which is heartbeat AGE. So two actions answered the same question
 * from the same process with opposite verdicts — and the wrong one was the one telling
 * the caller not to act.
 *
 * ## What must NOT change
 *
 * The cautious wording is right for a MERELY stale record. #761 established that a
 * reconnect can interrupt persistence, so a missed heartbeat alone does not prove the
 * transfer stopped, and refusing to say so is what keeps a live download from being
 * re-issued underneath itself.
 *
 * This changes only the case where death is PROVEN — the distinction that caution
 * exists to protect. `writerProcessGone` returns `undefined` when it cannot tell (no
 * recorded pid, or the probe itself failed), and `undefined` must keep the caution.
 */

/**
 * The status note for an in-flight record whose writer is gone by the LOCAL pid probe.
 *
 * The probe is `kill(pid, 0)`: ESRCH means no process with that id exists HERE. That is
 * conclusive for the ordinary case (the writer was this machine's own orchestrator) and
 * inconclusive for a writer in another container or on another host, whose pid means
 * nothing locally. Review raised exactly that, and the record carries no host to check
 * it against — so the verdict is scoped to what was measured, and the recovery routes
 * through `cancel` first, and says plainly that cancel shares the same blind spot: it
 * re-runs the SAME local probe, so it cannot see a foreign writer either. Review had to
 * point that out twice before I stopped trying to promise a safe path and simply named
 * the limit. The one outcome worth avoiding is a duplicate transfer into the same
 * destination, so that is what the message tells the reader to rule out.
 *
 * Deliberately states the evidence rather than just the verdict: a caller who was told
 * five seconds ago not to touch this download needs to know why the answer changed.
 */
export function provenDeadStatusNote(opts: {
  staleForMs?: number;
  /** True when the record was a remote ComfyUI-Manager dispatch. */
  viaManager?: boolean;
}): string {
  const { staleForMs, viaManager } = opts;
  const stale =
    typeof staleForMs === "number" && staleForMs > 0
      ? ` Its heartbeat stopped ${Math.round(staleForMs / 1000)}s ago.`
      : "";
  // A Manager dispatch runs SERVER-side, so the local writer being gone says nothing
  // about the host's own fetch — claiming the transfer is dead there would be the same
  // over-reach in the other direction.
  const tail = viaManager
    ? ` This was a remote ComfyUI-Manager dispatch, so the SERVER-side fetch may still ` +
      `be running — only the local record's owner is proven gone. Check ` +
      `list_local_models to see whether the file landed.`
    : ` No local process is writing this file. Close the record with download_model ` +
      `action:"cancel" (this id and tray_id) before re-issuing. Note that cancel uses ` +
      `this SAME local probe, so it cannot see a writer on another host or container ` +
      `either — if this download was started somewhere other than here, confirm it is ` +
      `really stopped at its source before re-issuing, because a duplicate transfer ` +
      `into the same destination is the one outcome worth avoiding.`;
  // The OPENING verdict has to be route-aware too. Saying "this transfer is NOT
  // running" and then admitting the server-side fetch may still be live is the same
  // self-contradiction this issue is about — review caught me writing it into the fix.
  // For a Manager dispatch the pid proves only that the LOCAL record's owner is gone.
  const head = viaManager
    ? `\n    NOTE: the local owner of this record is gone — the process that started ` +
      `it no longer exists (probed by pid), so it died with its session (#1479).`
    : `\n    NOTE: this transfer is NOT running on this machine. No process with its ` +
      `recorded pid exists here, so it died with its session (#1479). That evidence is ` +
      `LOCAL: a writer owned by another host or container would look the same from ` +
      `here, and cancel uses the same probe, so neither can rule that out.`;
  return `${head}${stale}${tail}`;
}

/**
 * Which in-flight note to render.
 *
 * Returns `"proven-dead"` only on a demonstrated death, `"stale"` for a missed
 * heartbeat that proves nothing, and `"none"` otherwise. `provenGone === undefined`
 * is deliberately NOT proven-dead: absence of evidence is not evidence of absence,
 * and the caution is correct there.
 */
export function inflightNoteKind(opts: {
  status?: string;
  staleInflight?: boolean;
  provenGone?: boolean;
}): "proven-dead" | "stale" | "none" {
  const { status, staleInflight, provenGone } = opts;
  if (status !== "downloading") return "none";
  if (provenGone === true) return "proven-dead";
  return staleInflight ? "stale" : "none";
}
