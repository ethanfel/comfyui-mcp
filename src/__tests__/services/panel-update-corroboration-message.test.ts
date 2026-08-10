// #916 (part b) — install_comfyui(action:"panel", panel_action:"update") on a local install whose
// running ComfyUI is REACHABLE but whose launch arguments yield no install
// root (the common `python main.py` / portable-launcher shape: a relative
// argv and no reported cwd) hit the corroboration refusal whose only remedy
// was "Start ComfyUI so its install root can be read, then retry" — a dead
// instruction, because ComfyUI was already running. The refusal must say what
// actually happened and name a remedy that works from that state.
//
// The gate itself is NOT weakened: a direct mutation still requires the
// running server to have named the tree. Only the diagnosis and remedy are
// fixed. These tests drive runPanelActionInner with the PRODUCTION dep set
// over a real filesystem — the corroboration gate applies to it alone — with
// only the network/Manager edges mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-corroboration-${process.pid}.lock`,
);
process.env.COMFYUI_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "cmcp-data-corroboration-"));

const generation = vi.hoisted(() => ({ value: 0 }));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
  isLocalMode: () => true,
  isRemoteMode: () => false,
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyuiTargetGeneration: () => generation.value,
}));

const workspace = vi.hoisted(() => ({
  base: undefined as string | undefined,
  liveArgv: undefined as string[] | undefined,
  reachable: false,
  /** What the OS-observed process tier resolves to (#1133). undefined ⇒ the
   *  observation fails, leaving the server genuinely underivable. */
  observedRoot: undefined as string | undefined,
}));
const argvRoot = vi.hoisted(() => (argv: string[] | undefined) => {
  // Stand-in faithful to the real derivation's contract: an ABSOLUTE main.py
  // yields its dir; a RELATIVE one with no cwd yields nothing (the real
  // liveRootFromArgv refuses to hand back a bogus relative root).
  const main = argv?.find((a) => /(^|[\\/])main\.py$/.test(a));
  if (!main) return undefined;
  const dir = main.slice(0, main.length - "main.py".length).replace(/[\\/]$/, "");
  if (dir === "") return undefined; // bare "main.py" needs a cwd we don't have
  return dir;
});
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => workspace.base,
  resolveLocalWorkspaceBase: () => workspace.base,
  liveRootFromArgv: (argv: string[] | undefined) => argvRoot(argv),
  // The real resolver's second tier (#1133) — the OS-observed process anchor —
  // is OFF unless a test sets `workspace.observedRoot`, so the underivable
  // assertions below still describe a genuinely underivable server.
  resolveLiveServerRoot: (argv: string[] | undefined) => {
    const fromArgv = argvRoot(argv);
    if (fromArgv) return { root: fromArgv, source: "argv" };
    if (workspace.observedRoot) {
      return { root: workspace.observedRoot, source: "observed-process" };
    }
    return { source: "unresolved" };
  },
  getLiveServerSnapshot: async () => ({
    reachable: workspace.reachable,
    argv: workspace.liveArgv,
    cwd: undefined,
  }),
}));

// The Manager update is the failing edge from #916: it cannot resolve the
// pack in its own installed-pack list even though the pack is on disk.
vi.mock("../../services/node-management.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateCustomNode: async () => {
    throw new Error(
      `"comfyui-agent-panel" is not installed locally and was not found in the ComfyUI-Manager registry`,
    );
  },
}));

import {
  defaultDeps,
  PanelInstallError,
  runPanelActionInner,
  panelStatus,
  PANEL_REGISTRY_ID,
} from "../../services/panel-installer.js";
import {
  __resetPanelBaseCache,
  primePanelBase,
} from "../../services/panel-workspace.js";

let root: string;
let savedPin: string | undefined;

/** A registry-zip-shaped panel pack (pyproject, no .git) in custom_nodes. */
function writePanelPack(version: string): void {
  const dir = join(root, "custom_nodes", PANEL_REGISTRY_ID);
  mkdirSync(join(dir, "web", "js"), { recursive: true });
  writeFileSync(
    join(dir, "pyproject.toml"),
    `[project]\nname = "${PANEL_REGISTRY_ID}"\nversion = "${version}"\n`,
  );
  writeFileSync(join(dir, "web", "js", "comfyui-mcp-panel.js"), `// panel ${version}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-corroboration-"));
  mkdirSync(join(root, "custom_nodes"), { recursive: true });
  workspace.base = root;
  workspace.liveArgv = undefined;
  workspace.reachable = false;
  generation.value = 0;
  __resetPanelBaseCache();
  savedPin = process.env.COMFYUI_MCP_PANEL_PIN;
  process.env.COMFYUI_MCP_PANEL_PIN = "off";
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  __resetPanelBaseCache();
  if (savedPin === undefined) delete process.env.COMFYUI_MCP_PANEL_PIN;
  else process.env.COMFYUI_MCP_PANEL_PIN = savedPin;
});

describe("the resolution distinguishes 'could not ask' from 'asked, no derivable root' (#916)", () => {
  it("a REACHABLE server with an underivable argv root marks liveRootUnderivable (not liveProbeFailed)", async () => {
    workspace.reachable = true;
    workspace.liveArgv = ["main.py"]; // the `python main.py` shape: relative, no cwd
    const resolution = await primePanelBase({ force: true });
    expect(resolution.source).toBe("configured");
    expect(resolution.liveProbeFailed).toBeFalsy();
    expect(resolution.liveRootUnderivable).toBe(true);
  });

  it("an UNREACHABLE server marks liveProbeFailed (not liveRootUnderivable)", async () => {
    workspace.reachable = false;
    const resolution = await primePanelBase({ force: true });
    expect(resolution.source).toBe("configured");
    expect(resolution.liveProbeFailed).toBe(true);
    expect(resolution.liveRootUnderivable).toBeFalsy();
  });

  it("a reachable server with a derivable root is live-derived and carries neither flag", async () => {
    workspace.reachable = true;
    workspace.liveArgv = [join(root, "main.py")]; // absolute launch path
    const resolution = await primePanelBase({ force: true });
    expect(resolution.source).toBe("live-argv-root");
    expect(resolution.base).toBe(root);
    expect(resolution.liveRootUnderivable).toBeFalsy();
    expect(resolution.liveProbeFailed).toBeFalsy();
  });
});

describe("the update refusal names the ACTUAL corroboration failure and a working remedy (#916)", () => {
  it("reachable-but-underivable: no 'Start ComfyUI' — names the hand-update and absolute-relaunch remedies", async () => {
    writePanelPack("0.11.38");
    workspace.reachable = true;
    workspace.liveArgv = ["main.py"];

    const err = await runPanelActionInner("update", defaultDeps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);

    // The refusal still holds (the gate is not weakened)…
    expect(msg).toMatch(/REFUSED/);
    expect(msg).toMatch(/Panel update did NOT apply/);
    // …but the diagnosis is the one that actually happened…
    expect(msg).toMatch(/answered but its reported launch arguments did not identify/);
    expect(msg).toMatch(/CONFIGURED path rather than a corroborated one/);
    // …and the remedy is actionable from a state where ComfyUI is ALREADY
    // running: update the pack by hand where it lies, or relaunch so the root
    // can be corroborated next time.
    expect(msg).toMatch(/git -C /);
    expect(msg).toMatch(/pull --ff-only/);
    expect(msg).toMatch(/ABSOLUTE path to main\.py/);
    // The dead remedy is GONE from this branch.
    expect(msg).not.toMatch(/Start ComfyUI so its install root can be read/);
  });

  it("unreachable server: keeps the 'Start ComfyUI' remedy (there it is the right one)", async () => {
    writePanelPack("0.11.38");
    workspace.reachable = false;

    const err = await runPanelActionInner("update", defaultDeps).catch((e) => e);
    expect(err).toBeInstanceOf(PanelInstallError);
    const msg = String(err?.message ?? err);

    expect(msg).toMatch(/REFUSED/);
    expect(msg).toMatch(/Start ComfyUI so its install root can be read/);
    expect(msg).not.toMatch(/answered but its reported launch arguments/);
  });
});

describe("the status note makes the same distinction (#916)", () => {
  it("reachable-but-underivable: no 'Start/reach ComfyUI' dead remedy in the uncorroborated note", async () => {
    // custom_nodes exists but holds no panel → the "not installed" report.
    workspace.reachable = true;
    workspace.liveArgv = ["main.py"];
    const s = await panelStatus(defaultDeps);
    expect(s.installed).toBe(false);
    expect(s.note).toMatch(/UNCORROBORATED/);
    expect(s.note).toMatch(/ComfyUI IS running/);
    expect(s.note).toMatch(/ABSOLUTE path to main\.py/);
    expect(s.note).not.toMatch(/Start\/reach ComfyUI/);
  });

  it("unreachable: keeps the 'Start/reach ComfyUI' remedy", async () => {
    workspace.reachable = false;
    const s = await panelStatus(defaultDeps);
    expect(s.installed).toBe(false);
    expect(s.note).toMatch(/Start\/reach ComfyUI/);
    expect(s.note).not.toMatch(/ComfyUI IS running/);
  });
});
