// #1152 — the temp localImage was deleted before Codex read it.
//
// A reporter saw the panel render a storyboard while the SAME turn reported:
//
//   Codex could not read the local image at …\comfyui-codex-<pid>-…png:
//   The system cannot find the file specified. (os error 2)
//
// The turn's finally block deleted the file immediately, on a comment asserting
// "the bytes were read at turn/start". The app-server can defer that read, so
// the delete raced it. Reproduced on two storyboards and a PreviewImage result.
//
// There is no "image consumed" signal in the protocol, so the fix is a grace
// window rather than a handshake — and the invariant that matters is that the
// window is a DELAY, never the only thing preventing a leak: close() still
// sweeps every tracked file.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
let CodexBackend: BackendModule["CodexBackend"];

beforeAll(async () => {
  vi.resetModules();
  ({ CodexBackend } = await import("../../orchestrator/codex-backend.js"));
});

let dir: string;

/** Advance past the grace window AND let the real fs.unlink I/O settle — fake
 *  timers fire the callback but do not await the promise it starts. */
async function elapseGraceWindow(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
  vi.useRealTimers();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

afterEach(() => {
  vi.useRealTimers();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A backend with two tracked temp files on disk, reaching the private members
 *  the way the turn loop does. */
function backendWithTempFiles(): { be: any; files: string[] } {
  dir = mkdtempSync(join(tmpdir(), "codex-temp-"));
  const files = ["a.png", "b.png"].map((n) => join(dir, n));
  for (const f of files) writeFileSync(f, "x");
  const be = new CodexBackend({} as never) as any;
  for (const f of files) be.tempImageFiles.add(f);
  return { be, files };
}

describe("temp localImage files survive the turn (#1152)", () => {
  it("does NOT delete them when the turn ends", async () => {
    // REAL timers on purpose. Under fake timers this passes even with a ZERO
    // grace window, because nothing advances the clock — the test would claim to
    // pin the fix while a reverted constant sailed through it. Caught by
    // mutating TEMP_IMAGE_GRACE_MS to 0 and watching this go green.
    const { be, files } = backendWithTempFiles();

    be.scheduleTempImageCleanup(files);
    // Long enough that a 0ms timer would have fired AND its unlink completed.
    await new Promise((r) => setTimeout(r, 120));

    // The race the reporter hit: at this instant Codex may not have read them.
    for (const f of files) expect(existsSync(f)).toBe(true);
  });

  it("uses a grace window measured in minutes, not milliseconds", () => {
    // The duration is the fix. A window short enough to still race a deferred
    // read is the bug wearing the fix's shape.
    const be = new CodexBackend({} as never) as any;
    const grace = (be.constructor as { TEMP_IMAGE_GRACE_MS: number }).TEMP_IMAGE_GRACE_MS;
    expect(grace).toBeGreaterThanOrEqual(60_000);
  });

  it("deletes them once the grace window elapses", async () => {
    vi.useFakeTimers();
    const { be, files } = backendWithTempFiles();

    be.scheduleTempImageCleanup(files);
    await elapseGraceWindow();

    for (const f of files) expect(existsSync(f)).toBe(false);
    // And they leave tracking, so close() has nothing stale to re-sweep.
    expect(be.tempImageFiles.size).toBe(0);
  });

  it("keeps them TRACKED while the window is open, so close() still sweeps", async () => {
    // The invariant: the grace window is a delay, not the sole guard against a
    // leak. A process that exits mid-window must not strand files.
    vi.useFakeTimers();
    const { be, files } = backendWithTempFiles();

    be.scheduleTempImageCleanup(files);
    expect(be.tempImageFiles.size).toBe(2);

    await be.cleanupTempImages([...be.tempImageFiles]);
    for (const f of files) expect(existsSync(f)).toBe(false);
  });

  it("unrefs the timer so a pending window cannot hold the process open", () => {
    vi.useFakeTimers();
    const { be, files } = backendWithTempFiles();
    be.scheduleTempImageCleanup(files);
    const [timer] = [...be.tempImageTimers];
    expect(timer).toBeDefined();
    // vitest's fake timer objects expose hasRef() like Node's.
    if (typeof timer.hasRef === "function") expect(timer.hasRef()).toBe(false);
  });

  it("survives a file that is already gone", async () => {
    vi.useFakeTimers();
    const { be, files } = backendWithTempFiles();
    rmSync(files[0], { force: true });

    be.scheduleTempImageCleanup(files);
    await elapseGraceWindow();

    expect(existsSync(files[1])).toBe(false);
    expect(be.tempImageFiles.size).toBe(0);
  });
});
