// #952 (panel) — an interactive question card was told to go and check the
// render queue.
//
// `panel_ask` was interrupted by a tab disconnect, and the OUTCOME UNKNOWN error
// ended with the only remedy this path has ever offered:
//
//   Verify before retrying (e.g. check queue action:"list" /
//   get_image (action:"list_outputs")) instead of re-issuing it blindly.
//
// The reporter's objection is exact: "The suggested verification examples concern
// render queues/media and do not apply to an ask card." Neither of those tools
// can tell you whether a question is currently on a human's screen.
//
// WHY THIS IS NOT COSMETIC. The panel-side trace on that issue established that
// for THIS trigger a blind retry really does duplicate the card: the dedupe
// ledger is keyed by the socket's bridge epoch, a reconnect mints a new one, so
// the retry lands in a different scope, `lookupRetry` misses, and it fails open
// and re-executes. Failing open is right for a read or an idempotent write —
// re-running one is cheaper than refusing. It is wrong for a question, because
// the cost is a second card in front of a person and there is no way to withdraw
// the first.
//
// So the remedy has to say what actually applies. What it must NOT do is invent
// a recovery: there is no pending-card query today, and `retry_of` does not help
// across a reconnect for the reason above. Both of those are open design
// questions on the issue and this does not pre-empt them.

/** Panel commands that put something in front of a HUMAN and wait. */
const INTERACTIVE_COMMANDS = new Set(["ask_user", "request_secret"]);

export function isInteractiveCommand(cmd: string): boolean {
  return INTERACTIVE_COMMANDS.has(String(cmd ?? "").trim());
}

/**
 * The "verify before retrying" clause, chosen by what the command actually did.
 *
 * Two kinds, because they have different evidence and different costs:
 *
 *  • an INTERACTIVE card — nothing in the tool surface can observe it, and a
 *    the answer to it will NEVER arrive (the panel refuses to replay a reply of
 *    this kind across a reconnect), and a retry duplicates the card. Say all
 *    three, and give the route that works — which differs for a secret.
 *  • anything else — the existing queue/output check, which is real evidence for
 *    a run or a write.
 */
export function midCommandVerifyClause(cmd: string): string {
  if (isInteractiveCommand(cmd)) {
    // WAITING IS NOT A RECOVERY, and an earlier draft of this said it was
    // (codex). Checked against the panel: `redactSensitiveReply` replaces an
    // `ask_user`/`request_secret` reply that cannot cross the dropped connection
    // with a payload-free failure — deliberately, because the content is the
    // user's own input and a replay could land on a different orchestrator. Its
    // own words are "ask again on the current connection". So the answer to the
    // card already on screen will NOT reach you, however long you wait.
    const reissue =
      cmd === "request_secret"
        ? // NEVER route a secret through the conversation (codex). The whole
          // point of this card is a masked input the agent never sees and that
          // is never written to chat history; "just ask them for it" would
          // defeat the guarantee the tool makes.
          `Re-issue panel_request_secret on the current connection — that is what the panel itself ` +
          `advises, and it is the ONLY safe route: never ask the user to paste a secret into the ` +
          `conversation, where you would see it and it would be recorded.`
        : `Re-issue the question on the current connection, or simply ask it in conversation.`;
    return (
      `Nothing in the tool surface can check that — ` +
      `there is no pending-card query — and the answer to it will NOT reach you: the panel ` +
      `deliberately does not replay a reply of this kind across a reconnect (nothing was applied ` +
      `and nothing was stored). ${reissue} Expect the stale card to remain on screen: retry ` +
      `suppression is keyed to the socket that dropped, so this counts as a new command and the ` +
      `user may see two. Tell them which one to answer.`
    );
  }
  return (
    `Verify before retrying (e.g. check queue action:"list" / get_image (action:"list_outputs")) ` +
    `instead of re-issuing it blindly.`
  );
}

/** The full OUTCOME UNKNOWN sentence for a mid-command disconnect. */
export function midCommandDisconnectMessage(opts: { short: string; cmd: string }): string {
  const interactive = isInteractiveCommand(opts.cmd);
  const applied = interactive
    ? `the command was already sent, so the card may already be on screen`
    : `the command was already sent, so the panel may have applied it (for a run, ComfyUI may already be rendering)`;
  return (
    `panel tab ${opts.short} disconnected mid-command ("${opts.cmd}") — OUTCOME UNKNOWN: ` +
    `${applied}. ${midCommandVerifyClause(opts.cmd)}`
  );
}
