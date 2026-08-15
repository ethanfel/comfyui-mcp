// #1371 — a model was written into a DIFFERENT local ComfyUI installation than the one
// serving the session: connected to :8190 (…\ComfyUI_H3), streamed into …\ComfyUI\models
// from a stale COMFYUI_PATH, while visibility was checked against the connected server.
//
// The existing divergence guard shipped in v0.49.4 and the reporter was on 0.50.107, so
// it was present and did not fire: it proves divergence from CONTENT (files on disk the
// server does not list), and an empty destination category proves nothing.
//
// A FIRST attempt refused when the destination fell outside the install root the server
// names for itself. Review knocked that down and was right — extra_model_paths.yaml
// registers roots elsewhere by design, <install>/models is routinely a junction, and
// #1474 (fixed the same day) is a Comfy Desktop install serving models from a SHARED
// root outside its install directory. That guard would have refused it.
//
// This uses isUnderLiveModelRoots instead, which answers the question that actually
// matters — does the connected server read this tree — and distinguishes UNKNOWN from NO.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { divergentInstallRefusal } from "../../services/download-root-correspondence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STALE_DEST = "G:/Start_AI/AI_Test/ComfyUI/models/vae";
const LIVE_ROOT = "G:/Start_AI/AI_Test/ComfyUI_H3/models";

describe("#1371 the reporter's case refuses", () => {
  const msg = () =>
    divergentInstallRefusal({
      targetDir: STALE_DEST,
      inRoots: false,
      liveRoot: LIVE_ROOT,
      serverUrl: "http://127.0.0.1:8190",
    })!;

  it("refuses a destination the server demonstrably does not read", () => {
    expect(msg()).toMatch(/NOT downloaded/);
    expect(msg()).toContain(STALE_DEST);
    expect(msg()).toMatch(/127\.0\.0\.1:8190/);
  });

  it("names the root the server DOES read, so the two can be compared", () => {
    expect(msg()).toContain(LIVE_ROOT);
  });

  it("says nothing was written, and names COMFYUI_PATH as the usual cause", () => {
    expect(msg()).toMatch(/Nothing was written/);
    expect(msg()).toMatch(/COMFYUI_PATH/);
    expect(msg()).toMatch(/left over from a\s+different installation/);
  });

  it("states that extra roots and symlinks were accounted for", () => {
    // Without this, a reader with a shared or junctioned models tree reasonably
    // suspects the check simply does not understand their layout.
    expect(msg()).toMatch(/extra_model_paths\.yaml/);
    expect(msg()).toMatch(/junctions and symlinks resolved/);
  });

  it("gives both ways forward, including a deliberate other install", () => {
    expect(msg()).toMatch(/Point COMFYUI_PATH ?\n?at the ComfyUI that is actually running/);
    expect(msg()).toMatch(/--base-directory/);
    expect(msg()).toMatch(/If you MEANT another install/);
  });
});

describe("#1371 it refuses ONLY on a demonstrated mismatch", () => {
  it("proceeds when the server DOES read the destination", () => {
    expect(
      divergentInstallRefusal({ targetDir: STALE_DEST, inRoots: true, liveRoot: LIVE_ROOT }),
    ).toBeNull();
  });

  it("proceeds when membership is UNKNOWN — the whole point", () => {
    // `undefined` means only local configuration could answer. Treating that as "the
    // server cannot read it" is exactly the inference the surrounding code records as
    // having produced false refusal after false refusal.
    expect(divergentInstallRefusal({ targetDir: STALE_DEST, inRoots: undefined })).toBeNull();
  });

  it("proceeds when there is no destination to judge", () => {
    expect(divergentInstallRefusal({ targetDir: "", inRoots: false })).toBeNull();
  });

  it("still refuses when the live root is unknown but membership is false", () => {
    // The verdict comes from membership, not from having a root to print.
    const m = divergentInstallRefusal({ targetDir: STALE_DEST, inRoots: false });
    expect(m).toBeTruthy();
    expect(m).not.toMatch(/It reads models from/);
  });
});

describe("#1371 WIRING", () => {
  const src = readFileSync(join(HERE, "../../services/model-resolver.ts"), "utf8");

  it("resolveDownloadTarget consults it", () => {
    expect(src).toMatch(
      /import \{ divergentInstallRefusal \} from "\.\/download-root-correspondence\.js";/,
    );
    expect(src).toMatch(/divergentInstallRefusal\(\{/);
    expect(src).toMatch(/if \(refusal\) throw new ModelError\(refusal/);
  });

  it("asks the LIVE-ROOTS question, not an install-directory question", () => {
    // The refuted premise. isUnderLiveModelRoots understands extra roots, junctions and
    // symlinks; an install-root comparison does not.
    expect(src).toMatch(/isUnderLiveModelRoots\(targetDir, normalizedSubfolderFor/);
    expect(src).toMatch(/inRoots: membership\.inRoots/);
  });

  it("the refuted install-root helper is gone", () => {
    expect((src.match(/serverInstallRootOrUndefined/g) ?? []).length).toBe(0);
  });

  it("scopes the check to the destination's CATEGORY", () => {
    // Live extra roots are category-scoped: a `checkpoints` root must not vouch for a
    // LoRA destination.
    expect(src).toMatch(/function normalizedSubfolderFor\(targetSubfolder: string\)/);
  });

  it("only runs when the destination did NOT come from the live server", () => {
    const at = src.indexOf("if (!liveRootAtResolve) {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/isUnderLiveModelRoots/);
  });
});
