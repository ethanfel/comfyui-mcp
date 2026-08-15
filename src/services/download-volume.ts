/**
 * #1477 — a download filled the SYSTEM drive and would have driven it to zero.
 *
 * `download_model` stages the whole file in the content-addressed cache before it
 * lands at its destination, and the cache path comes only from `homedir()`:
 *
 *   const DEFAULT_CACHE_DIR = join(homedir(), ".comfyui-mcp", "cache");
 *
 * On Windows `homedir()` is essentially always the system drive, while ComfyUI models
 * are almost always on a big secondary volume. The reporter's ComfyUI lives on `F:`
 * with 1 TB free; `C:` had 0.7 GB free of 232 GB. A 32.29 GB download to the roomy
 * volume was written to the full one, and the `.partial` reached 22.62 GB before it
 * died.
 *
 * ## Why this is worse than a failed download
 *
 * Taking a Windows system drive to zero risks the page file and general OS stability,
 * not just this transfer. The failure is not confined to the thing that failed.
 *
 * ## What this module does, and deliberately does not do
 *
 * It REFUSES up front when the staging volume cannot hold what we already know is
 * coming — `Content-Length` is parsed before the first byte is written, so the check
 * costs nothing and needs no new network work.
 *
 * It does NOT relocate the cache. Choosing a staging directory on the destination
 * volume is the deeper fix the reporter also asks for, and it changes where files
 * land, how the cache is addressed, and whether the final move is a rename or a copy.
 * That deserves its own change. Refusing before the disk fills is the part that stops
 * the harm, and it is the part that can be made safe now.
 *
 * Every check here FAILS SOFT. If free space cannot be measured, the download proceeds
 * exactly as before: this exists to prevent a known-bad write, never to invent a new
 * way for a good one to be blocked.
 */

import { statfs } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

/**
 * Free bytes on the volume holding `path`, or `null` when it cannot be determined.
 *
 * `statfs` throws ENOENT for a path that does not exist yet, and the cache directory
 * routinely does not on a first run — so walk up to the nearest existing ancestor,
 * which is on the same volume by construction. Give up at the filesystem root rather
 * than looping.
 */
export async function volumeSpaceFor(
  path: string,
): Promise<{ free: number; total: number } | null> {
  let dir = resolve(path);
  const { root } = parse(dir);
  for (;;) {
    try {
      const st = await statfs(dir);
      const free = Number(st.bsize) * Number(st.bavail);
      const total = Number(st.bsize) * Number(st.blocks);
      return Number.isFinite(free) && free >= 0 ? { free, total } : null;
    } catch (err) {
      // Climb ONLY for "this path does not exist yet", which is the case that makes
      // the walk necessary at all (a first run has no cache directory). Review
      // caught the original catch-all: on a junction, mount point or network share
      // whose statfs fails for PERMISSION or transport reasons, climbing would
      // silently measure a DIFFERENT volume and answer confidently about the wrong
      // disk -- which could permit the very overflow this exists to stop.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(dir);
      // `dirname` of a root returns the root: that is the stop condition, and without
      // it a missing drive letter would spin forever.
      if (parent === dir || dir === root) return null;
      dir = parent;
    }
  }
}

export async function freeBytesFor(path: string): Promise<number | null> {
  return (await volumeSpaceFor(path))?.free ?? null;
}

/** Bytes left free after a download, below which we refuse to start it.
 *
 *  Not zero: landing a volume on exactly 0 free is its own failure, and on the system
 *  drive it is the page-file case this issue is about. One GiB is small enough not to
 *  block a legitimate tight-but-workable download and large enough to leave the OS
 *  somewhere to breathe. */
export const VOLUME_HEADROOM_BYTES = 1024 ** 3;

/**
 * The reserve to keep free on a volume of `total` bytes.
 *
 * A flat 1 GiB is right for the case this issue is about -- a 232 GB system drive
 * whose page file needs somewhere to live -- and wrong for a small or removable
 * volume, where it would refuse a download that fits comfortably. Review flagged
 * exactly that. So the reserve is the SMALLER of 1 GiB and 5% of the volume, which
 * leaves the system-drive protection untouched and stops a 4 GB stick being declared
 * unusable for a 2 GB file.
 */
export function headroomFor(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return VOLUME_HEADROOM_BYTES;
  return Math.min(VOLUME_HEADROOM_BYTES, Math.floor(total * 0.05));
}

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(2)} GB`;

/**
 * The refusal for a download whose staging volume cannot hold it.
 *
 * `destFree` is the free space on the DESTINATION volume when that is a different
 * volume from the cache. When the destination has room and the cache does not, that
 * is the whole story and the message says so — it turns a fatal error into one
 * setting.
 */
export function insufficientCacheSpaceMessage(opts: {
  needBytes: number;
  cacheDir: string;
  cacheFree: number;
  destDir?: string;
  destFree?: number | null;
  /** Reserve applied to the DESTINATION volume, so this clause agrees with policy. */
  destHeadroom?: number;
  /** True when this refusal interrupts a RESUME (appending to a partial). */
  resuming?: boolean;
  /** True when a .partial exists on disk AT ALL — including a restart that is about
   *  to discard it. Distinct from `resuming`: review found the two conflated, so a
   *  restart-after-a-rejected-Range wrongly claimed nothing had been downloaded. */
  partialExists?: boolean;
}): string {
  const {
    needBytes,
    cacheDir,
    cacheFree,
    destDir,
    destFree,
    resuming = false,
    partialExists = false,
  } = opts;
  // The SAME reserve the policy applies, not the flat one: review found the message
  // demanding 1 GiB of the destination while `checkCacheVolumeSpace` would have
  // accepted a 5% reserve, so a destination that fits could be reported as too small.
  // A remediation hint that contradicts the policy is worse than no hint.
  const destHasRoom =
    typeof destFree === "number" && destFree >= needBytes + (opts.destHeadroom ?? VOLUME_HEADROOM_BYTES);

  const head =
    `NOT downloaded: this needs ${gb(needBytes)} of staging space and the download ` +
    `cache volume has ${gb(cacheFree)} free (${cacheDir}).`;

  // The single most useful fact, when it is true: the file was always going somewhere
  // that fits, and only the staging location does not.
  const split = destHasRoom
    ? ` The DESTINATION has room — ${gb(destFree as number)} free at ${destDir} — so ` +
      `this is not a "your disk is full" problem: the model is staged in the cache ` +
      `BEFORE it lands, and the cache is on a different volume.`
    : destDir && typeof destFree === "number"
      ? ` The destination volume does not have room either (${gb(destFree)} free at ` +
        `${destDir}), so a different cache location alone will not resolve this.`
      : "";

  // Review caught this claiming too much: the check also runs on a RESUME, where a
  // .partial already exists on disk. Telling that user "nothing was downloaded" is
  // false and invites them to delete a partial they could have reused.
  const state = resuming
    ? ` Your existing partial download is untouched and still resumable — this ` +
      `refusal happens before any further bytes are written.`
    : partialExists
      ? ` A partial download from an earlier attempt is still on disk; this refusal ` +
        `happens before any further bytes are written, so it is unchanged. Freeing ` +
        `space may require removing it, and the figure above does NOT assume it was ` +
        `reclaimed.`
      : ` Nothing was written and nothing was partially downloaded — this refusal ` +
        `happens before the first byte, precisely so a full volume is not driven to ` +
        `zero (#1477).`;
  const fix =
    ` Point the cache at a volume with room by setting COMFYUI_DOWNLOAD_CACHE_DIR ` +
    `(for example to a directory beside your models), then retry.` + state;

  return head + split + fix;
}

/**
 * Decide whether staging `needBytes` at `cacheDir` is safe. Returns a refusal string,
 * or `null` to proceed.
 *
 * Proceeds when the size is unknown or free space cannot be read: an unmeasurable
 * volume must not become an unusable one.
 */
export async function checkCacheVolumeSpace(opts: {
  needBytes: number | undefined;
  cacheDir: string;
  destDir?: string;
  resuming?: boolean;
  partialExists?: boolean;
}): Promise<string | null> {
  const { needBytes, cacheDir, destDir, resuming, partialExists } = opts;
  if (!needBytes || !Number.isFinite(needBytes) || needBytes <= 0) return null;
  const space = await volumeSpaceFor(cacheDir);
  if (space === null) return null;
  const headroom = headroomFor(space.total);
  if (space.free >= needBytes + headroom) return null;
  const destSpace = destDir ? await volumeSpaceFor(destDir) : null;
  const destFree = destSpace?.free ?? null;
  return insufficientCacheSpaceMessage({
    needBytes,
    cacheDir,
    cacheFree: space.free,
    destDir,
    destFree,
    destHeadroom: destSpace ? headroomFor(destSpace.total) : undefined,
    resuming,
    partialExists,
  });
}

/*
 * DELIBERATELY CONSERVATIVE: a restart that is about to truncate a stale .partial
 * will reclaim its bytes, and crediting them here would let a few more downloads
 * through. It is not done, because the truncation happens on two different paths —
 * one BEFORE the request (a declined full response) and one at the write flags AFTER
 * this check — and on the first of those the space is already free, so crediting it
 * would DOUBLE-COUNT and permit exactly the overflow this module exists to stop.
 *
 * The two error directions are not symmetric. A false refusal costs one retry after
 * setting COMFYUI_DOWNLOAD_CACHE_DIR; a false allow costs the system drive. Until the
 * ordering is established by measurement rather than by reading, this stays on the
 * side that cannot cause the harm — and the message above says plainly that the
 * figure does not assume the partial was reclaimed, so the number is never misread.
 */
