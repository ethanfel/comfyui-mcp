// #1568 — apply_manifest's INPUT SELECTION: `pack` is accepted, and a dead npx path is
// refused with the one-call remedy instead of a bare ENOENT.
//
// Every case here is an ERROR path, deliberately. An earlier version of this file called
// applyManifest with a real pack to prove the happy path, and review caught what that means:
// only `node-management` was mocked, so with a local ComfyUI base resolvable the model loop
// would reach `startDownloadJob` and start pulling this pack's multi-gigabyte weights on
// whatever machine ran the suite. A test must not be able to do that.
//
// The happy path is covered where it costs nothing: `resolvePackManifestFile` proves the
// name resolves (pack-manifest-resolution.test.ts), and the tool-schema test proves the
// input is offered. Nothing here can install anything, because nothing here gets past
// resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";

let applyManifest: typeof import("../../services/manifest.js").applyManifest;

beforeEach(async () => {
  vi.resetModules();
  ({ applyManifest } = await import("../../services/manifest.js"));
});

const failureOf = async (opts: Record<string, unknown>): Promise<string> => {
  try {
    await applyManifest(opts as never);
    return "__NO_ERROR__";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe("apply_manifest input selection (#1568)", () => {
  it("REFUSES more than one of manifest / path / pack", async () => {
    for (const opts of [
      { manifest: { models: [] }, pack: "krea2-combo" },
      { path: "/x/manifest.yaml", pack: "krea2-combo" },
      { manifest: { models: [] }, path: "/x/manifest.yaml" },
      { manifest: { models: [] }, path: "/x/manifest.yaml", pack: "krea2-combo" },
    ]) {
      expect(await failureOf(opts), JSON.stringify(opts)).toMatch(/exactly one of/i);
    }
  });

  it("REFUSES none of them, and names all three", async () => {
    const msg = await failureOf({});
    expect(msg).toMatch(/exactly one of/i);
    // An agent that cannot discover `pack` from the error keeps reaching for the path that
    // expires, which is the whole failure.
    expect(msg).toMatch(/pack/);
  });

  it("an unknown pack says so, and points at how to find a real one", async () => {
    const msg = await failureOf({ pack: "no-such-pack-1568" });
    expect(msg).toMatch(/no-such-pack-1568/);
    expect(msg).toMatch(/list_packs/);
    // NOT an ENOENT with a path in it — that is the confusing failure this replaces.
    expect(msg).not.toMatch(/ENOENT/);
  });

  it("a traversal attempt in `pack` is refused as an unknown pack, never opened", async () => {
    for (const bad of ["../../etc/passwd", "a/b", "..", "krea2-combo/../krea2-combo"]) {
      expect(await failureOf({ pack: bad }), bad).toMatch(/No bundled pack named/);
    }
  });
});

describe("a stale npx path refuses with the remedy, and installs NOTHING (#1568)", () => {
  const STALE =
    "C:/Users/u/AppData/Local/npm-cache/_npx/28eae33d00f3f7f1/node_modules/comfyui-mcp/packs/krea2-combo/manifest.yaml";

  it("keeps the REAL loader error and appends the remedy", async () => {
    // Review, round 2. An earlier version decided "this is a stale npx path" BEFORE trying
    // to open it, which relabelled an ordinary ENOENT/EACCES under any node_modules install
    // and hid what actually went wrong. The loader's own error is what the caller needs; the
    // suggestion is additional.
    const msg = await failureOf({ path: STALE });
    expect(msg, "the underlying failure must still be visible").toMatch(/ENOENT|EACCES|ENOTDIR/);
    expect(msg).toMatch(/pack: "krea2-combo"/);
    // The reason matters as much as the remedy: without it this reads as a missing pack.
    expect(msg).toMatch(/npx/i);
  });

  it("says plainly that nothing was installed", async () => {
    // apply_manifest installs custom nodes and downloads weights. A failure part-way
    // through and a failure before anything started are very different situations, and the
    // caller cannot tell them apart from an ENOENT.
    expect(await failureOf({ path: STALE })).toMatch(/nothing was installed/i);
  });

  it("does NOT silently apply the bundled pack in its place", async () => {
    // The direction review attacked: substituting a file the caller did not name, for an
    // operation that installs things. It must refuse, not succeed.
    expect(await failureOf({ path: STALE })).not.toBe("__NO_ERROR__");
  });

  it("opens the path EXACTLY as given, whitespace included", async () => {
    // Review, P2. Trimming was only ever meant to decide whether an input was PRESENT.
    // Trimming what gets opened silently retargets a legitimate POSIX path whose name
    // begins or ends with a space — and could push one into stale-path handling that the
    // untrimmed original would never have matched.
    //
    // Asserted through the error text, which quotes the path the loader actually tried.
    // The error quotes the path the loader actually tried, so the padding is observable.
    // Asserted on the TRAILING spaces rather than the whole string: the leading ones are
    // consumed by path resolution differently per platform, but a trim would remove both.
    const padded = "  /home/u/no such manifest .yaml  ";
    const msg = await failureOf({ path: padded });
    expect(msg).not.toBe("__NO_ERROR__");
    expect(msg, "the trailing whitespace must survive to the open").toMatch(
      /no such manifest \.yaml {2}/,
    );
    // …and the space INSIDE the name, which a naive normalisation would also eat.
    expect(msg).toMatch(/manifest \.yaml/);
  });

  it("a missing file that is NOT an installed pack path fails as the missing file it is", async () => {
    for (const other of [
      "/home/u/my-project/packs/krea2-combo/manifest.yaml",
      "/home/u/dev/comfyui-mcp/packs/krea2-combo/manifest.yaml", // a source checkout
    ]) {
      const msg = await failureOf({ path: other });
      expect(msg, other).not.toMatch(/re-run with pack/i);
    }
  });
});
