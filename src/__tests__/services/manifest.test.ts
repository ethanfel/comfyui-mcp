import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const IS_WIN = process.platform === "win32";
// The product (manifest.ts) detects an executable on Windows with
// `where <cmd>` and on POSIX with `<cmd> --version`. Mirror that here so the
// detection assertion passes on both platforms.
const detectCmd = IS_WIN ? "where" : "uv";
const detectArgs = IS_WIN ? ["uv"] : ["--version"];
const COMFY = "/fake/ComfyUI";

const mockConfig = vi.hoisted(() => ({
  comfyuiPath: "/fake/ComfyUI" as string | undefined,
  // Explicit remote override. When undefined, isRemoteMode mirrors the legacy
  // "no comfyuiPath" gate; set true to model a remote target that COEXISTS with
  // a local COMFYUI_PATH (the regression issue #1 guards against).
  remote: undefined as boolean | undefined,
}));

const readFileMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn());
const lstatMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const installCustomNodeMock = vi.hoisted(() => vi.fn());
const installModelViaManagerMock = vi.hoisted(() => vi.fn());
const listInstalledNodesMock = vi.hoisted(() => vi.fn());
const downloadModelMock = vi.hoisted(() => vi.fn());
/** #369 post-landing verification. Default: the connected ComfyUI DOES list the
 *  landed file (the healthy local case these manifest tests model). */
const verifyLandedModelMock = vi.hoisted(() =>
  vi.fn(async (targetPath: string) => ({
    verifiedPath: targetPath,
    liveVisible: "visible" as const,
    // The verdict names the root it was made against; the reader below reports the
    // SAME root, which is what licenses re-asserting it as applied (#369).
    verifiedAgainstRoot: "/fake/ComfyUI/models",
  })),
);
/** #369: does the connected ComfyUI already list this entry? Default yes, so an
 *  existing file still counts as a legitimate skip. */
const liveListingHasEntryMock = vi.hoisted(() =>
  vi.fn(async (): Promise<boolean | undefined> => true),
);
/** #369: is an existing file physically inside a tree the live server reads? Only
 *  a positive answer licenses an "already exists" SKIP. Default TRUE — these tests
 *  model the healthy local case; the unconfirmed/stale paths are asserted
 *  explicitly below. */
/** #369: does the live server serve a file of this basename in the category?
 *  Default TRUE — the healthy case these tests model. */
const liveListingHasBasenameMock = vi.hoisted(() =>
  vi.fn(async (): Promise<boolean | undefined> => true),
);
const isUnderLiveModelRootsMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ inRoots: boolean | undefined; liveRoot?: string }> => ({
    inRoots: true,
  })),
);
/** The models root the connected server reads NOW. Undefined = unknown, which never
 *  invalidates a verdict. */
const currentLiveRootMock = vi.hoisted(() =>
  vi.fn(async (): Promise<string | undefined> => "/fake/ComfyUI/models"),
);
const resolveExistingModelFileMock = vi.hoisted(() => vi.fn());
const listLocalModelsMock = vi.hoisted(() => vi.fn());
const savedWorkspaceMock = vi.hoisted(() => vi.fn(() => undefined as string | undefined));
const liveComfyBaseMock = vi.hoisted(() =>
  vi.fn(async () => undefined as string | undefined),
);
// Overridable per-test: default mirrors a VERIFIED install-root interpreter (the
// fail-closed resolver only returns a python it can account for, #651).
const installInterpreterMock = vi.hoisted(() =>
  vi.fn(
    async (root: string | undefined): Promise<{ python?: string; source: string; reason: string }> => ({
      python: root ? `${root}/python` : "python",
      source: "launched",
      reason: "test interpreter",
    }),
  ),
);

vi.mock("../../config.js", () => ({
  config: mockConfig,
  // apply_manifest routes models through the Manager in remote mode (no
  // comfyuiPath). isRemoteMode mirrors that gate for the tests.
  isRemoteMode: () => mockConfig.remote ?? !mockConfig.comfyuiPath,
}));

vi.mock("node:fs/promises", () => ({
  lstat: (...a: unknown[]) => lstatMock(...a),
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  readFile: (...a: unknown[]) => readFileMock(...a),
  realpath: (...a: unknown[]) => realpathMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
}));

vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => existsSyncMock(...a),
}));

vi.mock("node:child_process", () => ({
  execFileSync: (...a: unknown[]) => execFileSyncMock(...a),
}));

vi.mock("../../services/node-management.js", () => ({
  installCustomNode: (...a: unknown[]) => installCustomNodeMock(...a),
  installModelViaManager: (...a: unknown[]) => installModelViaManagerMock(...a),
  listInstalledNodes: (...a: unknown[]) => listInstalledNodesMock(...a),
}));

vi.mock("../../services/model-resolver.js", () => ({
  MODEL_SUBDIRS: [
    "checkpoints",
    "loras",
    "vae",
    "upscale_models",
    "controlnet",
    "embeddings",
    "clip",
    "diffusers",
    "diffusion_models",
    "gligen",
    "hypernetworks",
    "photomaker",
    "style_models",
    "text_encoders",
    "unet",
  ],
  downloadModel: (...a: unknown[]) => downloadModelMock(...a),
  // startDownloadJob consults this to choose local-vs-Manager routing (#420).
  // Mirror the same mode gate the config mock uses so manifest downloads key the
  // same way they always did (local unless remote).
  shouldDispatchDownloadToManager: async () => mockConfig.remote ?? !mockConfig.comfyuiPath,
  // startDownloadJob resolves the destination via this before streaming; stub it
  // so a distinct targetPath is derived per (subfolder, filename) without a server.
  resolveDownloadTarget: async (url: string, sub: string, filename?: string) => {
    const name = filename ?? String(url).split("/").pop() ?? "model.safetensors";
    return { targetDir: `/fake/ComfyUI/models/${sub}`, filename: name, targetPath: `/fake/ComfyUI/models/${sub}/${name}` };
  },
  resolveExistingModelFile: (...a: unknown[]) => resolveExistingModelFileMock(...a),
  listLocalModels: (...a: unknown[]) => listLocalModelsMock(...a),
  // #369: after landing, the job verifies the file against the LIVE server's own
  // listing, and only a CONFIRMED placement is reported as "applied". These tests
  // model the healthy local case (the connected ComfyUI does read from there);
  // the unconfirmed/wrong-place renderings are covered in download-jobs.test.ts
  // and download-live-destination.test.ts.
  verifyLandedModel: (...a: unknown[]) => verifyLandedModelMock(...(a as [string, string])),
  // The "already exists" shortcut confirms the file is one the LIVE server reads
  // before it counts as a skip (#369). Default: it is.
  liveListingHasEntry: (...a: unknown[]) => liveListingHasEntryMock(...(a as [string, string])),
  // A skip additionally requires the live server to really serve a file of that
  // BASENAME in the category (the container/host path-collision guard). Default yes.
  liveListingHasBasename: (...a: unknown[]) =>
    liveListingHasBasenameMock(...(a as [string, string])),
  // The decisive containment test. Default UNKNOWN (only local config could answer),
  // so these tests exercise the listing-based fallback.
  isUnderLiveModelRoots: (...a: unknown[]) => isUnderLiveModelRootsMock(...(a as [string])),
  // The models root the connected server reads NOW — compared against the root a
  // verdict was made against, so a replaced server invalidates a stale positive.
  currentLiveModelsRoot: async (): Promise<string | undefined> => currentLiveRootMock(),
  // Faithful mirror of the real managerModelDestination (pure logic) so the
  // remote-model path resolves a Manager-valid { type, save_path }.
  managerModelDestination: (category: string, relPath?: string) => {
    const map: Record<string, string> = {
      checkpoints: "checkpoints",
      loras: "lora",
      vae: "vae",
      upscale_models: "upscale",
      controlnet: "controlnet",
      embeddings: "embeddings",
      clip: "clip",
      diffusion_models: "diffusion_model",
      gligen: "gligen",
      text_encoders: "text_encoders",
      unet: "unet",
    };
    const type = map[category] ?? category;
    if (relPath && relPath !== category) return { type, save_path: relPath };
    if (map[category]) return { type, save_path: "default" };
    return { type, save_path: category };
  },
}));

vi.mock("../../services/workspace-env.js", () => ({
  getSavedDefaultWorkspaceSync: (...a: unknown[]) => savedWorkspaceMock(...(a as [])),
  resolveLiveComfyUIBase: (...a: unknown[]) => liveComfyBaseMock(...(a as [])),
  // Mirrors the real resolver enough for the pip tests: an install-root python.
  resolveRootInterpreter: (root: string | undefined) =>
    root ? `${root}/python` : "python",
  resolveInstallInterpreter: (...a: unknown[]) =>
    installInterpreterMock(...(a as [string | undefined])),
}));

// resolveLocalModelPath now roots local_path validation at the SAME live write
// dir the downloader uses (resolveModelsDir), not <COMFYUI_PATH>/models (#490).
// Back it with the fake install's models dir so the containment/symlink guards
// run against the exact root the tests build their symlink fixtures under.
const modelsDirMock = vi.hoisted(() =>
  vi.fn(async () => "/fake/ComfyUI/models" as string),
);
vi.mock("../../services/output-dir.js", () => ({
  resolveModelsDir: (...a: unknown[]) => modelsDirMock(...(a as [])),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyManifest,
  loadManifestFile,
} from "../../services/manifest.js";

beforeEach(() => {
  mockConfig.comfyuiPath = "/fake/ComfyUI";
  mockConfig.remote = undefined;
  readFileMock.mockReset();
  statMock.mockReset().mockRejectedValue(new Error("missing"));
  mkdirMock.mockReset().mockResolvedValue(undefined);
  realpathMock.mockReset().mockImplementation((path: string) => Promise.resolve(path));
  lstatMock.mockReset().mockRejectedValue(new Error("missing"));
  existsSyncMock.mockReset().mockReturnValue(false);
  execFileSyncMock.mockReset().mockReturnValue("ok");
  installCustomNodeMock.mockReset().mockResolvedValue({ message: "installed node" });
  installModelViaManagerMock
    .mockReset()
    .mockResolvedValue({ mechanism: "manager-http", message: "queued model" });
  listInstalledNodesMock.mockReset().mockResolvedValue([]);
  downloadModelMock.mockReset().mockResolvedValue("/fake/ComfyUI/models/checkpoints/m.safetensors");
  // Default: the model is found in NO root (multi-root resolver rejects, HTTP
  // listing is empty). Individual tests override to simulate an existing model.
  resolveExistingModelFileMock.mockReset().mockRejectedValue(new Error("not found"));
  listLocalModelsMock.mockReset().mockResolvedValue([]);
  savedWorkspaceMock.mockReset().mockReturnValue(undefined);
  liveComfyBaseMock.mockReset().mockResolvedValue(undefined);
  installInterpreterMock.mockReset().mockImplementation(
    async (root: string | undefined) => ({
      python: root ? `${root}/python` : "python",
      source: "launched",
      reason: "test interpreter",
    }),
  );
  modelsDirMock.mockReset().mockResolvedValue("/fake/ComfyUI/models");
});

describe("loadManifestFile", () => {
  it("parses JSON manifests", async () => {
    statMock.mockResolvedValueOnce({ size: 128 });
    readFileMock.mockResolvedValueOnce(JSON.stringify({
      pip: ["numpy"],
      custom_nodes: ["comfyui-impact-pack"],
    }));

    await expect(loadManifestFile("/tmp/manifest.json")).resolves.toMatchObject({
      pip: ["numpy"],
      custom_nodes: ["comfyui-impact-pack"],
      apt: [],
      models: [],
    });
  });

  it("parses YAML manifests", async () => {
    statMock.mockResolvedValueOnce({ size: 128 });
    readFileMock.mockResolvedValueOnce(
      [
        "apt:",
        "  - ffmpeg",
        "models:",
        "  - url: https://example.com/model.safetensors",
        "    model_type: loras",
      ].join("\n"),
    );

    await expect(loadManifestFile("/tmp/manifest.yaml")).resolves.toMatchObject({
      apt: ["ffmpeg"],
      models: [{ url: "https://example.com/model.safetensors", model_type: "loras" }],
    });
  });

  it("rejects oversized manifest files before reading", async () => {
    statMock.mockResolvedValueOnce({ size: 1024 * 1024 + 1 });

    await expect(loadManifestFile("/tmp/manifest.yaml")).rejects.toThrow(/too large/i);
    expect(readFileMock).not.toHaveBeenCalled();
  });
});

describe("applyManifest", () => {
  it("skips apt entries and already-detected custom nodes/models", async () => {
    listInstalledNodesMock.mockResolvedValueOnce([
      { module: "ComfyUI-Impact-Pack", cnrId: "comfyui-impact-pack", enabled: true },
    ]);
    statMock.mockResolvedValueOnce({ isFile: () => true });

    const result = await applyManifest({
      manifest: {
        apt: ["ffmpeg"],
        custom_nodes: ["comfyui-impact-pack"],
        models: [
          {
            url: "https://example.com/model.safetensors",
            model_type: "checkpoints",
            filename: "model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 3, failed: 0, pending: 0 });
    expect(result.results.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(installCustomNodeMock).not.toHaveBeenCalled();
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("continues after individual failures and reports each item", async () => {
    installCustomNodeMock.mockRejectedValueOnce(new Error("node failed"));
    downloadModelMock.mockResolvedValueOnce("/fake/ComfyUI/models/loras/model.safetensors");

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["bad-node"],
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "loras/model.safetensors",
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 1, pending: 0 });
    expect(result.results).toMatchObject([
      { action: "custom_node", item: "bad-node", status: "failed" },
      { action: "model", item: "loras/model.safetensors", status: "applied" },
    ]);
    // apply_manifest now routes local downloads through the background job
    // registry (#362), which calls downloadModel with an optional auth arg.
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/model.safetensors",
      "loras",
      "model.safetensors",
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
    );
  });

  it("reports a custom_node as FAILED when Manager queued it but it isn't present afterward", async () => {
    // ComfyUI-Manager drains the queue "done" for a git URL not in its registry
    // even though nothing was cloned. installCustomNode resolves, but the
    // post-install verification (listInstalledNodes) must catch the no-op.
    installCustomNodeMock.mockResolvedValueOnce({
      message: "Queued + installed via ComfyUI-Manager.",
    });
    listInstalledNodesMock.mockResolvedValue([]); // never shows up — clone no-op'd

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer"],
        models: [],
      },
    });

    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      action: "custom_node",
      status: "failed",
    });
    expect(result.results[0].message).toMatch(/not present afterward/i);
  });

  it("reports a custom_node as APPLIED only after verifying it's actually installed", async () => {
    installCustomNodeMock.mockResolvedValueOnce({
      message: "Queued + installed via ComfyUI-Manager.",
    });
    listInstalledNodesMock
      .mockResolvedValueOnce([]) // pre-install skip-check: not yet installed
      .mockResolvedValueOnce([
        { module: "comfyui-krea2t-enhancer", enabled: true },
      ]); // verification: the freshly-cloned node now shows on disk

    const result = await applyManifest({
      manifest: {
        custom_nodes: ["https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer"],
        models: [],
      },
    });

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({
      action: "custom_node",
      status: "applied",
    });
  });

  it("refuses a panel manifest when Manager and local loopback targets can differ", async () => {
    // config.comfyuiPath can point at local instance A while the current Manager
    // client targets B. A pre/post panel scan of A cannot validate a mutation of
    // B, even if Manager's installed list says the panel is present there.
    mockConfig.comfyuiPath = "/fake/ComfyUI-A";
    listInstalledNodesMock.mockResolvedValueOnce([
      { module: "comfyui-agent-panel", cnrId: "comfyui-agent-panel", enabled: true },
    ]);

    const result = await applyManifest({
      manifest: { custom_nodes: ["comfyui-agent-panel"] },
    });

    expect(installCustomNodeMock).not.toHaveBeenCalled();
    expect(result.summary).toMatchObject({ applied: 0, failed: 1 });
    expect(result.results[0]?.message).toMatch(/cannot prove.*same instance/i);
  });

  it("skips a model already present in an ALTERNATE model root (extra_model_paths)", async () => {
    // The computed target under <COMFYUI_PATH>/models does NOT exist (statMock
    // rejects by default), but the user already has the file under an extra root
    // declared in extra_model_paths.yaml (e.g. another drive). The multi-root
    // resolver finds it, so we must skip — not re-download.
    const altPath = "E:/AImodels/checkpoints/big.safetensors";
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: altPath,
      root: "E:/AImodels",
      info: { isFile: () => true },
    });

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0, pending: 0 });
    expect(result.results).toMatchObject([
      { action: "model", status: "skipped", item: "big.safetensors" },
    ]);
    expect(result.results[0].message).toContain(altPath);
    expect(resolveExistingModelFileMock).toHaveBeenCalledWith(
      "checkpoints/big.safetensors",
    );
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  // #369 — "already exists" is a claim about a path the RUNNING server may not read.
  // #1298 — and when that claim is DISPROVEN, the file is irrelevant, not fatal.
  //
  // #369 changed a false SKIP into a FAIL, which was right about skipping: a
  // stale same-named file must never satisfy the manifest. But failing vetoes a
  // download that has nothing wrong with it — the live root resolved correctly,
  // and the old remedy told the user to repoint COMFYUI_PATH when nothing was
  // misconfigured. #369's real requirement survives: the item is satisfied only
  // if the DOWNLOAD succeeds, never by a file existing somewhere.
  it("DOWNLOADS past an existing file that is not in any tree the connected ComfyUI reads", async () => {
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/stale/models/checkpoints/big.safetensors",
      root: "C:/stale/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    // The stale copy must NOT block the download...
    expect(result.summary.failed).toBe(0);
    expect(downloadModelMock).toHaveBeenCalled();
    // ...and must still be NAMED, because a same-named file in another install
    // is genuinely confusing later. #369 was right that the user should hear
    // about it; it is a note on a success, not a veto.
    const msg = result.results[0].message ?? "";
    expect(msg).toMatch(/same-named file also exists/);
    expect(msg).toMatch(/C:\/stale\/models/);
    expect(msg).toMatch(/was ignored/);
    // Re-pinned from the #369 tests this replaced: that clause IS the diagnostic
    // half #369 wanted kept, and after the rewrite nothing held it — stripping it
    // killed zero tests.
    expect(msg).toMatch(/NOT in any directory/);
  });

  it("does not accuse LATER items of a stale copy found for an earlier one", async () => {
    // Surviving mutation: hoisting `let staleOutsideLiveRoots` above the per-item
    // loop passes every other test, because both stale tests use a single-model
    // manifest. Manifests are multi-model by definition, so the mutant ships a
    // false accusation on every subsequent asset.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/stale/models/checkpoints/big.safetensors",
      root: "C:/stale/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/big.safetensors", model_type: "checkpoints", filename: "big.safetensors" },
          { url: "https://example.com/clean.safetensors", model_type: "loras", filename: "clean.safetensors" },
        ],
      },
    });

    const second = result.results.find((r) => String(r.item).includes("clean")) ?? result.results[1];
    expect(second?.message ?? "").not.toMatch(/same-named file also exists/);
  });

  // #1298 — was "FAILS"; containment proving the file irrelevant now lets the
  // download proceed. The containment CHECK is unchanged and still load-bearing:
  // it is what distinguishes this from a live copy (which still skips) and from
  // an unverifiable one (which is still pending).
  it("DOWNLOADS past a same-named existing file OUTSIDE every live model root (codex gate r5)", async () => {
    // C:\Stale\...\big.safetensors exists locally AND the live server has its own
    // D:\Live\...\big.safetensors, so a name-only listing check would call it a skip.
    // The containment test is decisive and overrides it.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/Stale/models/checkpoints/big.safetensors",
      root: "C:/Stale/models",
      info: { isFile: () => true },
    });
    // Decisive: the containment answer short-circuits the name-only listing check
    // (which would have said "yes, the server lists big.safetensors" — its own copy).
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary.failed).toBe(0);
    // Re-pinned: the old test asserted downloadModel was NOT called, so the new
    // contract needs the mirror assertion or "downloads past it" is unheld.
    expect(downloadModelMock).toHaveBeenCalled();
    expect(result.results[0].message).toMatch(/same-named file also exists/);
    expect(result.results[0].message).toMatch(/NOT in any directory/);
  });

  it("FAILS a contained file the live server does not serve at all (container/host collision; codex gate r15)", async () => {
    // The container reports --models-directory /models; the HOST happens to have its
    // own /models with this file. Containment passes, but the running server does not
    // list the name anywhere in the category — so it is NOT installed for it.
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/models/checkpoints/big.safetensors",
      root: "C:/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: true });
    liveListingHasBasenameMock.mockResolvedValueOnce(false);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 0, failed: 1 });
    expect(result.results[0].message).toMatch(/does not list/);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("reports PENDING (never skipped) when containment cannot be established — even if the server lists the NAME", async () => {
    // The stale tree and the live tree both hold `big.safetensors`. A name-only
    // listing hit must NOT promote an unconfirmed placement to "installed".
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/comfy/models/checkpoints/big.safetensors",
      root: "C:/comfy/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: undefined });
    liveListingHasEntryMock.mockResolvedValueOnce(true);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toMatchObject({ skipped: 0, failed: 0, pending: 1 });
    expect(result.results[0].message).toMatch(/not confirmed as installed/);
    expect(result.results[0].message).toMatch(/may be its OWN copy elsewhere/);
  });

  it("skips a CATEGORY-ROOT target found by filename anywhere in the served category", async () => {
    // model_type: checkpoints (category-root target). Not at the computed path
    // nor the exact relative path in any root, but ComfyUI serves it from a
    // nested subfolder within the category. Basename-anywhere match → skip.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "sdxl/big.safetensors", path: "checkpoints/sdxl/big.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/big.safetensors",
            model_type: "checkpoints",
            filename: "big.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0, pending: 0 });
    expect(result.results[0].status).toBe("skipped");
    expect(listLocalModelsMock).toHaveBeenCalledWith("checkpoints");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("skips a NESTED local_path model present at the exact category-relative path", async () => {
    // Nested target asks for checkpoints/foo/model.safetensors and ComfyUI
    // serves exactly that (foo/model.safetensors within checkpoints) → skip.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "foo/model.safetensors", path: "checkpoints/foo/model.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "checkpoints/foo/model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 0, skipped: 1, failed: 0, pending: 0 });
    expect(result.results[0].status).toBe("skipped");
    expect(listLocalModelsMock).toHaveBeenCalledWith("checkpoints");
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("downloads a NESTED local_path when only a same-named file in a DIFFERENT subfolder exists", async () => {
    // Manifest wants checkpoints/foo/model.safetensors but only
    // checkpoints/bar/model.safetensors exists. A basename match would
    // false-skip and leave the requested file absent — must still download.
    listLocalModelsMock.mockResolvedValueOnce([
      { name: "bar/model.safetensors", path: "checkpoints/bar/model.safetensors", type: "checkpoints" },
    ]);

    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/model.safetensors",
            local_path: "checkpoints/foo/model.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/model.safetensors",
      expect.stringMatching(/checkpoints[\\/]foo/),
      "model.safetensors",
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
    );
  });

  it("downloads when the model exists in NO root (multi-root check graceful miss)", async () => {
    // resolveExistingModelFile rejects and listLocalModels is empty (defaults):
    // the model is genuinely absent everywhere, so we must download it.
    const result = await applyManifest({
      manifest: {
        models: [
          {
            url: "https://example.com/new.safetensors",
            model_type: "loras",
            filename: "new.safetensors",
          },
        ],
      },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/new.safetensors",
      "loras",
      "new.safetensors",
      undefined,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
    );
  });

  it("installs pip entries via uv when available", async () => {
    execFileSyncMock.mockReturnValue("ok");

    const result = await applyManifest({
      manifest: { pip: ["torch==2.4.0"] },
    });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      detectCmd,
      detectArgs,
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "uv",
      ["pip", "install", "--python", expect.stringMatching(/python/), "torch==2.4.0"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  it("falls back to python -m pip when uv is unavailable", async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      // Make `uv` detection fail on both platforms: POSIX probes with
      // `uv --version`; Windows probes with `where uv`.
      const probesUv = IS_WIN
        ? cmd === "where" && args[0] === "uv"
        : cmd === "uv" && args[0] === "--version";
      if (probesUv) throw new Error("no uv");
      return "ok";
    });

    await applyManifest({ manifest: { pip: ["numpy"] } });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/python/),
      ["-m", "pip", "install", "numpy"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  it("falls back to python -m pip when uv rejects a non-venv interpreter (#377)", async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      // uv is detected (probe succeeds), but `uv pip install` fails because the
      // ComfyUI interpreter is a system Python, not a venv.
      if (cmd === "uv" && args[0] === "pip") {
        throw Object.assign(new Error("uv failed"), {
          stderr:
            "error: No virtual environment found for executable name python; " +
            "run `uv venv` to create an environment, or pass `--system`",
        });
      }
      return "ok";
    });

    const result = await applyManifest({ manifest: { pip: ["imageio-ffmpeg"] } });

    expect(result.summary).toEqual({ applied: 1, skipped: 0, failed: 0, pending: 0 });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/python/),
      ["-m", "pip", "install", "imageio-ffmpeg"],
      expect.objectContaining({ cwd: COMFY }),
    );
  });

  it("reports pip as failed — never applied — when the server interpreter cannot be verified (#651)", async () => {
    installInterpreterMock.mockResolvedValue({
      source: "undetermined",
      reason:
        "Cannot verify the running server's interpreter: no local ComfyUI is reachable. " +
        "Start ComfyUI or connect to it first.",
    });

    const result = await applyManifest({ manifest: { pip: ["omegaconf"] } });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "pip", item: "omegaconf", status: "failed" },
    ]);
    expect(result.results[0].message).toContain("Cannot verify the running server's interpreter");
    // No pip/uv subprocess ran for the refused package.
    expect(
      execFileSyncMock.mock.calls.some(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("omegaconf"),
      ),
    ).toBe(false);
  });

  it("adopts the saved default workspace as the local path when COMFYUI_PATH is unset (#390)", async () => {
    mockConfig.comfyuiPath = undefined;
    mockConfig.remote = false; // local loopback target, just no COMFYUI_PATH
    savedWorkspaceMock.mockReturnValue("/saved/ComfyUI");
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return (
        s.includes("saved") &&
        (s.endsWith("ComfyUI") || s.endsWith("models") || s.endsWith("custom_nodes"))
      );
    });

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    expect(result.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(downloadModelMock).toHaveBeenCalled();
    // Call-scoped: the adopted path must NOT persist process-wide — it is
    // restored so a later call re-reads/revalidates and other tabs aren't leaked.
    expect(mockConfig.comfyuiPath).toBeUndefined();
  });

  it("adopts the LIVE connected ComfyUI root when COMFYUI_PATH and saved default are both unset (#463)", async () => {
    // #463: sidebar panel connected to a live local ComfyUI, no COMFYUI_PATH and
    // no saved default. Without adoption the session is misclassified "no local
    // filesystem" and every model is skipped. Adopting the live root (from
    // /system_stats) gives a local FS target so the model downloads instead.
    mockConfig.comfyuiPath = undefined;
    mockConfig.remote = false; // local loopback target reached over the panel session
    savedWorkspaceMock.mockReturnValue(undefined);
    liveComfyBaseMock.mockResolvedValue("/live/ComfyUI");
    existsSyncMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return (
        s.includes("live") &&
        (s.endsWith("ComfyUI") || s.endsWith("models") || s.endsWith("custom_nodes"))
      );
    });

    const result = await applyManifest({
      manifest: {
        models: [
          { url: "https://example.com/m.safetensors", model_type: "loras", filename: "m.safetensors" },
        ],
      },
    });

    // Downloaded locally (NOT skipped as "no local filesystem").
    expect(result.summary).toMatchObject({ applied: 1, failed: 0, skipped: 0 });
    expect(downloadModelMock).toHaveBeenCalled();
    // Call-scoped: the adopted live path must NOT persist process-wide.
    expect(mockConfig.comfyuiPath).toBeUndefined();
  });

  it("reports a custom_node as PENDING (not failed) when the Manager queue is still installing at the budget (#489)", async () => {
    // A node install that outlives the wall-clock budget must be reported
    // "pending" (poll the Manager queue), never "failed" — the install keeps
    // running server-side — and every not-yet-started node is reported pending too.
    const prevBudget = process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
    process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = "40";
    // First node never settles (simulates the Manager queue still draining); the
    // budget timer must win and stop us blocking on the rest.
    installCustomNodeMock.mockReturnValueOnce(new Promise(() => {}));

    try {
      const result = await applyManifest({
        manifest: { custom_nodes: ["slow-pack", "next-pack"] },
      });

      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 2 });
      expect(result.results[0]).toMatchObject({
        action: "custom_node",
        item: "slow-pack",
        status: "pending",
      });
      expect(result.results[0].message).toMatch(/still installing/i);
      // The second node is NOT started once the budget is spent — reported pending.
      expect(result.results[1]).toMatchObject({
        action: "custom_node",
        item: "next-pack",
        status: "pending",
      });
      expect(result.results[1].message).toMatch(/not started/i);
      expect(installCustomNodeMock).toHaveBeenCalledTimes(1);
      // Pending is not a FAILURE, but it is not a settled success either: an
      // unfinished apply must not report success (#369). `summary.failed` is the
      // hard-failure signal.
      expect(result.summary.failed).toBe(0);
      expect(result.success).toBe(false);
    } finally {
      if (prevBudget === undefined) delete process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS;
      else process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS = prevBudget;
    }
  });

  it("hands a slow model download to a background job (pending, not applied) (#362)", async () => {
    const prevGrace = process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
    process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = "0";
    downloadModelMock.mockReturnValue(new Promise<string>(() => {}));

    try {
      const result = await applyManifest({
        manifest: {
          models: [
            { url: "https://example.com/huge.safetensors", model_type: "checkpoints", filename: "huge.safetensors" },
          ],
        },
      });
      // A still-running download is PENDING, never counted as applied.
      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 1 });
      expect(result.results[0].status).toBe("pending");
      expect(result.results[0].message).toMatch(/background|RUNNING/i);
      // The apply is not settled, so it is not a success — but nothing FAILED.
      expect(result.summary.failed).toBe(0);
      expect(result.success).toBe(false);
    } finally {
      if (prevGrace === undefined) delete process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
      else process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = prevGrace;
    }
  });

  it("names the stale copy on a STILL-RUNNING download — the reporter's own case", async () => {
    // The note used to render on 1 of 6 outcomes. A download slower than the 15s
    // grace reports `pending` and the stale path was lost PERMANENTLY: it lives
    // only in applyManifest's local array, so the `download_model status` poll
    // the user is told to run cannot see it. That is the case that filed #1298,
    // so the fix is hollow without it.
    const prevGrace = process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
    process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = "0";
    downloadModelMock.mockReturnValue(new Promise<string>(() => {}));
    resolveExistingModelFileMock.mockResolvedValueOnce({
      path: "C:/stale/models/checkpoints/slow.safetensors",
      root: "C:/stale/models",
      info: { isFile: () => true },
    });
    isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });

    try {
      const result = await applyManifest({
        manifest: {
          models: [
            { url: "https://example.com/slow.safetensors", model_type: "checkpoints", filename: "slow.safetensors" },
          ],
        },
      });
      expect(result.results[0].status).toBe("pending");
      expect(result.results[0].message).toMatch(/same-named file also exists/);
      expect(result.results[0].message).toMatch(/C:\/stale\/models/);
    } finally {
      if (prevGrace === undefined) delete process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
      else process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = prevGrace;
    }
  });

  // Round 2: three of the six note-renderings were unpinned — including
  // wrongPlace, which my own commit called the worst case ("two same-named
  // copies on disk and neither message mentions the other"). Deleting any of
  // those three appends left a green suite, so each could regress silently to
  // exactly the state round 1 shipped.
  describe.each([
    {
      name: "a FAILED download",
      file: "failcase.safetensors",
      arm: () => downloadModelMock.mockRejectedValueOnce(new Error("boom")),
    },
    {
      name: "a landed-but-NOT-VISIBLE placement (wrongPlace)",
      file: "wrongplace.safetensors",
      arm: () => verifyLandedModelMock.mockResolvedValueOnce({ liveVisible: "not-visible", note: "" }),
    },
    {
      name: "an UNCONFIRMED placement",
      file: "unconfirmed.safetensors",
      arm: () => verifyLandedModelMock.mockResolvedValueOnce({ liveVisible: "unknown", note: "" }),
    },
  ])("names the stale copy on $name (#1298)", ({ file, arm }) => {
    it("carries the note", async () => {
      resolveExistingModelFileMock.mockResolvedValueOnce({
        path: `C:/stale/models/checkpoints/${file}`,
        root: "C:/stale/models",
        info: { isFile: () => true },
      });
      isUnderLiveModelRootsMock.mockResolvedValueOnce({ inRoots: false });
      arm();

      const result = await applyManifest({
        manifest: {
          models: [{ url: `https://example.com/${file}`, model_type: "checkpoints", filename: file }],
        },
      });
      expect(result.results[0].message ?? "").toMatch(/same-named file also exists/);
    });
  });

  it("does not block on MANY slow downloads — enqueues all, one bounded grace (#362)", async () => {
    const prevGrace = process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
    process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = "50";
    // Every download hangs; a per-model grace would be 50ms * N. One batch-wide
    // grace must cap total wait near a single window regardless of count.
    downloadModelMock.mockReturnValue(new Promise<string>(() => {}));
    const models = Array.from({ length: 20 }, (_, i) => ({
      url: `https://example.com/m${i}.safetensors`,
      model_type: "checkpoints" as const,
      filename: `m${i}.safetensors`,
    }));

    try {
      const started = Date.now();
      const result = await applyManifest({ manifest: { models } });
      const elapsed = Date.now() - started;
      expect(result.summary).toMatchObject({ applied: 0, failed: 0, pending: 20 });
      // All 20 enqueued up front; total wait bounded by one grace window, not 20×.
      expect(downloadModelMock).toHaveBeenCalledTimes(20);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      if (prevGrace === undefined) delete process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
      else process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = prevGrace;
    }
  });

  it.each([
    ["--index-url=evil"],
    ["-r/etc/passwd"],
    ["numpy\u0000"],
  ])("rejects unsafe pip entry %s before invoking pip", async (pkg) => {
    const result = await applyManifest({ manifest: { pip: [pkg] } });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "pip", item: pkg, status: "failed" },
    ]);
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["install", pkg]),
      expect.any(Object),
    );
  });

  it("rejects model local_path when a symlinked parent escapes models", async () => {
    // The product resolves these paths with node:path, yielding
    // backslash-separated absolute paths on Windows. Build the mock keys the
    // same way so they match what the product passes to realpath.
    const modelsDir = resolve(COMFY, "models");
    const linkDir = join(modelsDir, "link");
    const outside = resolve("/tmp/outside");
    realpathMock.mockImplementation((path: string) => {
      if (path === modelsDir) return Promise.resolve(modelsDir);
      if (path === linkDir) return Promise.resolve(outside);
      return Promise.resolve(path);
    });

    const result = await applyManifest({
      manifest: {
        models: [{ url: "https://example.com/model.safetensors", local_path: "link/model.safetensors" }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "model", status: "failed", item: "link/model.safetensors" },
    ]);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  it("validates local_path symlinks against the LIVE models dir, not a stale COMFYUI_PATH (#490)", async () => {
    // #490: COMFYUI_PATH is a stale install; the connected server writes under a
    // DIFFERENT live root. A symlink that escapes the LIVE models dir must be
    // caught — the guard has to run against the live write root the downloader
    // uses, NOT <COMFYUI_PATH>/models (which is never written to here).
    mockConfig.comfyuiPath = "/stale/ComfyUI";
    const liveModels = resolve("/live/ComfyUI/models");
    modelsDirMock.mockResolvedValue(liveModels);
    const linkDir = join(liveModels, "link");
    const outside = resolve("/tmp/escape");
    realpathMock.mockImplementation((path: string) => {
      if (path === liveModels) return Promise.resolve(liveModels);
      if (path === linkDir) return Promise.resolve(outside);
      return Promise.resolve(path);
    });

    const result = await applyManifest({
      manifest: {
        models: [{ url: "https://example.com/m.safetensors", local_path: "link/m.safetensors" }],
      },
    });

    expect(result.success).toBe(false);
    expect(result.results).toMatchObject([
      { action: "model", status: "failed", item: "link/m.safetensors" },
    ]);
    expect(result.results[0].message).toMatch(/escapes the models directory/i);
    expect(downloadModelMock).not.toHaveBeenCalled();
  });

  describe("remote mode (no COMFYUI_PATH) — per-section handling", () => {
    beforeEach(() => {
      mockConfig.comfyuiPath = undefined;
    });

    it("does not throw up-front; routes each section by mode", async () => {
      installCustomNodeMock.mockResolvedValueOnce({ message: "installed node" });
      // First check: not installed yet. After install: present → "applied".
      listInstalledNodesMock
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ module: "x", enabled: true }]);

      const result = await applyManifest({
        manifest: {
          apt: ["ffmpeg"],
          pip: ["numpy"],
          custom_nodes: ["x"],
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

      const byAction = Object.fromEntries(
        result.results.map((r) => [r.action, r]),
      );
      // apt + pip are unsupported remotely → skipped, never executed.
      expect(byAction.apt.status).toBe("skipped");
      expect(byAction.pip.status).toBe("skipped");
      expect(execFileSyncMock).not.toHaveBeenCalled();
      // custom_nodes still go through the Manager HTTP install (remote-ok).
      expect(installCustomNodeMock).toHaveBeenCalledWith({ id: "x" });
      // models route through installModelViaManager, NOT the local downloadModel.
      expect(downloadModelMock).not.toHaveBeenCalled();
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
        save_path: "default",
        trayCategory: "checkpoints",
      });
      // #369: a ComfyUI-Manager dispatch is ACCEPTED, not verified as landed
      // (Manager reports its queue task done even on failure, and there is no local
      // file to check), so it reports PENDING with the caveat spelled out rather
      // than claiming an apply nobody confirmed.
      expect(byAction.model.status).toBe("pending");
      expect(byAction.model.message).toMatch(/NOT verified as landed/);
    });

    it("derives type + save_path from a nested model local_path", async () => {
      await applyManifest({
        manifest: {
          models: [
            {
              url: "https://example.com/lora.safetensors",
              local_path: "loras/pusa/lora.safetensors",
            },
          ],
        },
      });

      // Nested local_path → explicit save_path verbatim; our "loras" category
      // maps to Manager's singular "lora" type key; name falls back to filename.
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "lora.safetensors",
        url: "https://example.com/lora.safetensors",
        filename: "lora.safetensors",
        type: "lora",
        save_path: "loras/pusa",
        trayCategory: "loras",
      });
    });
  });

  describe("remote mode while a local COMFYUI_PATH is also set (issue #1 regression)", () => {
    beforeEach(() => {
      // A remote target coexists with an unrelated local install path. The
      // local/remote split must key off isRemoteMode(), NOT comfyuiPath presence.
      mockConfig.comfyuiPath = "/fake/ComfyUI";
      mockConfig.remote = true;
    });

    it("routes pip + models remotely and never touches the local install/disk", async () => {
      const result = await applyManifest({
        manifest: {
          pip: ["numpy"],
          models: [
            {
              url: "https://example.com/model.safetensors",
              model_type: "checkpoints",
              filename: "model.safetensors",
            },
          ],
        },
      });

      const byAction = Object.fromEntries(
        result.results.map((r) => [r.action, r]),
      );
      // pip has no remote equivalent → skipped, never shelled out locally.
      expect(byAction.pip.status).toBe("skipped");
      expect(execFileSyncMock).not.toHaveBeenCalled();
      // Model goes through the Manager (remote), NOT the local downloadModel,
      // and the local model-existence check is skipped entirely.
      expect(downloadModelMock).not.toHaveBeenCalled();
      expect(resolveExistingModelFileMock).not.toHaveBeenCalled();
      expect(installModelViaManagerMock).toHaveBeenCalledWith({
        name: "model.safetensors",
        url: "https://example.com/model.safetensors",
        filename: "model.safetensors",
        type: "checkpoints",
        save_path: "default",
        trayCategory: "checkpoints",
      });
      // #369: a ComfyUI-Manager dispatch is ACCEPTED, not verified as landed
      // (Manager reports its queue task done even on failure, and there is no local
      // file to check), so it reports PENDING with the caveat spelled out rather
      // than claiming an apply nobody confirmed.
      expect(byAction.model.status).toBe("pending");
      expect(byAction.model.message).toMatch(/NOT verified as landed/);
    });
  });
});
