import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The PREMISE the #1371 symlink handling rests on, checked against a real filesystem.
 *
 * `isModelFileEntry` accepts symlinks and `entryIsDirectoryLike` follows them because
 * `Dirent.isFile()` and `Dirent.isDirectory()` are both FALSE for a symbolic link —
 * readdir reports the link itself, not its target. Every other test in this area runs
 * against a mocked `node:fs` whose Dirents I wrote, so those tests agree with that belief
 * by construction and cannot contradict it. If Node ever reported otherwise, the fix would
 * be pointless and 92 mocked tests would still pass.
 *
 * This file therefore mocks nothing. It creates real links and asks the real API.
 *
 * Setup runs at MODULE scope rather than in beforeAll so `skipIf` can see the result:
 * a test that returns early is a test that passed, and "skipped because this machine
 * cannot make links" must not look like "the premise holds".
 */
const dir = mkdtempSync(join(tmpdir(), "cmcp-symlink-premise-"));
mkdirSync(join(dir, "real"));
writeFileSync(join(dir, "real", "model.safetensors"), "x");

/** Separate guards, because the two link kinds have different privilege rules on Windows.
 *  A shared try meant one EPERM skipped BOTH — and the directory case, the one the P1 fix
 *  turns on, is exactly the one that does work unprivileged. */
const made = (name: string, target: string, type: "junction" | "file"): boolean => {
  try {
    // "junction" is the one directory-link kind Windows allows without elevation or
    // developer mode; the argument is ignored on POSIX. A FILE symlink is EPERM there
    // unless developer mode is on, so that case really can be unavailable.
    symlinkSync(target, join(dir, name), type);
    return true;
  } catch {
    return false;
  }
};
const dirLinkWorks = made("link-to-dir", join(dir, "real"), "junction");
const fileLinkWorks = made(
  "link-to-model.safetensors",
  join(dir, "real", "model.safetensors"),
  "file",
);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("#1371 — what Node actually reports for a symlink", () => {
  it.skipIf(!dirLinkWorks)("a link to a DIRECTORY is not isDirectory(), and statSync sees through it", () => {
    const entry = readdirSync(dir, { withFileTypes: true }).find((e) => e.name === "link-to-dir");
    expect(entry, "the link should be listed").toBeDefined();
    // The trap. Recursing on isDirectory() alone silently skips a shared model tree.
    expect(entry!.isDirectory()).toBe(false);
    expect(entry!.isSymbolicLink()).toBe(true);
    // ...and the escape hatch the fix uses: stat follows the link.
    expect(statSync(join(dir, "link-to-dir")).isDirectory()).toBe(true);
  });

  it.skipIf(!fileLinkWorks)("a link to a FILE is not isFile() either", () => {
    const entry = readdirSync(dir, { withFileTypes: true }).find(
      (e) => e.name === "link-to-model.safetensors",
    );
    expect(entry, "the link should be listed").toBeDefined();
    expect(entry!.isFile()).toBe(false);
    expect(entry!.isSymbolicLink()).toBe(true);
  });

  it("a real file and a real directory report themselves normally", () => {
    // The control, and it runs everywhere. Without it, a readdir that returned nothing on
    // some platform would leave the two assertions above skipped and unmissed.
    const entries = readdirSync(dir, { withFileTypes: true });
    expect(entries.find((e) => e.name === "real")?.isDirectory()).toBe(true);
    const inner = readdirSync(join(dir, "real"), { withFileTypes: true });
    expect(inner.find((e) => e.name === "model.safetensors")?.isFile()).toBe(true);
  });
});
