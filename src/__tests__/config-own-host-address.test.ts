// #742 (the 2026-08-12 recurrence) — the restart guard decided "not ours" from
// "not loopback", and those are different questions.
//
// A Pinokio ComfyUI on the SAME machine, addressed through that machine's own
// LAN address (`COMFYUI_URL=http://192.168.x.x:5000`), classified as remote.
// `preflightLocalRestart` opens with `if (isRemoteMode()) return { ok: true }`,
// so the refuse-safe check waved it through without assessing anything; the
// Manager reboot stopped the server, and Pinokio only relaunches on the
// dependency-install message, so it stayed down. The user's session was
// unrecoverable until they started Pinokio by hand.
//
// The original report's parts 1 and 2 (a misleading "Cancelled", and no
// failed-relaunch detection) were fixed, and the refuse-safe preflight already
// exists with its own suite. Nothing was missing. The guard was UNREACHABLE for
// this target — which is why these tests are about the classification, not the
// guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One fake NIC set for every test, shaped like a real Windows box: a LAN
// address, a loopback pair, a global and a link-local IPv6, and a virtual
// adapter.
const FAKE_IFACES = {
  Ethernet: [
    { address: "192.168.1.179", family: "IPv4", internal: false },
    { address: "fe80::5f10:6918:84e6:1873", family: "IPv6", internal: false },
    { address: "2600:1700:5892:bc10::22", family: "IPv6", internal: false },
  ],
  "Loopback Pseudo-Interface 1": [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "::1", family: "IPv6", internal: true },
  ],
  "vEthernet (Default Switch)": [{ address: "172.30.64.1", family: "IPv4", internal: false }],
  // A down/unconfigured adapter reporting an empty address. Present so the
  // empty-host guard is OBSERVABLE: without it, any host that normalizes to ""
  // would match this entry and be called ours.
  "Bluetooth Network Connection": [{ address: "", family: "IPv4", internal: false }],
};

let ifacesThrow = false;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = () => {
    if (ifacesThrow) throw new Error("EPERM: locked-down container");
    return FAKE_IFACES as unknown as ReturnType<typeof actual.networkInterfaces>;
  };
  return { ...actual, networkInterfaces, default: { ...actual, networkInterfaces } };
});

const OLD_ENV = process.env;
const OLD_ARGV = process.argv;

beforeEach(() => {
  ifacesThrow = false;
  vi.resetModules();
  process.env = { ...OLD_ENV };
  delete process.env.COMFYUI_URL;
  delete process.env.COMFYUI_MCP_FORCE_REMOTE;
  process.argv = ["node", "cli"];
});

afterEach(() => {
  process.env = OLD_ENV;
  process.argv = OLD_ARGV;
  vi.resetModules();
});

async function loadConfig() {
  return await import("../config.js");
}

describe("isOwnHostAddress — loopback is a SUBSET of 'this machine' (#742)", () => {
  it("accepts the loopback names it always did", async () => {
    const { isOwnHostAddress } = await loadConfig();
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]) {
      expect(isOwnHostAddress(h), h).toBe(true);
    }
  });

  it("accepts THIS machine's own LAN address — the case that caused the loss", async () => {
    const { isOwnHostAddress, isLoopbackHost } = await loadConfig();
    // The precise gap: not loopback, but unquestionably this machine.
    expect(isLoopbackHost("192.168.1.179")).toBe(false);
    expect(isOwnHostAddress("192.168.1.179")).toBe(true);
  });

  it("accepts an own IPv6 address however it is SPELLED", async () => {
    // URL canonicalization, not string equality. An interface reports
    // `2600:1700:5892:bc10::22`; a config may carry the identical address
    // written long-hand or upper-case, and calling those different machines is
    // exactly the false-negative that keeps the bug alive (review finding).
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("[2600:1700:5892:bc10::22]")).toBe(true);
    expect(isOwnHostAddress("2600:1700:5892:bc10:0:0:0:22")).toBe(true);
    expect(isOwnHostAddress("2600:1700:5892:BC10::22")).toBe(true);
  });

  it("accepts our IPv4 written as an IPv4-mapped IPv6 address, in EVERY spelling", async () => {
    // All five of these are 192.168.1.179, which is what the interface reports.
    // URL rewrites every one of them to `::ffff:c0a8:1b3`, so the fold back to
    // dotted form has to happen AFTER canonicalization — a first version folded
    // beforehand, caught only the dotted spelling, and left the hex forms
    // classified as someone else's machine (round-2 review).
    const { isOwnHostAddress } = await loadConfig();
    for (const h of [
      "::ffff:192.168.1.179",
      "[::ffff:192.168.1.179]",
      "::ffff:c0a8:1b3",
      "0:0:0:0:0:ffff:c0a8:1b3",
      "::FFFF:C0A8:1B3",
    ]) {
      expect(isOwnHostAddress(h), h).toBe(true);
    }
    // ...and the mapped forms of a NEIGHBOUR are still not ours.
    expect(isOwnHostAddress("::ffff:192.168.1.180")).toBe(false);
    expect(isOwnHostAddress("::ffff:c0a8:1b4")).toBe(false);
  });

  it("keeps the wildcard binds local, and leaves the odd mapped zero alone", async () => {
    const { isOwnHostAddress } = await loadConfig();
    // `::` and `0.0.0.0` are already in LOOPBACK_HOSTS — a wildcard bind is
    // reachable on loopback, so calling it local is pre-existing and right.
    // (I first asserted `::` was false here, from assumption rather than from
    // the set; the test caught me.)
    expect(isOwnHostAddress("::")).toBe(true);
    expect(isOwnHostAddress("0.0.0.0")).toBe(true);
    // `::ffff:0:0` is the mapped spelling of 0.0.0.0 and is NOT in that set, so
    // it folds to "0.0.0.0" and then matches no interface. Inconsistent with
    // the line above, but in the SAFE direction: it leaves the remote
    // short-circuit exactly as it was rather than pulling a target into
    // assessment on a technicality. Not worth widening a security-adjacent set
    // for a spelling nothing emits.
    expect(isOwnHostAddress("::ffff:0:0")).toBe(false);
  });

  it("rejects a LAN address on the same subnet that is NOT ours", async () => {
    // The neighbouring machine. Refusing here is what keeps this from becoming a
    // guard that fires on other people's servers.
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("192.168.1.180")).toBe(false);
    expect(isOwnHostAddress("10.0.0.5")).toBe(false);
  });

  it("rejects a HOSTNAME, even one that would resolve to us", async () => {
    // Deliberate: resolving would mean DNS on a path that must not block, and a
    // name can resolve differently — or be made to — between this check and the
    // action it authorizes. This gates a REFUSAL, so "cannot prove" must mean
    // "leave today's behaviour alone".
    const { isOwnHostAddress } = await loadConfig();
    for (const h of ["my-desktop.local", "comfy.lan", "example.com"]) {
      expect(isOwnHostAddress(h), h).toBe(false);
    }
  });

  it("rejects rather than throws when interfaces cannot be enumerated", async () => {
    ifacesThrow = true;
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("192.168.1.179")).toBe(false);
    // Loopback is decided without touching the interface list at all.
    expect(isOwnHostAddress("127.0.0.1")).toBe(true);
  });

  it("rejects a host that normalizes to nothing, even against an empty interface address", async () => {
    // `[]` normalizes to "" while NOT being loopback, so it reaches the
    // comparison, where the adapter above reporting an empty address would match
    // it. That is what makes the empty-host guard load-bearing rather than
    // decorative — remove it and this becomes true.
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("[]")).toBe(false);
  });

  it("rejects a scoped address, which cannot reach here through a URL anyway", async () => {
    // `%eth0` is NOT emptied — it survives canonicalization as written and then
    // matches nothing. Asserted because an earlier version stripped the zone
    // suffix on the theory that a configured target could carry one; it cannot.
    // `new URL("http://[fe80::1%eth0]/")` throws, so that code was unreachable
    // and its test was checking something production could never deliver.
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("%eth0")).toBe(false);
    expect(isOwnHostAddress("fe80::5f10:6918:84e6:1873%eth0")).toBe(false);
    // The same address WITHOUT a scope is ours.
    expect(isOwnHostAddress("fe80::5f10:6918:84e6:1873")).toBe(true);
  });

  it("rejects addresses that merely look like ours", async () => {
    // No DNS and no range logic — plain equality against what the interfaces
    // report. A malformed or near-miss address simply fails to match.
    const { isOwnHostAddress } = await loadConfig();
    expect(isOwnHostAddress("999.1.1.1")).toBe(false);
    expect(isOwnHostAddress("192.168.1")).toBe(false);
    expect(isOwnHostAddress("192.168.1.17")).toBe(false); // prefix of ours
  });
});

describe("targetIsOnThisMachine — the classification vs the physical fact (#742)", () => {
  it("is TRUE for a local install addressed by our own LAN address, while remote mode is also true", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.179:5000";
    const { targetIsOnThisMachine, isRemoteMode } = await loadConfig();
    // Both hold at once. That combination IS the bug, and the preflight now
    // keys on the second rather than the first.
    expect(isRemoteMode()).toBe(true);
    expect(targetIsOnThisMachine()).toBe(true);
  });

  it("is FALSE for a genuinely remote host", async () => {
    process.env.COMFYUI_URL = "http://192.168.1.180:8188";
    const { targetIsOnThisMachine, isRemoteMode } = await loadConfig();
    expect(isRemoteMode()).toBe(true);
    expect(targetIsOnThisMachine()).toBe(false);
  });

  it("--force-remote WINS over our own address", async () => {
    // A tunnel or port-forward makes the address say "here" about an instance
    // that is elsewhere; the flag is the user saying so. An inference must not
    // overrule an explicit statement of intent.
    process.env.COMFYUI_URL = "http://192.168.1.179:5000";
    process.env.COMFYUI_MCP_FORCE_REMOTE = "1";
    const { targetIsOnThisMachine } = await loadConfig();
    expect(targetIsOnThisMachine()).toBe(false);
  });

  it("is TRUE for an ordinary loopback target, so the local path is unchanged", async () => {
    process.env.COMFYUI_URL = "http://127.0.0.1:8188";
    const { targetIsOnThisMachine } = await loadConfig();
    expect(targetIsOnThisMachine()).toBe(true);
  });
});
