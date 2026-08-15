/**
 * #1471 — "restart to pick it up" named a restart that does not pick it up.
 *
 * An npx-mode update check reported `{ mode: "npx", from: 0.51.15, to: 0.51.16,
 * note: "npx fetches the latest on next run; restart to pick it up" }`. The user did
 * exactly that — the panel's `/restart` — confirmed it, and the status check still read
 * 0.51.15 out of the same `_npx` package dir.
 *
 * The note is not wrong about npx. It is wrong about WHICH restart, and that is the
 * whole of the defect: the panel's restart controls do not restart the long-lived
 * orchestrator process. That process is the one running this code, and it keeps the
 * build it started with — a fact this repo already states plainly in `panel_reload`'s
 * own description ("does NOT reload the long-lived orchestrator process that serves
 * every panel_* tool ... only the user can restart it"). The self-update note simply
 * said "restart" and let the reader supply the wrong one.
 *
 * Saying "restart" to someone holding two restart buttons, only one of which works,
 * is the same defect class as naming a check that cannot answer: it reads as
 * actionable and is not.
 */

/**
 * The npx-mode note. `latest` is the version the registry advertises.
 *
 * Deliberately names the restart that does NOT work as well as the one that does —
 * the reporter reached for `/restart` precisely because nothing said it was the wrong
 * lever, and a note that only names the right one still leaves them to discover that
 * the obvious button did nothing.
 */
export function npxUpdateNote(latest: string): string {
  return (
    `${latest} available — on its next launch npx will TRY to resolve the latest ` +
    `version, so the update can only arrive when this server process is started ` +
    `again. The panel's /restart and panel_reload do NOT do that: they restart ` +
    `ComfyUI and the agent, not the long-lived orchestrator process serving these ` +
    `tools, which keeps the build it started with (#1471). Stop that process and ` +
    `start it again with the SAME command that launched it — whatever that was; if ` +
    `it named a version (comfyui-mcp@X) keep that, because changing it here would ` +
    `silently undo a pin you chose. Then re-check with self_update_action:"status". ` +
    `If currentVersion is unchanged the new build is NOT running, but that alone ` +
    `does not say why — a restart that never reached this process, a deliberate ` +
    `version pin, and npx's execution cache serving an older copy all look identical ` +
    `from here. If you did restart this process and meant to be on the latest, ` +
    `relaunch once with an explicit comfyui-mcp@latest: that overrides both a pin ` +
    `and a cached copy, which is what makes it the check worth running (note that ` +
    `npm cache clean does NOT clear npx's execution cache — a different cache).`
  );
}
