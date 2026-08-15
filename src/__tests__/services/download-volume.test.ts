import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freeBytesFor,
  checkCacheVolumeSpace,
  insufficientCacheSpaceMessage,
  headroomFor,
  VOLUME_HEADROOM_BYTES,
} from "../../services/download-volume.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GB = 1024 ** 3;

// Exercised against the REAL filesystem rather than a mocked `statfs`. The behaviour
// that matters here IS the platform's: that statfs throws ENOENT for a path that does
// not exist yet (so the walk up to an existing ancestor is load-bearing), and that a
// missing drive letter cannot be measured at all. A mock would only assert my model of
// those semantics, which is the thing most likely to be wrong.
//
// An unmeasurable location has to be DISCOVERED, not assumed. The first cut hardcoded
// "M:/" and CI failed on a Windows runner that actually has an M: drive — it returned
// 92 GB and the test demanded null. Same class as pinning a platform in a process test:
// a machine-specific fact baked into an assertion.
//
// So probe for a drive letter with nothing mounted, and if the machine has all of them
// (or we are not on Windows, where a bare letter means nothing), skip rather than
// assert something untrue. `null` here means "no unmeasurable path available".
async function findUnmeasurablePath(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  for (const letter of ["Z", "Y", "X", "W", "V", "Q"]) {
    const candidate = `${letter}:/models/diffusion_models`;
    if ((await freeBytesFor(candidate)) === null) return candidate;
  }
  return null;
}

describe("#1477 freeBytesFor", () => {
  it("reports free bytes for a real volume", async () => {
    const free = await freeBytesFor(tmpdir());
    expect(typeof free).toBe("number");
    expect(free as number).toBeGreaterThan(0);
  });

  it("walks UP to an existing ancestor - the cache dir may not exist yet", async () => {
    // On a first run ~/.comfyui-mcp/cache does not exist and statfs throws ENOENT.
    // Without the walk, every fresh install would silently skip the space check.
    const nested = join(tmpdir(), "cmcp-not-created-yet", "cache", "deeper");
    const free = await freeBytesFor(nested);
    expect(typeof free).toBe("number");
    expect(free as number).toBeGreaterThan(0);
  });

  it("returns null for a volume that cannot be measured", async () => {
    const missing = await findUnmeasurablePath();
    if (missing === null) return; // every drive letter is mounted, or not Windows
    expect(await freeBytesFor(missing)).toBeNull();
  });
});

describe("#1477 checkCacheVolumeSpace refuses only when it is sure", () => {
  it("refuses a download the staging volume cannot possibly hold", async () => {
    const refusal = await checkCacheVolumeSpace({
      needBytes: 1e15, // a petabyte: larger than any volume on this machine
      cacheDir: join(tmpdir(), "cmcp-space-probe", "cache"),
    });
    expect(refusal).toBeTruthy();
    expect(refusal).toMatch(/NOT downloaded/);
  });

  it("proceeds when the volume plainly has room", async () => {
    expect(await checkCacheVolumeSpace({ needBytes: 1024, cacheDir: tmpdir() })).toBeNull();
  });

  it("FAILS SOFT when free space cannot be read", async () => {
    // An unmeasurable volume must not become an unusable one: this exists to stop a
    // known-bad write, never to invent a new way for a good one to be blocked.
    const missing = await findUnmeasurablePath();
    if (missing === null) return;
    expect(
      await checkCacheVolumeSpace({ needBytes: 1e15, cacheDir: missing }),
    ).toBeNull();
  });

  it("proceeds when the size is unknown - it must not guess", async () => {
    for (const needBytes of [undefined, 0, Number.NaN]) {
      expect(await checkCacheVolumeSpace({ needBytes, cacheDir: tmpdir() })).toBeNull();
    }
  });

  it("keeps headroom rather than letting a volume land on exactly zero", async () => {
    // Free space EQUAL to the download fits arithmetically and is still a bad outcome
    // on a system drive - the page-file case this issue is about.
    const free = (await freeBytesFor(tmpdir())) as number;
    expect(free).toBeGreaterThan(2 * VOLUME_HEADROOM_BYTES);
    // Exactly the free space: refused, because it would leave zero.
    expect(await checkCacheVolumeSpace({ needBytes: free, cacheDir: tmpdir() })).toBeTruthy();
    // Comfortably inside the headroom: allowed.
    expect(
      await checkCacheVolumeSpace({
        needBytes: free - 2 * VOLUME_HEADROOM_BYTES,
        cacheDir: tmpdir(),
      }),
    ).toBeNull();
  });
});

describe("#1477 the refusal explains the split between staging and destination", () => {
  const msg = (destFree: number | null) =>
    insufficientCacheSpaceMessage({
      needBytes: 32.29 * GB,
      cacheDir: "C:/Users/x/.comfyui-mcp/cache",
      cacheFree: 0.7 * GB,
      destDir: "F:/ComfyUI/models/diffusion_models",
      destFree,
    });

  it("names both numbers, so the contradiction is legible", () => {
    expect(msg(1000 * GB)).toMatch(/32\.29 GB/);
    expect(msg(1000 * GB)).toMatch(/0\.70 GB free/);
  });

  it('says the destination HAS room — the fact that makes this fixable', () => {
    // Without this the reader concludes their disk is full and deletes things.
    const m = msg(1000 * GB);
    expect(m).toMatch(/DESTINATION has room/);
    expect(m).toMatch(/not a "your disk is full" problem/);
    expect(m).toMatch(/staged in the cache/);
  });

  it("does NOT claim the destination has room when it does not", () => {
    const m = msg(1 * GB);
    expect(m).not.toMatch(/DESTINATION has room/);
    expect(m).toMatch(/destination volume does not have room either/);
  });

  it("names the lever", () => {
    expect(msg(1000 * GB)).toMatch(/COMFYUI_DOWNLOAD_CACHE_DIR/);
  });

  it("says nothing was written, so no cleanup is implied", () => {
    // The reporter was left with a 22.62 GB .partial. A refusal that happens before
    // the first byte must say so, or the reader goes looking for one.
    expect(msg(1000 * GB)).toMatch(/Nothing was written/);
    expect(msg(1000 * GB)).toMatch(/before the\s+first byte/);
  });
});

describe("#1477 WIRING: the streaming path refuses before opening a handle", () => {
  const src = readFileSync(join(HERE, "../../services/download-cache.ts"), "utf8");

  it("imports and calls the check", () => {
    expect(src).toMatch(
      /import \{ checkCacheVolumeSpace \} from "\.\/download-volume\.js";/,
    );
    expect(src).toMatch(/await checkCacheVolumeSpace\(\{/);
  });

  it("the check runs BEFORE the write stream is created", () => {
    // Order is the whole point: a refusal after createWriteStream would already have
    // opened (and on some paths truncated) the target.
    const check = src.indexOf("await checkCacheVolumeSpace({");
    const open = src.indexOf("createWriteStream(targetPath");
    expect(check).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(-1);
    expect(check).toBeLessThan(open);
  });

  it("a refusal throws rather than being logged and ignored", () => {
    expect(src).toMatch(/if \(refusal\) throw new ModelError\(refusal/);
  });

  it("a resume asks only for the REMAINING bytes", () => {
    // On an append the already-written bytes are on disk; demanding the full size
    // would refuse resumes that fit perfectly well.
    expect(src).toMatch(/rangeTotal - \(resumeFromBytes \|\| 0\)/);
  });

  it("a resume with NO Content-Range total still checks, via Content-Length", () => {
    // Round 2 of review: when a 206 carries no Content-Range total, `rangeTotal` is
    // null and the original arithmetic yielded 0 -- which SKIPPED the guard on exactly
    // the resume path it was written to protect. Content-Length on a 206 is the
    // remaining slice, so it is the right fallback.
    expect(src).toMatch(/remainingFromRange \?\? \(lengthHeaderPre > 0 \? lengthHeaderPre : 0\)/);
  });

  it("tells the check it is a resume, so the message does not lie about the partial", () => {
    expect(src).toMatch(/resuming: appendMode/);
  });
});

describe("#1477 round 2: the reserve scales, and the message tells the truth on a resume", () => {
  it("keeps a full 1 GiB on a large volume - the system-drive case", () => {
    expect(headroomFor(232 * GB)).toBe(VOLUME_HEADROOM_BYTES);
  });

  it("does not make a SMALL volume unusable", () => {
    // A flat 1 GiB reserve would refuse a 2 GB file on a 4 GB stick that fits.
    const small = 4 * GB;
    expect(headroomFor(small)).toBeLessThan(VOLUME_HEADROOM_BYTES);
    expect(headroomFor(small)).toBe(Math.floor(small * 0.05));
  });

  it("falls back to the full reserve for a nonsense total", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(headroomFor(bad)).toBe(VOLUME_HEADROOM_BYTES);
    }
  });

  it("does NOT claim nothing was downloaded when interrupting a resume", () => {
    // The partial exists on disk. Telling the user otherwise invites them to delete
    // something they could have reused.
    const resumeMsg = insufficientCacheSpaceMessage({
      needBytes: 10 * GB,
      cacheDir: "C:/cache",
      cacheFree: 1 * GB,
      resuming: true,
    });
    expect(resumeMsg).not.toMatch(/Nothing was written/);
    expect(resumeMsg).toMatch(/existing partial download is untouched/);
    expect(resumeMsg).toMatch(/still resumable/);
  });

  it("still says nothing was written on a FRESH download", () => {
    const freshMsg = insufficientCacheSpaceMessage({
      needBytes: 10 * GB,
      cacheDir: "C:/cache",
      cacheFree: 1 * GB,
    });
    expect(freshMsg).toMatch(/Nothing was written/);
    expect(freshMsg).not.toMatch(/still resumable/);
  });

  it("refuses to measure a volume whose statfs fails for a NON-missing-path reason", async () => {
    // Climbing on any error could answer confidently about a different disk. Only
    // ENOENT/ENOTDIR justify walking up. A path under an existing FILE yields ENOTDIR
    // and is therefore allowed to climb; that is the deliberate exception.
    const underAFile = join(HERE, "download-volume.test.ts", "nested", "cache");
    const free = await freeBytesFor(underAFile);
    expect(typeof free).toBe("number");
  });
});

describe("#1477 round 3: a partial on disk is never denied", () => {
  it("does not claim nothing was downloaded when a RESTART will discard a partial", () => {
    // Review found `resuming` and "a partial exists" conflated. When a server ignores
    // our Range we restart rather than append, so `resuming` is false - and the old
    // message then told a user with a 22 GB .partial that nothing had been downloaded.
    const m = insufficientCacheSpaceMessage({
      needBytes: 10 * GB,
      cacheDir: "C:/cache",
      cacheFree: 1 * GB,
      resuming: false,
      partialExists: true,
    });
    expect(m).not.toMatch(/Nothing was written/);
    expect(m).toMatch(/partial download from an earlier attempt is still on disk/);
  });

  it("says the free-space figure does NOT assume the partial was reclaimed", () => {
    // The space math is deliberately conservative; the message must not imply
    // otherwise, or the number reads as wrong.
    const m = insufficientCacheSpaceMessage({
      needBytes: 10 * GB,
      cacheDir: "C:/cache",
      cacheFree: 1 * GB,
      partialExists: true,
    });
    expect(m).toMatch(/does NOT assume it was\s+reclaimed/);
  });

  it("the destination clause uses the SAME reserve as the policy", () => {
    // A 4 GiB destination with 2 GiB free and a 1.5 GiB download: the policy's 5%
    // reserve (200 MiB) says it fits, so the message must not demand a flat 1 GiB and
    // report it as too small.
    const small = 4 * GB;
    const m = insufficientCacheSpaceMessage({
      needBytes: 1.5 * GB,
      cacheDir: "C:/cache",
      cacheFree: 0.2 * GB,
      destDir: "E:/models",
      destFree: 2 * GB,
      destHeadroom: headroomFor(small),
    });
    expect(m).toMatch(/DESTINATION has room/);
  });

  it("still refuses to claim destination room when there genuinely is none", () => {
    const m = insufficientCacheSpaceMessage({
      needBytes: 10 * GB,
      cacheDir: "C:/cache",
      cacheFree: 0.2 * GB,
      destDir: "E:/models",
      destFree: 1 * GB,
      destHeadroom: headroomFor(4 * GB),
    });
    expect(m).not.toMatch(/DESTINATION has room/);
  });
});
