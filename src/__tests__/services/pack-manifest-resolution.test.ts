// #1568 — `list_packs` hands out an absolute manifest_path, and that path dies.
//
// The path is built from the RUNNING package root, which under npx is an ephemeral cache
// directory (…/npm-cache/_npx/<hash>/node_modules/comfyui-mcp). The next npx respawn gets a
// different <hash>, so a path captured earlier in the conversation — or written into notes,
// or repeated by an agent from memory — stats ENOENT:
//
//   ENOENT: no such file or directory, stat
//   '~/AppData/Local/npm-cache/_npx/28eae33d00f3f7f1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml'
//
// `packsDir()` already resolves from the current package root, so the LOOKUP is fine; what
// goes stale is the string handed out. Two things follow, and this file pins both:
//
//   1. `apply_manifest` should take the pack by NAME. A name cannot go stale, and it is what
//      `list_packs` already uses everywhere else (read_workflow, panel_load_workflow).
//   2. A path that IS one of our bundled packs, merely under a dead package root, should be
//      recognised rather than reported as a missing file — the pack is right there.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePackManifestFile, bundledPackNamedByStalePath } from "../../services/manifest.js";

describe("a pack manifest resolves by NAME, never by a captured path (#1568)", () => {
  it("resolves a real bundled pack", () => {
    // krea2-combo is the pack from the report. Any bundled pack proves the mechanism; this
    // one proves it against the case that was reported.
    const file = resolvePackManifestFile("krea2-combo");
    expect(file, "the reported pack must resolve from the running package root").toBeTruthy();
    expect(file).toMatch(/krea2-combo[\\/]manifest\.ya?ml$/);
  });

  it("refuses a name that is not a plain pack directory", () => {
    // The name reaches the filesystem, so traversal must not.
    for (const bad of ["../../etc/passwd", "a/b", "..", "", "  ", "pack;rm -rf /"]) {
      expect(resolvePackManifestFile(bad), bad).toBeNull();
    }
  });

  it("refuses a name that traverses but LANDS BACK inside packs/", () => {
    // Isolates the name test from the containment test. `../../etc/passwd` escapes the
    // packs root, so the `startsWith` guard refuses it and the name pattern is never
    // exercised — deleting the pattern left that case passing. This one resolves to a real
    // pack directory, so containment is satisfied and only the name rule can refuse it.
    expect(resolvePackManifestFile("krea2-combo/../krea2-combo")).toBeNull();
    expect(resolvePackManifestFile("./krea2-combo")).toBeNull();
  });

  it("returns null for a pack that does not exist, rather than a path that does not", () => {
    expect(resolvePackManifestFile("no-such-pack-1568")).toBeNull();
  });
});

describe("a stale npx path is recognised as the pack it names (#1568)", () => {
  const STALE =
    "C:/Users/u/AppData/Local/npm-cache/_npx/28eae33d00f3f7f1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml";

  it("repairs the exact path from the report", () => {
    const repaired = bundledPackNamedByStalePath(STALE);
    expect(repaired, "a dead npx root naming a real pack must be recognised").toBe("krea2-combo");
  });

  it("repairs the POSIX form too", () => {
    const posix =
      "/home/u/.npm/_npx/9f2c1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml";
    expect(bundledPackNamedByStalePath(posix)).toBe("krea2-combo");
  });

  it("does NOT repair a path that is not a bundled pack manifest", () => {
    // This substitutes a file the caller did not name, so it may only fire when the path is
    // unmistakably one of OUR packs. Everything else must fail as the missing file it is —
    // silently applying a different manifest is far worse than an ENOENT.
    for (const other of [
      "/home/u/my-project/packs/krea2-combo/manifest.yaml", // not under a comfyui-mcp root
      "/npx/x/node_modules/comfyui-mcp/packs/krea2-combo/other.yaml", // not the manifest
      "/npx/x/node_modules/comfyui-mcp/manifest.yaml", // no pack segment
      "/npx/x/node_modules/comfyui-mcp/packs/../../evil/manifest.yaml", // traversal
      "/npx/x/node_modules/other-pkg/packs/krea2-combo/manifest.yaml", // a different package
      // A SOURCE CHECKOUT, not an install (review). The first version authenticated only
      // the last four segments, so a developer's own tree — or any directory that happened
      // to be called comfyui-mcp — was accepted. The reported failure is an installed copy
      // under an npx cache, so `node_modules` is required.
      "/home/u/dev/comfyui-mcp/packs/krea2-combo/manifest.yaml",
      "/home/u/comfyui-mcp/packs/krea2-combo/manifest.yaml",
    ]) {
      expect(bundledPackNamedByStalePath(other), other).toBeNull();
    }
  });

  it("does NOT repair a path naming a pack this build does not ship", () => {
    // The name has to exist HERE. Otherwise this invents a file for a pack that was removed
    // between versions, which is exactly the confusion it is meant to remove.
    expect(
      bundledPackNamedByStalePath(
        "/x/_npx/abc/node_modules/comfyui-mcp/packs/no-such-pack-1568/manifest.yaml",
      ),
    ).toBeNull();
  });

  it("leaves a path that still EXISTS completely alone", () => {
    // Repair is for a dead path only. A live one is already correct, and re-deriving it
    // could retarget a legitimately different checkout.
    const live = resolvePackManifestFile("krea2-combo") as string;
    expect(live).toBeTruthy();
    expect(bundledPackNamedByStalePath(live)).toBeNull();
  });

  it("leaves an EXISTING path alone even when it is shaped like an install", () => {
    // Isolates the exists-check from the owner-check. This repo's checkout directory is not
    // named `comfyui-mcp`, so the test above is refused by the OWNER guard and passes with
    // the exists-check deleted — the case that matters in production, where the path really
    // does live under `node_modules/comfyui-mcp/packs/…`, was never covered.
    //
    // So build one on disk: a real file, at the real installed shape, that must be returned
    // untouched because it is not stale.
    const root = mkdtempSync(join(tmpdir(), "cmcp-1568-"));
    const dir = join(root, "node_modules", "comfyui-mcp", "packs", "krea2-combo");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "manifest.yaml");
    writeFileSync(file, "models: []\n");
    try {
      expect(existsSync(file), "the fixture must actually exist").toBe(true);
      expect(
        bundledPackNamedByStalePath(file),
        "a live installed path is already correct — repairing it would retarget a real checkout",
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the `packs` segment, not merely a comfyui-mcp root", () => {
    // Isolates the packs-segment check from the owner check: owner IS comfyui-mcp here, and
    // the pack name IS real, so only the segment rule can refuse it. The earlier refusal
    // case had a non-matching owner and so passed with this rule deleted.
    expect(
      bundledPackNamedByStalePath(
        "/x/_npx/abc/node_modules/comfyui-mcp/skills/krea2-combo/manifest.yaml",
      ),
    ).toBeNull();
  });
});
