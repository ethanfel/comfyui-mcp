/**
 * #1371 — a model was written into a DIFFERENT local ComfyUI installation than the one
 * serving the session.
 *
 * Connected to ComfyUI on `:8190` (`…\ComfyUI_H3`), the download streamed into
 * `…\ComfyUI\models` — a stale `COMFYUI_PATH` from another install — while visibility
 * was checked against the connected server.
 *
 * ## Why the existing guard did not catch it
 *
 * `model-resolver.ts` has refused divergent destinations since v0.49.4, and the reporter
 * was on 0.50.107 — newer — so the guard was present and did not fire. It proves
 * divergence from CONTENT: files on disk the running server does not list. With a sparse
 * or empty destination category (`vae`, here) there is nothing to compare.
 *
 * ## The evidence used, and one that was REFUTED first
 *
 * A first attempt refused when the destination fell outside the install root the server
 * names for itself. Review knocked that down, correctly: being outside the install root
 * does not mean the server cannot read it. `extra_model_paths.yaml` registers roots
 * elsewhere by design, `<install>/models` is routinely a junction to another drive, and
 * a container-mounted path and its host destination describe one directory through two
 * unrelated strings. #1474 — fixed the same day — is a Comfy Desktop install serving
 * models from a SHARED root outside its install directory; that guard would have refused
 * it outright.
 *
 * The right question is not "is this inside the install" but "does the connected server
 * read this tree", and `isUnderLiveModelRoots` already answers exactly that: it checks
 * the live primary models root AND live-registered extra roots, canonicalizes junctions
 * and symlinks through `realpath`, is category-scoped, and returns `undefined` for
 * UNKNOWN rather than folding it into "no".
 *
 * So this refuses on `inRoots === false` — demonstrably not read — and never on
 * `undefined`. That is the distinction the whole file exists to hold: the surrounding
 * code's own note records that every time "the server did not vouch for it" was treated
 * as "the server cannot read it", it produced another false refusal.
 */

/**
 * The refusal for a destination the connected server demonstrably does not read.
 *
 * `inRoots` comes from `isUnderLiveModelRoots`: `false` means demonstrably outside every
 * tree the live server reads; `undefined` means only local configuration could answer,
 * which proves nothing and must NOT refuse.
 */
export function divergentInstallRefusal(opts: {
  targetDir: string;
  inRoots: boolean | undefined;
  /** The live models root the answer was computed against, when authoritative. */
  liveRoot?: string;
  serverUrl?: string;
}): string | null {
  const { targetDir, inRoots, liveRoot, serverUrl } = opts;
  if (inRoots !== false) return null; // true = fine; undefined = unknown, never refuse
  if (!targetDir) return null;
  const where = liveRoot ? ` It reads models from "${liveRoot}" (and any extra roots it has registered).` : "";
  return (
    `NOT downloaded: the connected ComfyUI${serverUrl ? ` (${serverUrl})` : ""} does not ` +
    `read from "${targetDir}", so a model placed there would never be visible to it.` +
    `${where} This destination came from LOCAL CONFIGURATION — COMFYUI_PATH or the saved ` +
    `default workspace — not from the running server, and a COMFYUI_PATH left over from a ` +
    `different installation is the usual cause (#1371). Nothing was written.\n\n` +
    `This is a demonstrated mismatch, not an unverified one: the destination was checked ` +
    `against the roots the live server actually reads, including any registered through ` +
    `extra_model_paths.yaml, and with junctions and symlinks resolved. Point COMFYUI_PATH ` +
    `at the ComfyUI that is actually running, or launch that server with an absolute ` +
    `--base-directory, then retry. If you MEANT another install, download it there — ` +
    `writing here would report success for a model the connected server can never load.`
  );
}
