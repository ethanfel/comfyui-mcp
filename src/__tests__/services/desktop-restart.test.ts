// Local Desktop restart (issue #400): a LOCALLY-installed ComfyUI **Desktop**
// instance is Electron-supervised. restart_comfyui must NOT kill it and re-spawn
// the exe (that leaves it down — stopped:true, started:false after 60 probes).
// Instead it fires a ComfyUI-Manager HTTP reboot and polls readiness, exactly
// like the remote path. Everything runs through mocked comfyuiFetch + execSync +
// spawn; no real process/port/network is touched.

import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({
  remoteMode: { value: false },
  targetGeneration: { value: 0 },
  fetchMock: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
  // argv that marks this as a Comfy Desktop install (see isDesktopApp()).
  desktopArgv: [
    "C:\\Users\\x\\AppData\\Local\\Programs\\Comfy Desktop\\resources\\ComfyUI\\main.py",
    "--listen",
    "127.0.0.1",
    "--port",
    "8188",
  ],
  getSystemStats: vi.fn(),
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
  comfyuiPath: { value: "/fake/comfy" },
}));

vi.mock("../../config.js", () => ({
  config: {
    resolvedPort: 8188,
    // MUTABLE, so a test can point it at the Desktop layout it wrote (#848). A getter
    // rather than a fixed string: the module is imported once and the value is read at
    // call time.
    get comfyuiPath() {
      return hoisted.comfyuiPath.value;
    },
    comfyuiBasePath: "",
  },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  // #848 instance fence: the argv comparison is only spent while the configured
  // target has not moved. Driven from the fixture so a retarget can be modelled.
  getComfyuiTargetGeneration: () => hoisted.targetGeneration.value,
  isRemoteMode: () => hoisted.remoteMode.value,
}));

/** A temp HOME holding a real Desktop installations.json for the #848 cases. Real files,
 *  not a mocked reader: the format belongs to Comfy Desktop, and a hand-built double
 *  agrees with whatever I believed it was — which was wrong twice. */
let desktopHome = "";
vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  const home = () => desktopHome || real.homedir();
  return { ...real, homedir: home, default: { ...real, homedir: home } };
});

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: RequestInit) => hoisted.fetchMock(url, init),
}));

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: hoisted.getSystemStats,
  resetClient: hoisted.resetClient,
  resetObjectInfoCache: hoisted.resetObjectInfoCache,
}));

vi.mock("node:child_process", () => ({
  execSync: hoisted.execSync,
  spawn: hoisted.spawn,
  execFile: vi.fn(),
}));

// #871: the argv comparison is fenced by the instance witness — without a
// continuous one it declines, and these tests assert the comparison's OUTPUT.
// They model an instance that stays put across the reboot, so the witness stays
// open. The dropped/unavailable-witness cases have their own suite
// (restart-instance-identity.test.ts).
vi.mock("../../services/instance-witness.js", () => ({
  acquireInstanceWitness: vi.fn(async () => ({
    url: "ws://127.0.0.1:8188/ws",
    alive: () => true,
    closedAt: () => undefined,
    close: () => {},
  })),
}));

import {
  restartComfyUI,
  __processControlTestHooks,
} from "../../services/process-control.js";
import { __portOwnerTestHooks } from "../../services/port-owner.js";

/**
 * One `/proc/net/tcp` row for a socket LISTENING on `port`, in the kernel's own
 * format (hex big-endian address:port, state `0A` = TCP_LISTEN).
 *
 * On Linux the port probe consults this table BEFORE `lsof`, because it sees every
 * socket regardless of owner. That makes it the host's answer, not the fixture's —
 * so a test that does not state what the table says is graded against the runner's
 * real network state, where port 8188 is idle, and the execSync port fixtures below
 * are never reached at all (#776 CI). This file models the host it means to model:
 * a live Desktop instance IS listening on the port, and lsof then names its owner.
 */
function procNetTableWithListenerOn(port: number): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  return [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 54321 1 0000000000000000 100 0 0 10 0`,
    "",
  ].join("\n");
}

type FetchCall = [string, RequestInit | undefined];
const pathOf = (u: string): string => new URL(u).pathname;
const findCall = (pred: (path: string) => boolean): FetchCall | undefined =>
  (hoisted.fetchMock.mock.calls as FetchCall[]).find(([u]) => pred(pathOf(u)));

beforeEach(() => {

  desktopHome = mkdtempSync(join(tmpdir(), "cmcp-desktop-restart-"));

  hoisted.comfyuiPath.value = "/fake/comfy";
  hoisted.remoteMode.value = false;
  hoisted.targetGeneration.value = 0;
  hoisted.fetchMock.mockReset();
  hoisted.resetClient.mockClear();
  hoisted.resetObjectInfoCache.mockClear();
  // RESET, not clear: a test that installs its own implementation (the #848 argv
  // cases below do) would otherwise leak it into every later test in this file —
  // and a getSystemStats that throws silently un-Desktops the whole fixture.
  hoisted.getSystemStats.mockReset();
  hoisted.getSystemStats.mockImplementation(async () => ({
    system: { argv: [...hoisted.desktopArgv] },
  }));
  hoisted.spawn.mockReset();
  hoisted.execSync.mockReset();
  // Map the running Desktop server's :8188 listener to a PID so gatherProcessInfo
  // resolves a live, Desktop-flagged instance — on either host platform.
  hoisted.execSync.mockImplementation((cmd: string) => {
    if (/netstat/i.test(cmd)) {
      return "  TCP    127.0.0.1:8188    0.0.0.0:0    LISTENING    4321\n";
    }
    // findPidByPort probes with `lsof -nP -iTCP:PORT -sTCP:LISTEN -Fpn`, whose
    // field output is p<pid> / n<addr:port> records — not the terse `-t` list.
    if (/lsof/i.test(cmd)) return "p4321\nn127.0.0.1:8188\n";
    return "";
  });
  // …and state the kernel table to match, so the Linux-first branch answers from
  // the fixture rather than from the runner's own sockets. `/proc/net/tcp6` is
  // absent here — one readable table is a complete answer.
  __portOwnerTestHooks.setProcNetReader((table) => {
    if (table === "/proc/net/tcp") return procNetTableWithListenerOn(8188);
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  __processControlTestHooks.reset();
  // The identity bracket around /system_stats (#776) runs for Desktop too — the
  // Desktop classification is itself derived from that same possibly-stale argv, so
  // it cannot be what decides whether to verify. It needs the port owner's creation
  // time at both ends; model the ordinary host where that is readable.
  // …and a LIVE Desktop shell above the backend (#814). A Manager reboot STOPS the
  // process and depends on that shell to start it again, so the restart now proves
  // the shell is there before dispatching anything. These tests are about what
  // happens AFTER the dispatch — the reboot firing, and above all that the instance
  // is never KILLED (#400) — so they must model the install they mean to model: an
  // ordinary Desktop with its supervisor running. The refusal path has its own tests.
  __processControlTestHooks.setProcessIdentityResolver((pid) => {
    if (pid === 300) {
      return {
        executablePath: "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe",
        commandLine: '"C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe"',
        startedAt: "2000", // the shell predates the backend it spawned
      };
    }
    // A COMPARABLE stamp, not a placeholder: the supervisor check confirms the
    // parent link causally (a parent cannot have started after its child), so a
    // stamp that cannot be compared against the shell's leaves the link unverified.
    return { startedAt: "5000", parentPid: 300 };
  });
  __processControlTestHooks.setParentPidResolver((pid) => (pid === 4321 ? 300 : undefined));
  __processControlTestHooks.setProcessExistsProbe(() => true);
});

afterEach(() => {

  if (desktopHome) rmSync(desktopHome, { recursive: true, force: true });

  desktopHome = "";
  __portOwnerTestHooks.reset();
  __processControlTestHooks.reset();
});

describe("restartComfyUI — local Desktop (Manager reboot, never kill) [#400]", () => {
  it("reboots the Desktop instance via Manager and never kills/re-spawns it", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    let statsCalls = 0;
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") {
        statsCalls++;
        // First probe after firing: origin still going down. Then ready.
        if (statsCalls <= 1) throw new Error("fetch failed");
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.stopped).toBe(true);
    expect(res.ready).toBe(true);
    // `started:false` beside `ready:true` (codex gate round 8). This call spawned
    // NOTHING — an acknowledged Manager request can be a no-op — so it has no
    // positive evidence it started anything, which is all `started` claims. That it
    // does not mean "the server is down" is exactly what `ready:true` is for.
    expect(res.started).toBe(false);
    expect(res.message).toContain("reboot request was acknowledged");
    expect(res.message).toContain("Desktop/supervised");
    // IT MUST NOT CLAIM A CYCLE IT NEVER WATCHED (codex gate round 6). This poller
    // has no down→up requirement at all — unlike the panel path, which certifies
    // only on an observed cycle — so all that was seen is an accepted request and a
    // later healthy probe. A Manager that accepts and then does nothing leaves a
    // healthy server that never restarted, and "came back" stops the user looking.
    expect(res.message).not.toMatch(/came back/i);
    expect(res.message).not.toMatch(/rebooted via/i);
    expect(res.message).toMatch(/not directly observed/i);
    // …AND THE STRUCTURED FIELDS MUST AGREE WITH IT (codex gate round 7). An agent
    // keys on the JSON, so `startup:"confirmed"` beside a message that withholds
    // confirmation hands back the definite signal the prose just refused.
    expect(res.startup).toBe("unconfirmed");

    // The Manager reboot was fired.
    expect(findCall((p) => p === "/v2/manager/reboot")).toBeDefined();
    // Crucially: the Desktop app was NEVER killed or re-spawned.
    expect(hoisted.spawn).not.toHaveBeenCalled();
    const killed = hoisted.execSync.mock.calls.some(([c]: [string]) =>
      /taskkill|\bkill\b|pkill/i.test(c),
    );
    expect(killed).toBe(false);
    expect(hoisted.resetClient).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // #848 — "it restarted" is not the answer to "did it pick up my new flag?"
  //
  // The reporter added `--disable-dynamic-vram` to their Desktop installation's
  // launch arguments, restarted, and was told the restart succeeded. It had, and
  // the flag was still absent: the server came back running exactly what it ran
  // before. Nothing in the report distinguished those two things, so the only way
  // to find out was to go and read /system_stats by hand.
  // -------------------------------------------------------------------------

  it("says the launch arguments are UNCHANGED across a Desktop reboot (#848)", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    // The default getSystemStats mock returns the SAME argv before and after —
    // which is precisely the shape #848 was filed about.
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") {
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(res.message).toContain("launch arguments are UNCHANGED");
    // It states exactly what equal argv establishes — that THIS RESTART did not
    // change them — and offers the remedy CONDITIONALLY. It must not claim the
    // user's saved settings were ignored: we never opened them, and their edit may
    // have been to something argv does not carry (codex gate).
    expect(res.message).toContain(
      "the same arguments were observed before this restart request and again now",
    );
    // "before this restart REQUEST", not "across this restart": on the Manager path
    // the observations are an accepted request and a later healthy probe — no
    // down→up cycle is required — so a completed restart may not be taken as given.
    expect(res.message).not.toMatch(/across this restart/i);
    // NOT "this restart did not change them" — two equal snapshots cannot show the
    // restart had no effect (a value can change and change back), and an accepted
    // Manager request is not proof a cycle even happened (codex gate round 3).
    expect(res.message).not.toMatch(/this restart did not change/i);
    expect(res.message).toContain("If you were expecting different arguments");
    expect(res.message).not.toMatch(/it did NOT\./);
    // The remedy has to be one the user can act on from where they are, and for a
    // Desktop install that is the app — not a COMFYUI_PATH or a CLI they never use.
    expect(res.message).toMatch(/fully quit the ComfyUI Desktop app/i);
    // It reports the OBSERVATION and stops there. Naming the mechanism (a Manager
    // reboot re-execs the running process) would assert a cause we never observed.
    expect(res.message).not.toMatch(/re-exec/i);
    // And it never contradicts the restart that genuinely happened.
    expect(res.message).toContain("ComfyUI is healthy now");
  });

  it("NAMES the saved Desktop argument that is not in force (#848)", async () => {
    // The behavioural half of the fix. The UNCHANGED sentence above has to hedge — "if you
    // were expecting different arguments" — because nothing had opened the user's settings.
    // #848 is exactly the case where they HAD changed them, so reading Desktop's saved
    // launchArgs turns that hint into the answer they came for.
    //
    // Driven through the real restart rather than by calling the helper: a source-text
    // wiring assertion passed with the call site's Desktop gate replaced by `false`, which
    // is a test of spelling, not of reachability.
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    // Desktop's own file, in a temp HOME, recording a flag the running server lacks.
    const root = join(desktopHome, "ComfyUI-Installs", "ComfyUI");
    const cfgDir = join(desktopHome, "AppData", "Roaming", "Comfy Desktop");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "installations.json"),
      JSON.stringify([
        {
          id: "inst-1",
          name: "My Desktop Install",
          installPath: root,
          sourceId: "standalone",
          launchArgs: "--disable-dynamic-vram",
        },
      ]),
      "utf8",
    );
    // …and the configured path is the main.py directory one level down, which is the
    // layout Desktop's installer actually produces.
    hoisted.comfyuiPath.value = join(root, "ComfyUI");

    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") return new Response(JSON.stringify({ system: {} }), { status: 200 });
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(res.message).toContain("--disable-dynamic-vram");
    expect(res.message).toContain("do NOT contain");
    expect(res.message).toContain("My Desktop Install");
    // The remedy is the only thing that applies it, and it is not this tool.
    expect(res.message).toContain("quit the ComfyUI Desktop app and relaunch");
  });

  it("says nothing extra when the saved arguments ARE in force (#848)", async () => {
    // The over-broad direction. A sentence on every healthy Desktop restart would train
    // the user to skip the one that matters.
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    const root = join(desktopHome, "ComfyUI-Installs", "ComfyUI");
    const cfgDir = join(desktopHome, "AppData", "Roaming", "Comfy Desktop");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "installations.json"),
      JSON.stringify([
        {
          id: "inst-1",
          name: "My Desktop Install",
          installPath: root,
          // Every one of these is in the fixture argv.
          launchArgs: "--listen --port",
          sourceId: "standalone",
        },
      ]),
      "utf8",
    );
    hoisted.comfyuiPath.value = join(root, "ComfyUI");

    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") return new Response(JSON.stringify({ system: {} }), { status: 200 });
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(res.message).not.toContain("do NOT contain");
    // …and the existing conditional remedy still stands on its own.
    expect(res.message).toContain("launch arguments are UNCHANGED");
  });

  it("says the launch arguments CHANGED when they actually did (#848)", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    const baseArgv = hoisted.desktopArgv;
    let rebooted = false;
    hoisted.getSystemStats.mockImplementation(async () => ({
      system: {
        argv: rebooted ? [...baseArgv, "--disable-dynamic-vram"] : [...baseArgv],
      },
    }));
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        rebooted = true;
        return new Response("", { status: 200 });
      }
      if (path === "/system_stats") {
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(res.message).toContain("launch arguments CHANGED");
    expect(res.message).toContain("--disable-dynamic-vram");
    // A genuine change must NOT be reported as the #848 no-op, and must not send
    // the user off to restart an app that already did what they asked.
    expect(res.message).not.toContain("UNCHANGED");
    expect(res.message).not.toMatch(/fully quit the ComfyUI Desktop app/i);
  });

  it("says NOTHING about launch arguments when the post-restart reading is missing (#848)", async () => {
    // An unread argv is not evidence of sameness. Silence is the only honest
    // output here — inferring "unchanged" from a failed read would manufacture the
    // very claim the user would act on.
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    let rebooted = false;
    hoisted.getSystemStats.mockImplementation(async () => {
      if (rebooted) throw new Error("ECONNRESET");
      return { system: { argv: [...hoisted.desktopArgv] } };
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        rebooted = true;
        return new Response("", { status: 200 });
      }
      if (path === "/system_stats") {
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    expect(res.message).not.toMatch(/launch arguments/i);
    // The restart itself is still reported — a missing extra detail must not
    // degrade the verdict about the thing that did happen.
    expect(res.message).toContain("ComfyUI is healthy now");
  });

  it("says NOTHING about launch arguments when the target moved mid-restart (#848)", async () => {
    // Both argv readings go through the MUTABLE configured target. If it moves
    // between them, the "before" belongs to instance A and the "after" to instance
    // B — and reporting that as one server's arguments changing (or not) would
    // invent a finding out of two unrelated observations (codex gate). Judged by the
    // monotonic generation, so an A->B->A round trip is caught too.
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") {
        // A hello retarget lands while the reboot is in flight.
        hoisted.targetGeneration.value += 1;
        return new Response("", { status: 200 });
      }
      if (path === "/system_stats") {
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.ready).toBe(true);
    // The identical argv would otherwise have produced the UNCHANGED note.
    expect(res.message).not.toMatch(/launch arguments/i);
    expect(res.message).toContain("ComfyUI is healthy now");
  });

  it("REFUSES, without dispatching, when the target moved while the instance was identified", async () => {
    // A retarget landing inside `acquireProcessInfo`'s await leaves `info` describing
    // instance A while the config — which the Manager reboot's base URL and the
    // relaunch port both read LIVE — points at B. Every assessment that would
    // authorize the stop was about A, so sending it is the #368/#814 lost server by
    // another route (codex gate round 11).
    //
    // This case used to be covered only as "the argv note is suppressed"; suppressing
    // a sentence was never the guarantee that mattered.
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 1000,
      intervalMs: 5,
    });
    let statsReads = 0;
    hoisted.getSystemStats.mockImplementation(async () => {
      // The FIRST read is acquireProcessInfo's; the retarget lands during it.
      statsReads += 1;
      if (statsReads === 1) hoisted.targetGeneration.value += 1;
      return { system: { argv: [...hoisted.desktopArgv] } };
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      const path = pathOf(url);
      if (path === "/v2/manager/reboot") return new Response("", { status: 200 });
      if (path === "/system_stats") {
        return new Response(JSON.stringify({ system: {} }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.stopped).toBe(false);
    expect(res.started).toBe(false);
    expect(res.startup).toBe("not-attempted");
    expect(res.message).toMatch(/Refusing to restart/i);
    expect(res.message).toMatch(/target changed while the running instance was being identified/i);
    expect(res.message).toMatch(/Nothing was stopped/i);
    // REFUSE BEFORE: no reboot may have been dispatched, and nothing killed.
    expect(findCall((p) => p === "/v2/manager/reboot")).toBeUndefined();
    expect(hoisted.spawn).not.toHaveBeenCalled();
    const killed = hoisted.execSync.mock.calls.some(([c]: [string]) =>
      /taskkill|\bkill\b|pkill/i.test(c),
    );
    expect(killed).toBe(false);
    // …and the user is handed the command to start it by hand.
    expect(res.restart_hint).toBeDefined();
  });

  it("refuses without killing when the Manager reboot cannot be fired (403)", async () => {
    __processControlTestHooks.setRemoteRebootTimingForTests({
      settleMs: 0,
      budgetMs: 100,
      intervalMs: 5,
    });
    hoisted.fetchMock.mockImplementation(async (url: string) => {
      if (pathOf(url).endsWith("/manager/reboot")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("", { status: 404 });
    });

    const res = await restartComfyUI();

    expect(res.started).toBe(false);
    expect(res.stopped).toBe(false);
    expect(res.message).toContain("403");
    // Refusal must leave the Desktop instance running — no kill, no re-spawn.
    expect(hoisted.spawn).not.toHaveBeenCalled();
    const killed = hoisted.execSync.mock.calls.some(([c]: [string]) =>
      /taskkill|\bkill\b|pkill/i.test(c),
    );
    expect(killed).toBe(false);
    expect(hoisted.resetClient).not.toHaveBeenCalled();
  });
});
