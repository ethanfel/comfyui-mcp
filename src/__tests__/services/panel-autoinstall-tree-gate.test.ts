// #820 — the on-load auto-install gate asked only "is the CURRENT base
// resolution live-derived?", never whether that resolution names the tree the
// install is about to land in. The tree is frozen at pin time; the resolution
// is re-read at the gate; and the two can diverge WITHOUT any retarget — the
// pin-time probe fails (configured fallback frozen), then a re-resolution of
// the SAME target recovers and names the server's real --base-directory. The
// pinned-generation check cannot see that (no retarget, no bump), so a
// live-derived resolution naming tree B used to license an unattended install
// into frozen tree A — an observation of one tree licensing a mutation of
// another, landing in a custom_nodes nothing loads (no panel, no error).
//
// These tests drive `ensurePanelInstalled` with the PRODUCTION dep set — the
// gate applies to it alone — over a real filesystem, with only the network
// edge mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMFYUI_MCP_PANEL_LOCK = join(
  tmpdir(),
  `cmcp-lock-autoinstall-${process.pid}.lock`,
);

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
}));
const argvRoot = vi.hoisted(() => (argv: string[] | undefined) => {
  const main = argv?.find((a) => a.endsWith("main.py"));
  return main ? main.slice(0, main.length - "/main.py".length) : undefined;
});
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => workspace.base,
  liveRootFromArgv: (argv: string[] | undefined) => argvRoot(argv),
  // Two-tier, faithful to the real resolver (#1133). No observed-process tier is
  // exercised here: these tests are about the argv path.
  resolveLiveServerRoot: (argv: string[] | undefined) => {
    const fromArgv = argvRoot(argv);
    return fromArgv ? { root: fromArgv, source: "argv" } : { source: "unresolved" };
  },
  getLiveServerSnapshot: async () => ({
    reachable: workspace.reachable,
    argv: workspace.liveArgv,
    cwd: undefined,
  }),
}));

// The reachability probe is the seam where the mid-operation cache flip lands:
// it runs AFTER the base was frozen and BEFORE the gate reads the resolution.
const probeHook = vi.hoisted(() => ({ fn: undefined as undefined | (() => void) }));
vi.mock("../../comfyui/client.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSystemStats: async () => {
    probeHook.fn?.();
    return {};
  },
}));

// The install itself is a spy with a sentinel failure: reaching it at all is
// the signal that the gate PASSED, and the sentinel travels into the ensure
// result's reason (ensurePanelInstalled converts errors to `unavailable`).
const installSpy = vi.hoisted(() => ({
  calls: [] as Array<{ id?: string }>,
  sentinel: "INSTALL-REACHED-PAST-THE-GATE",
}));
vi.mock("../../services/node-management.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  installCustomNode: async (opts: { id?: string }) => {
    installSpy.calls.push(opts);
    throw new Error(installSpy.sentinel);
  },
}));

import {
  defaultDeps,
  ensurePanelInstalled,
  PANEL_REGISTRY_ID,
} from "../../services/panel-installer.js";
import { __resetPanelBaseCache } from "../../services/panel-workspace.js";

let rootA: string;
let savedPin: string | undefined;
let savedAutoinstall: string | undefined;

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), "cmcp-autoinstall-"));
  mkdirSync(join(rootA, "custom_nodes"), { recursive: true });
  workspace.base = rootA;
  workspace.liveArgv = undefined;
  workspace.reachable = false;
  probeHook.fn = undefined;
  installSpy.calls.length = 0;
  generation.value = 0;
  __resetPanelBaseCache();
  // Deterministic pin state regardless of the host's settings file.
  savedPin = process.env.COMFYUI_MCP_PANEL_PIN;
  process.env.COMFYUI_MCP_PANEL_PIN = "off";
  savedAutoinstall = process.env.COMFYUI_MCP_PANEL_AUTOINSTALL;
  delete process.env.COMFYUI_MCP_PANEL_AUTOINSTALL;
});

afterEach(() => {
  rmSync(rootA, { recursive: true, force: true });
  __resetPanelBaseCache();
  if (savedPin === undefined) delete process.env.COMFYUI_MCP_PANEL_PIN;
  else process.env.COMFYUI_MCP_PANEL_PIN = savedPin;
  if (savedAutoinstall === undefined) delete process.env.COMFYUI_MCP_PANEL_AUTOINSTALL;
  else process.env.COMFYUI_MCP_PANEL_AUTOINSTALL = savedAutoinstall;
});

describe("the auto-install gate requires the live resolution to name THIS tree (#820)", () => {
  it("a live-derived resolution naming a DIFFERENT tree does not license the install", async () => {
    // Pin-time probe fails → the configured fallback (rootA) is frozen. By the
    // time the gate runs, the server answers and names its real root (rootB):
    // no retarget, no generation bump — the window the generation check
    // cannot see.
    const rootB = mkdtempSync(join(tmpdir(), "cmcp-autoinstall-live-"));
    mkdirSync(join(rootB, "custom_nodes"), { recursive: true });
    probeHook.fn = () => {
      workspace.reachable = true;
      workspace.liveArgv = [`${rootB}/main.py`];
    };
    try {
      const res = await ensurePanelInstalled({ deps: defaultDeps });
      expect(res.action).toBe("unavailable");
      // The reason must state the ACTUAL cause — a different tree named — not
      // fold it into the configured-fallback wording.
      expect(res.reason).toMatch(/DIFFERENT tree/);
      expect(res.reason).toContain(rootB);
      expect(res.reason).not.toMatch(/came from configuration/);
      // And nothing may have been installed into the frozen tree.
      expect(installSpy.calls).toEqual([]);
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("a same-URL restart onto a NEW tree inside the cache TTL does not license the install", async () => {
    // The pin primes a live-derived rootA. ComfyUI then restarts at the SAME
    // URL onto rootB — no retarget, no generation bump, and the 60s
    // resolution cache would still vouch for A. The gate must re-resolve
    // rather than trust the cache.
    const rootB = mkdtempSync(join(tmpdir(), "cmcp-autoinstall-restart-"));
    mkdirSync(join(rootB, "custom_nodes"), { recursive: true });
    workspace.reachable = true;
    workspace.liveArgv = [`${rootA}/main.py`];
    probeHook.fn = () => {
      workspace.liveArgv = [`${rootB}/main.py`]; // the restart lands mid-operation
    };
    try {
      const res = await ensurePanelInstalled({ deps: defaultDeps });
      expect(res.action).toBe("unavailable");
      expect(res.reason).toMatch(/DIFFERENT tree/);
      expect(res.reason).toContain(rootB);
      expect(installSpy.calls).toEqual([]);
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("a live-derived resolution naming the SAME tree lets the install proceed", async () => {
    // The reverse fold — an over-strict gate refusing a corroborated install —
    // is the same defect pointed at a positive. The pin primes live-derived
    // rootA; the gate must pass and reach the Manager install.
    workspace.reachable = true;
    workspace.liveArgv = [`${rootA}/main.py`];
    const res = await ensurePanelInstalled({ deps: defaultDeps });
    expect(installSpy.calls).toEqual([{ id: PANEL_REGISTRY_ID, version: "nightly" }]);
    // The sentinel proves the install was attempted; ensure converts the
    // thrown sentinel into an unavailable carrying it.
    expect(res.action).toBe("unavailable");
    expect(res.reason).toContain(installSpy.sentinel);
  });

  it("a merely configured resolution is still refused (the original #766 case)", async () => {
    const res = await ensurePanelInstalled({ deps: defaultDeps });
    expect(res.action).toBe("unavailable");
    expect(res.reason).toMatch(/came from configuration/);
    expect(res.reason).not.toMatch(/DIFFERENT tree/);
    expect(installSpy.calls).toEqual([]);
  });
});
