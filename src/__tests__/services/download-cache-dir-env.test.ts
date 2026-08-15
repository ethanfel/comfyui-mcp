// #1526 — `COMFYUI_DOWNLOAD_CACHE_DIR` was the last install-path env var read raw.
//
// THE ISSUE I FILED WAS MOSTLY WRONG, and the correction is the useful part of it.
// I claimed `COMFYUI_MCP_DATA_DIR` had "8 unnormalized path-op reads". All eight
// already normalize (`process.env.COMFYUI_MCP_DATA_DIR?.trim() || …`), as does
// `COMFYUI_MCP_TRAINING_DIR`. I had counted how many places READ the variable and
// reported it as how many read it UNGUARDED — a number asserted without checking
// what it counted. Exactly one reader was genuinely unguarded, and this is it.
//
// The failure it allows is the #1512 shape at a smaller blast radius: `set VAR=
// <path> && <cmd>` bakes a trailing space in on Windows, `resolve()` accepts it,
// and partial downloads land in a directory that is not the configured one — with
// nothing checking the result against intent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ORIGINAL = process.env.COMFYUI_DOWNLOAD_CACHE_DIR;

/** Rebuild the module so the env is read fresh, the way a real process reads it. */
async function cacheDirFor(raw: string | undefined): Promise<string> {
  vi.resetModules();
  if (raw === undefined) delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  else process.env.COMFYUI_DOWNLOAD_CACHE_DIR = raw;
  const mod = (await import("../../services/download-cache.js")) as {
    __downloadCacheTestHooks?: { cacheDir(): string };
  };
  // Exposed for this test; falls back to probing the public surface if absent.
  const hooks = mod.__downloadCacheTestHooks;
  if (!hooks) throw new Error("download-cache does not expose cacheDir for testing");
  return hooks.cacheDir();
}

beforeEach(() => {
  delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.COMFYUI_DOWNLOAD_CACHE_DIR;
  else process.env.COMFYUI_DOWNLOAD_CACHE_DIR = ORIGINAL;
  vi.resetModules();
});

describe("COMFYUI_DOWNLOAD_CACHE_DIR is normalized (#1526)", () => {
  it("drops the trailing space a Windows launcher line bakes in", async () => {
    const clean = await cacheDirFor("D:\\cache\\comfy");
    const dirty = await cacheDirFor("D:\\cache\\comfy ");
    expect(dirty).toBe(clean);
  });

  it("unwraps a pasted quote pair", async () => {
    const clean = await cacheDirFor("D:\\cache\\comfy");
    expect(await cacheDirFor('"D:\\cache\\comfy"')).toBe(clean);
  });

  it("treats a whitespace-only value as unset, not as a path", async () => {
    // Adopting "   " would be worse than the bug: it defeats the default AND
    // cannot work. The helper maps it to undefined so the default is used.
    expect(await cacheDirFor("   ")).toBe(await cacheDirFor(undefined));
  });

  it("leaves a clean value exactly as given", async () => {
    const p = "/srv/comfy-cache";
    expect(await cacheDirFor(p)).toBe(resolve(p));
  });

  it("does not redirect a directory that REALLY ends in a space", async () => {
    // The non-destructive property of the #1512 helper, and it has to be proven
    // against a directory that EXISTS. An earlier version of this test named a
    // path with no such directory and accepted either result — so an
    // unconditional trim passed it. Review caught that; it asserted nothing.
    //
    // A user with a cache root legitimately ending in a space must keep it: the
    // alternative is silently relocating their cache and stranding every partial
    // already on disk, which is the #1512 reporter's 11.35 GB in a new costume.
    const base = mkdtempSync(join(tmpdir(), "cachedir-"));
    const spaced = join(base, "cache ");
    mkdirSync(spaced);
    try {
      expect(await cacheDirFor(spaced)).toBe(resolve(spaced));
      // ...and the trimmed sibling, which does NOT exist, is still repaired.
      expect(await cacheDirFor(join(base, "gone "))).toBe(resolve(join(base, "gone")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
