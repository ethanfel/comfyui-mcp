// Per-instance identity across a restart (#871) and identifying the local
// server WITHOUT process start times (#914).
//
// #871: the restart fences compare the endpoint (base URL) and the target
// generation — neither sees a server REPLACED at the same URL, which is the
// ordinary shape of two agents sharing one rig. The instance witness (a
// WebSocket held open across the call, instance-witness.ts) is the per-instance
// identity: it can only die with the instance that accepted it. The dispatch
// still goes ahead when the witness is gone — rebooting whatever serves the
// configured endpoint is what the caller asked for — but the argv comparison
// must then DECLINE rather than narrate two instances as one server.
//
// #914: the identify bracket ties the /system_stats answer to the port owner's
// pid by comparing creation stamps. A host that cannot read them (reported on
// macOS) used to get a flat refusal with no alternative path. Now a witness
// held open across the fetch stands in for the stamps: its peer is the process
// holding the listening socket, so a live witness + a stable pid is one
// continuous instance, and no pid reuse can leave the witness open.
//
// The witness is driven through a mocked instance-witness module; the platform
// is PINNED (process-control branches on os.platform() at module load — an
// unpinned test asserts different code on each CI runner).

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: true },
  fetchMock: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
  getSystemStats: vi.fn(),
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
  findComfyuiPython: vi.fn(),
  existsSync: vi.fn((_p: string) => true),
  // The witness the mocked factory hands out. `closedAt` is mutable so a test
  // drops the connection at the exact moment it means to model.
  witness: {
    available: true,
    closedAt: undefined as number | undefined,
    acquireCalls: 0,
  },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "linux" };
});

vi.mock("../../config.js", () => ({
  config: { resolvedPort: 8188, comfyuiPath: "/fake/comfy", comfyuiBasePath: "" },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
  getComfyuiTargetGeneration: () => 0,
  isRemoteMode: () => hoisted.remoteMode.value,
}));

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: RequestInit) => hoisted.fetchMock(url, init),
  // #1175 — the refusal now appends the panel-origin drift comparison. Stubbed
  // empty here so these #914 assertions keep testing identification alone.
  describeTargetDrift: () => "",
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: hoisted.getSystemStats,
  resetClient: hoisted.resetClient,
  resetObjectInfoCache: hoisted.resetObjectInfoCache,
}));

vi.mock("node:child_process", () => ({
  execSync: hoisted.execSync,
  spawn: hoisted.spawn,
  // workspace-env (imported transitively) promisifies execFile at module load,
  // so the mock must export a function.
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: hoisted.existsSync,
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  // No /proc in these tests: the port probe must fall through to lsof, which the
  // execSync fixtures answer. An errno-less throw would classify as "could not
  // look" instead of "no table on this host".
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error("no /proc in test"), { code: "ENOENT" });
  }),
}));

vi.mock("../../services/env-capabilities.js", () => ({
  findComfyuiPython: hoisted.findComfyuiPython,
}));

// The witness under test's control. acquireInstanceWitness is total in
// production (never throws, undefined = could not acquire); the mock mirrors it.
vi.mock("../../services/instance-witness.js", () => ({
  acquireInstanceWitness: vi.fn(async () => {
    hoisted.witness.acquireCalls += 1;
    if (!hoisted.witness.available) return undefined;
    return {
      url: "ws://127.0.0.1:8188/ws",
      alive: () => hoisted.witness.closedAt === undefined,
      closedAt: () => hoisted.witness.closedAt,
      close: () => {},
    };
  }),
}));

import {
  preflightLocalRestart,
  restartComfyUI,
  __processControlTestHooks,
} from "../../services/process-control.js";

type FetchCall = [string, RequestInit | undefined];
const pathOf = (u: string): string => new URL(u).pathname;
const findCall = (pred: (path: string) => boolean): FetchCall | undefined =>
  (hoisted.fetchMock.mock.calls as FetchCall[]).find(([u]) => pred(pathOf(u)));

const BASE_ARGV = ["python", "main.py", "--port", "8188"];

beforeEach(() => {
  hoisted.remoteMode.value = true;
  hoisted.fetchMock.mockReset();
  hoisted.resetClient.mockClear();
  hoisted.resetObjectInfoCache.mockClear();
  hoisted.getSystemStats.mockReset();
  hoisted.execSync.mockReset();
  hoisted.execSync.mockImplementation(() => "");
  hoisted.spawn.mockReset();
  hoisted.findComfyuiPython.mockReset();
  hoisted.existsSync.mockClear();
  hoisted.existsSync.mockImplementation(() => true);
  hoisted.witness.available = true;
  hoisted.witness.closedAt = undefined;
  hoisted.witness.acquireCalls = 0;
  __processControlTestHooks.reset();
});

afterEach(() => {
  __processControlTestHooks.reset();
});

/** A reboot that fires cleanly and a server that answers readiness at once. */
function mockRebootAndReady(onReboot?: () => void): void {
  __processControlTestHooks.setRemoteRebootTimingForTests({
    settleMs: 0,
    budgetMs: 1000,
    intervalMs: 5,
  });
  hoisted.fetchMock.mockImplementation(async (url: string) => {
    const path = pathOf(url);
    if (path === "/v2/manager/reboot") {
      onReboot?.();
      return new Response("", { status: 200 });
    }
    if (path === "/system_stats") {
      return new Response(JSON.stringify({ system: {} }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("#871 — the argv comparison is fenced by the instance, not the endpoint", () => {
  it("declines the comparison when the instance was replaced BEFORE the dispatch, but still reboots the endpoint", async () => {
    // Two agents share one rig: the other one restarts ComfyUI while this call
    // is awaiting its argv read. The base URL and the generation both stay put,
    // so only the witness can see it. The reboot still goes out — restarting
    // whatever serves the configured endpoint is what the caller asked for —
    // but the two argv readings may describe different lineages, so no
    // CHANGED/UNCHANGED sentence may be built from them.
    let statsCalls = 0;
    hoisted.getSystemStats.mockImplementation(async () => {
      statsCalls += 1;
      if (statsCalls === 1) {
        // The replacement lands while we hold the FIRST reading: the witness
        // drops here, before the dispatch below. A clearly-past stamp — the
        // boundary is deliberately strict, and a same-millisecond stamp is
        // ambiguous by design (event-delivery slack).
        hoisted.witness.closedAt = Date.now() - 5000;
        return { system: { argv: [...BASE_ARGV] } };
      }
      return { system: { argv: [...BASE_ARGV, "--other-agents-flag"] } };
    });
    mockRebootAndReady();

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    // The dispatch went ahead anyway — the endpoint is the caller's target.
    expect(findCall((p) => p === "/v2/manager/reboot")).toBeDefined();
    // …but the comparison declined: no narration of one instance changing.
    expect(res.message).not.toMatch(/launch arguments/i);
    expect(res.message).not.toContain("--other-agents-flag");
    expect(res.message).toContain("ComfyUI is healthy now");
  });

  it("compares normally when the witness dies AFTER the dispatch — consistent with our own reboot", async () => {
    // Our reboot is SUPPOSED to kill the witness: the server goes down during
    // the readiness wait, after the dispatch. A close stamped then is what an
    // ordinary reboot looks like, and must not silence the #848 report. (The
    // stamp is set ahead of the wall clock so the test is deterministic — the
    // assertion is about the ORDERING rule, not the clock.)
    let rebooted = false;
    hoisted.getSystemStats.mockImplementation(async () => ({
      system: { argv: rebooted ? [...BASE_ARGV, "--new-flag"] : [...BASE_ARGV] },
    }));
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        rebooted = true;
        return new Response("", { status: 200 });
      }
      if (path === "/system_stats") {
        // The server goes down under our reboot: the witness drop is observed
        // while we poll, after the dispatch.
        hoisted.witness.closedAt ??= Date.now() + 5000;
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(res.message).toContain("launch arguments CHANGED");
    expect(res.message).toContain("--new-flag");
  });

  it("compares normally when the witness never dies — the instance provably never went away", async () => {
    // A Manager that accepts the request and does nothing leaves the witness
    // open: both readings are then provably one instance's, and UNCHANGED is
    // exactly the right thing to say.
    hoisted.getSystemStats.mockImplementation(async () => ({
      system: { argv: [...BASE_ARGV] },
    }));
    mockRebootAndReady();

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(res.message).toContain("launch arguments are UNCHANGED");
  });

  it("declines the comparison when no witness could be acquired at all", async () => {
    // The token could not be read — an inconclusive. The reboot proceeds (the
    // endpoint is what was asked about); the comparison must not.
    hoisted.witness.available = false;
    let rebooted = false;
    hoisted.getSystemStats.mockImplementation(async () => ({
      system: { argv: rebooted ? [...BASE_ARGV, "--new-flag"] : [...BASE_ARGV] },
    }));
    mockRebootAndReady(() => {
      rebooted = true;
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(findCall((p) => p === "/v2/manager/reboot")).toBeDefined();
    expect(res.message).not.toMatch(/launch arguments/i);
    expect(res.message).toContain("ComfyUI is healthy now");
  });
});

describe("#914 — identification without process start times", () => {
  /**
   * The local fixtures: a live pid on the port (lsof answers, no /proc), an
   * answerable /system_stats, and a resolvable plain install. Platform is
   * pinned to linux (module-top mock), so the port probe is the lsof fallback.
   */
  function mockLocalServer(): void {
    hoisted.remoteMode.value = false;
    hoisted.execSync.mockImplementation((cmd: string) => {
      if (/netstat/i.test(cmd)) {
        return "  TCP    0.0.0.0:8188   0.0.0.0:0   LISTENING       4321";
      }
      if (/lsof/i.test(cmd)) return "p4321\nn127.0.0.1:8188\n";
      return "";
    });
    hoisted.getSystemStats.mockImplementation(async () => ({
      system: { argv: ["/fake/comfy/main.py", "--port", "8188"] },
    }));
    hoisted.findComfyuiPython.mockReturnValue("/fake/comfy/.venv/bin/python");
  }

  it("identifies the server via the witness when the host exposes no start times (#914)", async () => {
    // The reported macOS case: the port owner resolves, but its creation time
    // does not — an identity read that comes back with NOTHING. Before the
    // witness this was a flat refusal and panel_restart_comfyui could not run.
    mockLocalServer();
    __processControlTestHooks.setProcessIdentityResolver(() => undefined);

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(true);
    expect(preflight.observedArgv).toEqual(["/fake/comfy/main.py", "--port", "8188"]);
    // The WITNESS is what closed the bracket — prove the test is about it.
    expect(hoisted.witness.acquireCalls).toBeGreaterThan(0);
  });

  it("refuses — naming BOTH failed capabilities — when there are no stamps and no witness", async () => {
    mockLocalServer();
    __processControlTestHooks.setProcessIdentityResolver(() => undefined);
    hoisted.witness.available = false;

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(false);
    // The reason must name what was actually unavailable — the start-time read
    // AND the continuity check that tried to stand in for it — not a bare
    // "cannot identify".
    expect(preflight.reason).toMatch(/could not be tied to PID 4321/i);
    expect(preflight.reason).toMatch(/process start times/i);
    expect(preflight.reason).toMatch(/WebSocket held open/i);
    expect(preflight.reason).toMatch(/launcher that owns it/i);
  });

  it("a witness that DROPS mid-fetch does not close the bracket", async () => {
    // A dead connection is the ABSENCE of the continuity proof, never a stand-in
    // for it: the drop may be the very substitution the bracket exists to catch.
    mockLocalServer();
    __processControlTestHooks.setProcessIdentityResolver(() => undefined);
    hoisted.getSystemStats.mockImplementation(async () => {
      hoisted.witness.closedAt = Date.now(); // drops while the fetch is in flight
      return { system: { argv: ["/fake/comfy/main.py", "--port", "8188"] } };
    });

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toMatch(/could not be tied to PID 4321/i);
  });

  it("a pid CHANGE across the fetch refuses even with a live witness", async () => {
    // The witness proves continuity of the instance it connected to; it says
    // nothing about which pid owns the port. Both ends of the bracket still
    // have to agree on the number before the witness is even consulted.
    mockLocalServer();
    __processControlTestHooks.setProcessIdentityResolver(() => undefined);
    let lsofCalls = 0;
    hoisted.execSync.mockImplementation((cmd: string) => {
      if (/lsof/i.test(cmd)) {
        lsofCalls += 1;
        return lsofCalls === 1 ? "p4321\nn127.0.0.1:8188\n" : "p5555\nn127.0.0.1:8188\n";
      }
      return "";
    });

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(false);
    expect(preflight.reason).toMatch(/changed while ComfyUI was being identified/i);
    expect(preflight.reason).toMatch(/4321/);
    expect(preflight.reason).toMatch(/5555/);
  });

  it("readable stamps close the bracket WITHOUT the witness, as before", async () => {
    // The ordinary host must not grow a dependency on the WebSocket path: when
    // both ends stamp, the bracket closes on the stamps and the witness is
    // never acquired. (Pinned so a witness regression cannot silently ride the
    // stamp path.)
    mockLocalServer();
    __processControlTestHooks.setProcessIdentityResolver(() => ({
      startedAt: "stable-stamp",
    }));

    const preflight = await preflightLocalRestart();

    expect(preflight.ok).toBe(true);
    expect(hoisted.witness.acquireCalls).toBe(0);
  });
});
