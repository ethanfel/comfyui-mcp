// #1371 r3 — the divergent-install refusal fires ONLY in a race, so it never fires
// for the case it was added to catch.
//
// AN EARLIER REVISION OF THIS FILE CLAIMED THE BRANCH WAS DEAD CODE. That was
// WRONG, and the correction is the point of this file. The argument was:
//
//   `divergentInstallRefusal` is reached from ONE place, admitted by
//   `if (!liveRootAtResolve)` — which holds exactly when
//   `isLiveAuthoritativeModelsDir(source)` is FALSE. Its evidence comes from
//   `isUnderLiveModelRoots`, which bails with `{inRoots: undefined}` unless
//   `modelsDirNamedByServer(dest.source)` is TRUE. `modelsDirNamedByServer` is a
//   deliberate SUBSET of `isLiveAuthoritativeModelsDir` ({argv-flag, live-root} vs
//   {argv-flag, live-root, observed-root}), so admitting implies the evidence bails.
//
// Every step of that is true, and the conclusion still does not follow. It holds
// the two `source` values to ONE value. Production resolves the first in
// `resolveModelSubfolderWithLiveRoot`, then fetches a SECOND, FRESH snapshot inside
// `isUnderLiveModelRoots`. Nothing pins the server across that await. When the
// second observation names a root the first could not, the sets no longer apply and
// the refusal FIRES — measured below, not argued.
//
// TWO PRECONDITIONS, both measured:
//   1. the two observations disagree — non-server-named first, server-named second
//      (an outage then recovery, a restart onto another install, a reused port);
//   2. the destination directory ALREADY EXISTS, because a negative answer requires
//      `realpath` to succeed on both sides. A first download into a category the
//      stale install lacks is allowed through even under the race.
//
// (2) is also what hid this: the earlier fixture downloaded into `vae`, which the
// stale install does not have, so it measured UNKNOWN and read it as deadness.
//
// SO THE HONEST STATEMENT IS NARROWER THAN "DEAD" AND NARROWER THAN "WORKS":
// in the steady state — one server, both observations agreeing — the refusal cannot
// fire, which covers #1371 as reported. It fires only when the server changes
// underneath a single download. #1371 is therefore still not fixed by this guard,
// but the branch is live code with a real, if rare, effect.
//
// The pre-existing suite could see none of this: it tests `divergentInstallRefusal`
// as a PURE function with `inRoots: false` handed in, and its "#1371 WIRING" block
// is `readFileSync` + regex over source text. Both pass whether or not production
// can reach the branch — the "tested but unreachable" shape.
//
// THESE ARE CHARACTERIZATION TESTS. They pass on main today and are not a
// regression net for a fix — there is no fix here, and that is the finding.
//
// What they pin:
//   - the working half: `isUnderLiveModelRoots` answers `false` correctly whenever
//     `dest.source` IS one the server named. Nothing is wrong with that function.
//   - the STEADY STATE: `resolveDownloadTarget` really does enter the refusal branch
//     in the reporter's shape — proven from its own return value, not from source
//     text — and refuses nothing there.
//   - the RACE: some interleaving of a changing server DOES fire the refusal, and
//     the same interleaving does NOT when the destination has yet to be created.
//   - a SAME-SOURCE LEMMA, explicitly scoped, which is why the steady state is safe.
//     It is no longer load-bearing for reachability; it cannot be, because it
//     assumes the agreement that the race breaks.
//
// I also tried the obvious repair — fall back to `snapshot.liveRoot` when the
// models dir is not live-derived — and it is a NO-OP. output-dir.ts adopts the
// live root as the models dir precisely when `live.root && existsSync(live.root)`
// (with `argv-flag` covering the explicit-flag case), so a non-authoritative
// source implies the live root is EITHER underivable OR absent from this
// filesystem — and `snapshot.liveRoot` is published whenever `live.root` is
// truthy, WITHOUT an existence check. The fallback therefore gets `undefined` or
// a path that is not here; `canon()` fails `realpath`, `fullyCanonical` goes
// false, and the answer is `undefined` exactly as before. Reverted rather than
// shipped. See the issue thread for where a real fix would have to live.
//
// NOTE: #1371 is not wholly unguarded on main — `resolveModelsDirWithBases` grew a
// separate refusal (output-dir.ts, "#1371 — DO NOT WRITE INTO A BASE THE SERVER
// DEMONSTRABLY DOES NOT READ") that fires EARLIER, when the server's own listing
// positively contradicts the configured base. That one works. It just needs a
// non-empty, contradicting listing, which is exactly what the reporter's sparse
// category did not provide — so the dead refusal downstream is still the one that
// was supposed to cover this case, and still cannot.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve, sep } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// REAL directories: a negative answer is only given when both the target and
// the live root can be canonicalized (realpath must succeed), which is also the
// reporter's situation — two ComfyUI installs that both exist.
const SANDBOX = mkdtempSync(join(tmpdir(), "divergent-"));
const CONNECTED_ROOT = join(SANDBOX, "comfy-running");
const STALE_ROOT = join(SANDBOX, "comfy-other");
for (const r of [CONNECTED_ROOT, STALE_ROOT]) {
  mkdirSync(join(r, "models", "checkpoints"), { recursive: true });
}

/** What `/system_stats` reports for the CONNECTED server. */
let argv: string[] = [];
/** Whether the server answers at all (an outage must not fabricate a refusal). */
let reachable = true;
/** The cwd `/system_stats` reports. Undefined = the server cannot anchor itself. */
let cwd: string | undefined = CONNECTED_ROOT;

/** How many times the running server was asked to describe itself. The refusal
 *  branch's own work — `isUnderLiveModelRoots` — costs one extra `/system_stats`,
 *  which is how the reachability test observes that the BODY ran and not merely
 *  that its condition was true. */
let statsCalls = 0;

/** Lets a test rewrite what the server reports BETWEEN calls, by call number —
 *  the only way to simulate a server that changes across an await boundary. */
let onStats: ((call: number) => void) | undefined;

vi.mock("../../comfyui/client.js", () => ({
  getSystemStats: async () => {
    statsCalls += 1;
    onStats?.(statsCalls);
    if (!reachable) throw new Error("ECONNREFUSED");
    return { system: { argv, cwd } };
  },
  resetClient: () => {},
  resetObjectInfoCache: () => {},
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    // COMFYUI_PATH points at the OTHER install — the reporter's exact mistake.
    config: { ...actual.config, comfyuiPath: STALE_ROOT },
    getComfyUIBaseUrl: () => "http://127.0.0.1:8190",
    isRemoteMode: () => false,
  };
});

async function membershipFor(targetDir: string, category?: string) {
  vi.resetModules();
  const mod = await import("../../services/model-resolver.js");
  return mod.isUnderLiveModelRoots(targetDir, category);
}

beforeEach(() => {
  reachable = true;
  onStats = undefined;
  cwd = CONNECTED_ROOT;
  // An ABSOLUTE `main.py` under the connected install, no --models-directory. The
  // install root resolves from argv and EXISTS here, so output-dir adopts
  // `<root>/models` with `source = "live-root"` — server-named, and therefore the
  // one state in which `isUnderLiveModelRoots` is allowed to answer at all. That is
  // what the first tests below exercise: the working half, reached DIRECTLY.
  // Production never calls it in this state — see the REACHED AND INERT test.
  argv = [join(CONNECTED_ROOT, "main.py"), "--port", "8190"];
});

afterEach(() => {
  vi.resetModules();
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("#1371 the divergent-install refusal: reached, and unable to answer", () => {
  it("a destination under the STALE install is reported OUTSIDE the live roots", async () => {
    // The working half. Called DIRECTLY like this — with a live-authoritative
    // source — the function answers correctly. That is exactly why the bug is so
    // easy to miss: nothing is wrong with this function. Its only caller just
    // never invokes it in a state where it can answer.
    const m = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBe(false);
    expect(m.liveRoot).toBe(resolve(join(CONNECTED_ROOT, "models")));
  });

  it("a destination under the CONNECTED install is reported inside", async () => {
    // The other direction, and the one that must not regress: a correct
    // placement must never be refused.
    const m = await membershipFor(join(CONNECTED_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBe(true);
  });

  it("says UNKNOWN when the server is unreachable, rather than accusing", async () => {
    // An outage makes the resolver fall back to COMFYUI_PATH. Reporting that as
    // "a different install" would refuse a correct download during a blip.
    reachable = false;
    const m = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBeUndefined();
  });

  it("says UNKNOWN when the server cannot name its own root", async () => {
    // A bare relative `main.py` AND no reported cwd: nothing to anchor against,
    // so the honest answer is unknown — NOT a refusal built on COMFYUI_PATH.
    //
    // The cwd has to be withheld too. With it present the resolver anchors on
    // the OS-observed process dir and CAN name the root, which is correct. An
    // earlier version of this test dropped only argv and asserted UNKNOWN — it
    // was wrong about the product rather than finding a bug.
    argv = ["main.py"];
    cwd = undefined;
    const m = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(m.inRoots).toBeUndefined();
  });

  it("STEADY STATE: the refusal branch runs in the reporter's shape and refuses nothing", async () => {
    // The reporter's case, and the common one: ONE server, answering consistently at
    // every observation. This is the half of the story the "dead code" claim got
    // right — see the RACE test below for the half it got wrong.
    //
    // A test asserting "no refusal was thrown" passes just as happily when the
    // branch never executed, so it proves nothing on its own. This drives the real
    // production entry point and reads REACHABILITY off its own return value:
    // `resolveDownloadTarget` returns `liveRootAtResolve`, and the refusal branch
    // is gated on exactly `if (!liveRootAtResolve)`. So `liveRootAtResolve ===
    // undefined` in the RESULT is a direct observation that the branch was entered.
    //
    // The shape is the reporter's: a reachable ComfyUI whose install root is known
    // but NOT present on this filesystem (Docker / a port-forward), so the models
    // dir cannot come from the server and falls back to a stale COMFYUI_PATH.
    const containerRoot = join(SANDBOX, "container-only", "ComfyUI"); // never created
    argv = [join(containerRoot, "main.py"), "--port", "8190"];
    cwd = containerRoot;

    vi.resetModules();
    const mod = await import("../../services/model-resolver.js");
    const before = statsCalls;
    const res = await mod.resolveDownloadTarget(
      "https://example.invalid/m.safetensors",
      "vae",
      "m.safetensors",
    );
    const consultedDuring = statsCalls - before;

    // REACHABILITY, two independent readings.
    //
    // (1) The gate's own condition, observed from the production return value: the
    // branch is gated on exactly `if (!liveRootAtResolve)` and this IS that value.
    expect(res.liveRootAtResolve).toBeUndefined();
    // (2) The branch BODY ran. (1) alone cannot show that — deleting the branch
    // outright leaves the returned value untouched — so this counts the extra
    // `/system_stats` the body's `isUnderLiveModelRoots` call necessarily costs.
    // Measured at 3 on current main (resolution, the symlink-ancestor guard, then
    // the membership evidence); deleting the branch drops it to 2 and fails here.
    expect(consultedDuring).toBeGreaterThanOrEqual(3);

    // ...and it refused nothing: the destination is inside the STALE install, which
    // is #1371 happening, on current main, past a guard written to stop it.
    // `+ sep`, so a sibling like "comfy-other-2" cannot satisfy this by prefix.
    expect(resolve(res.targetDir).startsWith(resolve(STALE_ROOT) + sep)).toBe(true);

    // WHY it refused nothing: in that very state the evidence cannot answer.
    const m = await mod.isUnderLiveModelRoots(res.targetDir, "vae");
    expect(m.inRoots).toBeUndefined();
  });

  /**
   * Drive the production entry point with a server whose self-report CHANGES between
   * `/system_stats` calls, swapping after call `swapAfter`. Returns the refusal
   * message, or null when the download was allowed.
   *
   * Server A reports a root that is real but NOT on this filesystem (a container /
   * port-forward), so the models dir falls back to the stale COMFYUI_PATH and the
   * source is NOT server-named. Server B reports an absolute `main.py` that does
   * exist here, so its source IS server-named and the evidence can answer.
   */
  async function refusalWithServerSwap(
    swapAfter: number,
    category: string,
  ): Promise<string | null> {
    const containerRoot = join(SANDBOX, "container-only", "ComfyUI"); // never created
    vi.resetModules();
    reachable = true;
    // Per-scenario, or `swapAfter` would be compared against an ever-growing counter
    // and every sweep iteration after the first would silently run the SAME
    // (post-swap) server — measuring "cannot fire" as a fixture artefact.
    statsCalls = 0;
    onStats = (n) => {
      if (n <= swapAfter) {
        argv = [join(containerRoot, "main.py"), "--port", "8190"];
        cwd = containerRoot;
      } else {
        argv = [join(CONNECTED_ROOT, "main.py"), "--port", "8190"];
        cwd = CONNECTED_ROOT;
      }
    };
    const mod = await import("../../services/model-resolver.js");
    try {
      await mod.resolveDownloadTarget(
        "https://example.invalid/m.safetensors",
        category,
        "m.safetensors",
      );
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  it("IT CAN FIRE: two resolutions that disagree across the await DO reach a refusal", async () => {
    // THIS TEST EXISTS BECAUSE THE BRANCH IS NOT DEAD, and an earlier revision of
    // this file claimed it was. The claim rested on the two `source` values being
    // equal — but production resolves the first in
    // `resolveModelSubfolderWithLiveRoot` and then fetches a SECOND, FRESH snapshot
    // inside `isUnderLiveModelRoots`. Nothing pins the server across that await.
    //
    // A server that is a container/port-forward at the first observation and a
    // locally-rooted ComfyUI at the second — an outage then recovery, a restart onto
    // a different install, a reused port — yields a non-server-named source first and
    // a server-named one second. The evidence can then answer `false`, and the
    // refusal fires. Measured, not argued.
    //
    // SWEPT rather than pinned to one call index: the number of `/system_stats` calls
    // is an implementation detail, and hardcoding "swap after call 2" would silently
    // stop exercising the race if that count ever changed, going green for the wrong
    // reason. Asserting "SOME interleaving fires" survives that.
    const fired: number[] = [];
    for (const swapAfter of [0, 1, 2, 3, 4, 5]) {
      const msg = await refusalWithServerSwap(swapAfter, "checkpoints");
      if (msg?.startsWith("NOT downloaded: the connected ComfyUI")) fired.push(swapAfter);
    }
    expect(fired.length).toBeGreaterThan(0);

    // And the control: with NO swap — the same server at every observation, which is
    // the steady state and the reporter's own case — it never fires.
    const steady = await refusalWithServerSwap(99, "checkpoints");
    expect(steady).toBeNull();
  });

  it("...but only when the destination already exists on disk", async () => {
    // The second precondition, and the one that hid this from an earlier revision of
    // this file: its fixture downloaded into `vae`, which the stale install does not
    // have. `isUnderLiveModelRoots` only answers `false` when everything it compares
    // could be canonicalized, so a not-yet-created destination fails `realpath`,
    // `fullyCanonical` goes false, and the honest answer is UNKNOWN.
    //
    // So the same race that refuses a `checkpoints` download silently allows a `vae`
    // one. That is the difference between "impossible" and "my fixture never tried
    // it", which is exactly what the old set-intersection proof could not see.
    for (const swapAfter of [0, 1, 2, 3, 4, 5]) {
      expect(await refusalWithServerSwap(swapAfter, "vae")).toBeNull();
    }
  });

  it("SAME-SOURCE LEMMA (not a deadness proof): equal sources cannot both admit and answer", async () => {
    // SCOPE — read this before using it for anything.
    //
    // This is a lemma about the two PREDICATES, and it holds only for a single
    // `source` value fed to both. It was once the load-bearing proof that the refusal
    // is dead code, and in that role it was WRONG: it silently assumed the two
    // resolutions agree, which is the very thing production does not guarantee. The
    // test above measures what actually happens when they disagree.
    //
    // What it still establishes, and all it establishes: in the STEADY STATE — one
    // server, one answer at both observations — a source that admits the refusal can
    // never be one that answers it. That is why the common case cannot fire.
    //
    // Enumerated over the WHOLE `ModelsDirSource` union rather than matched against
    // a predicate NAME, because the name has already changed once: main narrowed the
    // evidence gate from `isLiveAuthoritativeModelsDir` to `modelsDirNamedByServer`,
    // which a regex on the old name reported as a repair when it was the opposite.
    const { isLiveAuthoritativeModelsDir, modelsDirNamedByServer } = await import(
      "../../services/output-dir.js"
    );
    type Source = Parameters<typeof isLiveAuthoritativeModelsDir>[0];
    // PARSED from the union declaration, not hardcoded here.
    //
    // A hand-written list silently stops covering a `ModelsDirSource` that someone
    // adds later, and the types cannot catch that: tsconfig EXCLUDES `src/__tests__`,
    // so `npm run lint` never type-checks this file and vitest strips types without
    // checking them. A `Record<Source, true>` exhaustiveness trick was tried here and
    // is worthless for exactly that reason — verified by adding a member and watching
    // lint stay green. Reading the union keeps a new member automatically covered.
    const dirSrc = readFileSync(join(HERE, "../../services/output-dir.ts"), "utf8");
    const decl = /export type ModelsDirSource =([\s\S]*?);/.exec(dirSrc);
    expect(decl, "could not find the ModelsDirSource union").not.toBeNull();
    const ALL_SOURCES = [...(decl as RegExpExecArray)[1].matchAll(/"([a-z-]+)"/g)].map(
      (m) => m[1],
    ) as Source[];

    // A failed parse yields an empty list, which would make every assertion below
    // trivially true. Pin the count and two known members so it cannot pass vacuously.
    expect(ALL_SOURCES.length).toBeGreaterThanOrEqual(6);
    expect(ALL_SOURCES).toContain("configured-base");
    expect(ALL_SOURCES).toContain("live-root");

    // The call site is admitted when liveRootAtResolve is falsy, and that is set
    // exactly when the source IS live-authoritative — so the branch runs only for
    // sources where the predicate is FALSE.
    const admitsTheRefusal = ALL_SOURCES.filter((s) => !isLiveAuthoritativeModelsDir(s));
    // The evidence bails with `{inRoots: undefined}` unless the server NAMED the dir.
    const canAnswer = ALL_SOURCES.filter((s) => modelsDirNamedByServer(s));

    // Neither set may be empty, or the emptiness — not the contradiction — would be
    // carrying this test.
    expect(admitsTheRefusal.length).toBeGreaterThan(0);
    expect(canAnswer.length).toBeGreaterThan(0);
    // ...and they are disjoint, so ONE source cannot both admit and answer.
    expect(admitsTheRefusal.filter((s) => canAnswer.includes(s))).toEqual([]);

    // Anchor the enumeration to the two gates it is reasoning about, so this cannot
    // drift into a fact about two predicates nothing calls.
    const src = readFileSync(join(HERE, "../../services/model-resolver.ts"), "utf8");
    expect(src).toMatch(/if \(!liveRootAtResolve\) \{[\s\S]{0,400}?divergentInstallRefusal\(\{/);
    expect(src).toMatch(
      /liveRootAtResolve: isLiveAuthoritativeModelsDir\(source\) \? modelsRoot : undefined/,
    );
    expect(src).toMatch(
      /if \(!modelsDirNamedByServer\(dest\.source\)\) return \{ inRoots: undefined \}/,
    );

    // inRoots is therefore always undefined on that path, and divergentInstallRefusal
    // returns null at its first line.
    const { divergentInstallRefusal } = await import(
      "../../services/download-root-correspondence.js"
    );
    expect(divergentInstallRefusal({ targetDir: "/anywhere", inRoots: undefined })).toBeNull();
  });

  it("prefers an explicit --models-directory over the install root", async () => {
    // When the server DOES name its models dir, that is the authority, even if
    // it sits outside the install root.
    const explicit = join(SANDBOX, "explicit-models");
    mkdirSync(join(explicit, "checkpoints"), { recursive: true });
    argv = [join(CONNECTED_ROOT, "main.py"), "--models-directory", explicit];
    const inside = await membershipFor(join(explicit, "checkpoints"), "checkpoints");
    expect(inside.inRoots).toBe(true);
    const outside = await membershipFor(join(STALE_ROOT, "models", "checkpoints"), "checkpoints");
    expect(outside.inRoots).toBe(false);
  });
});
