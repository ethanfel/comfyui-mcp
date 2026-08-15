// #1374 — A COMFYUI-MANAGER DISPATCH IS ASKED ABOUT, NOT ASSUMED.
//
// The recurrence that motivated this: a Linux install whose ComfyUI-Manager
// REFUSED the fetch outright (security_level / network_mode=personal_cloud).
// `download_model action:"status"` reported the 13.2 GB job `done`; the target
// directory and a filesystem-wide search found no file.
//
// The mechanism is not a mystery and the code already said so in prose: a
// Manager job settles when the Manager QUEUE DRAINS, and Manager increments its
// done counter for a rejected item exactly as for a fetched one — the v2 status
// endpoint carries aggregate counts only, with no per-item result. So the drain
// is not evidence, and nothing ever looked for evidence that was.
//
// `verifyManagerVisibility` (#1086) is that evidence and already existed: it asks
// the CONNECTED server whether it now lists the entry, which is answerable
// remotely where `verifyLandedModel`'s on-disk stat is not. This pins that it now
// runs on the Manager route, that its baseline is captured, and — just as
// importantly — the two things it must NOT do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  /** One deferred PER downloadModel call, standing in for a Manager dispatch
   *  returning once its queue drained. Never a real transfer.
   *
   *  Per-call, and created BY the call, because the baseline is now read inside
   *  the settle closure (#1374 review, P1-2): a single resolver captured at
   *  module scope was `undefined` at the moment a test tried to use it, and the
   *  suite hung. Tests wait for the call with `nextDispatch`. */
  dispatches: [] as Array<{ promise: Promise<string>; resolve: (s: string) => void }>,
  /** What the server answers BEFORE the dispatch (the baseline), and what it
   *  answers AFTER. They are separate on purpose: with one value, "the file
   *  appeared" and "the file was always there" are the same fixture, and the
   *  `listedBefore` guard this suite exists to pin becomes untestable. undefined
   *  = could not be asked. Read at CALL time, so a test can change the world
   *  between two jobs. */
  baseline: undefined as boolean | undefined,
  after: undefined as boolean | undefined,
  /** Every (subfolder, filename) the listing probe was asked about, in order —
   *  so a test can prove the BASELINE was taken before the dispatch. */
  probed: [] as Array<{ sub: string; name: string }>,
  /** How many baseline probes had happened when each dispatch was made. The
   *  ORDERING evidence: a baseline read after its own dispatch is not a
   *  baseline, and a count alone cannot see that. */
  probedAtDispatch: [] as number[],
  visibilityCalls: 0,
  /** Held open by a test that needs to observe the job WHILE the post-dispatch
   *  check is still running — the window between publishing `done` and having a
   *  verdict, which is the one a grace timer can expire in. */
  visibilityGate: undefined as Promise<void> | undefined,
  landedCalls: 0,
  remote: true,
}));

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return { ...actual, isRemoteMode: () => hoisted.remote };
});

vi.mock("../../services/model-resolver.js", async () => {
  // The REAL verifyManagerVisibility, driven by an injected probe. Using the real
  // one is the point: a hand-written stub would let this suite pass while the
  // shipped verdict logic (including its `listedBefore` guard) did something else.
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    shouldDispatchDownloadToManager: vi.fn(async () => hoisted.remote),
    downloadModel: vi.fn(() => {
      hoisted.probedAtDispatch.push(hoisted.probed.length);
      let resolve!: (s: string) => void;
      const promise = new Promise<string>((r) => {
        resolve = r;
      });
      hoisted.dispatches.push({ promise, resolve });
      return promise;
    }),
    resolveDownloadTarget: vi.fn(async (_u: string, sub: string, filename?: string) => ({
      targetDir: `/M/${sub}`,
      filename: filename ?? "model.safetensors",
      targetPath: `/M/${sub}/${filename ?? "model.safetensors"}`,
    })),
    liveListingHasEntry: vi.fn(async (sub: string, name: string) => {
      hoisted.probed.push({ sub, name });
      return hoisted.baseline;
    }),
    managerJobFilename: actual.managerJobFilename,
    verifyManagerVisibility: vi.fn(
      async (sub: string, name: string, opts?: Record<string, unknown>) => {
        hoisted.visibilityCalls += 1;
        if (hoisted.visibilityGate) await hoisted.visibilityGate;
        return actual.verifyManagerVisibility(sub, name, {
          ...opts,
          attempts: 1,
          retryMs: 0,
          probe: async () => hoisted.after,
        });
      },
    ),
    verifyLandedModel: vi.fn(async (targetPath: string) => {
      hoisted.landedCalls += 1;
      return { verifiedPath: targetPath, liveVisible: "unknown" as const, note: "n/a" };
    }),
  };
});

import {
  startDownloadJob,
  getDownloadJob,
  resetDownloadJobs,
  describePlacement,
  type DownloadJob,
} from "../../services/download-jobs.js";


const URL_ = "https://huggingface.co/org/repo/resolve/main/te.safetensors";
const SUB = "text_encoders";
const NAME = "te.safetensors";

/** The descriptor string the Manager route hands back on acceptance. */
const DESCRIPTOR = (name = NAME) => `${SUB}/${name} (dispatched via ComfyUI-Manager)`;

/** Wait until downloadModel has been called at least `index + 1` times, then hand
 *  back that call's deferred. */
async function nextDispatch(
  index: number,
): Promise<{ promise: Promise<string>; resolve: (s: string) => void }> {
  await vi.waitFor(() => {
    if (hoisted.dispatches.length <= index) throw new Error(`dispatch ${index} not made yet`);
  });
  return hoisted.dispatches[index]!;
}

/** Run one Manager-routed download to completion and return the settled job. */
async function runManagerDownload(name = NAME): Promise<DownloadJob> {
  const started = await startDownloadJob(URL_, SUB, name);
  (await nextDispatch(0)).resolve(DESCRIPTOR(name));
  await started.settled;
  const job = getDownloadJob(started.job.id);
  if (!job) throw new Error("job vanished");
  return job;
}

beforeEach(() => {
  resetDownloadJobs();
  hoisted.dispatches = [];
  hoisted.probedAtDispatch = [];
  hoisted.baseline = undefined;
  hoisted.after = undefined;
  hoisted.probed = [];
  hoisted.visibilityCalls = 0;
  hoisted.visibilityGate = undefined;
  hoisted.landedCalls = 0;
  hoisted.remote = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("#1374 — a drained Manager queue is not evidence the file landed", () => {
  it("records NOT-VISIBLE when the connected server does not list the file", async () => {
    hoisted.baseline = false;
    hoisted.after = false;

    const job = await runManagerDownload();

    expect(job.viaManager).toBe(true);
    expect(job.live_visible).toBe("not-visible");
    expect(job.verify_note).toMatch(/does NOT list/);

    // And the RENDERER turns that into a positive finding, which is what
    // `action:"status"` prints. Before this, every Manager outcome printed one
    // static caveat and the reporter read `done`.
    const r = describePlacement(job);
    expect(r.confirmed).toBe(false);
    expect(r.warning).toMatch(/does NOT list/);
    // Names the cause the reporter actually hit, so the next one does not have to
    // discover it.
    expect(r.warning).toMatch(/security_level/);
    // …but NOT as `wrongPlace` — see the dedicated describe below.
    expect(r.wrongPlace).toBe(false);
  });

  it("records VISIBLE when the server lists it — and still refuses to call it confirmed", async () => {
    // Not there before, there after — the only shape that credits a landing to
    // THIS dispatch.
    hoisted.baseline = false;
    hoisted.after = true;

    const job = await runManagerDownload();

    expect(job.live_visible).toBe("visible");
    const r = describePlacement(job);
    // A listing proves a file of that NAME exists somewhere the server reads.
    // That is placement, never validity (#473).
    expect(r.confirmed).toBe(false);
    expect(r.warning).toMatch(/PLACEMENT, not validity/);
  });

  it("stays UNKNOWN, with the original caveat, when the server cannot be asked", async () => {
    hoisted.baseline = undefined;
    hoisted.after = undefined;

    const job = await runManagerDownload();

    expect(job.live_visible).toBe("unknown");
    expect(describePlacement(job).warning).toMatch(/NOT verified as landed/);
  });

  it("takes the BASELINE before dispatching, so a pre-existing file cannot read as a landing", async () => {
    // The trap `listedBefore` exists for on the local path (#369), and the Manager
    // path had no baseline at all: a file of the same name that was already there
    // would answer "visible" and be credited to a dispatch that fetched nothing.
    hoisted.baseline = true;
    hoisted.after = true;

    const job = await runManagerDownload();

    // The probe ran BEFORE the dispatch (that is the baseline).
    expect(hoisted.probed[0]).toEqual({ sub: SUB, name: NAME });
    // …and ORDERING, not just presence: zero baselines had been taken when the
    // dispatch went out would mean this "baseline" was read after the fact.
    expect(hoisted.probedAtDispatch[0]).toBe(1);
    // A pre-existing entry makes the post-check inconclusive, NOT successful.
    expect(job.live_visible).toBe("unknown");
    expect(job.verify_note).toMatch(/BEFORE this dispatch/);
  });

  it("NEVER demotes the job's status on a not-listed verdict", async () => {
    // Deliberate limit, and the reason it is a limit: a Manager dispatch returns
    // on ACCEPTANCE, so a large file is still arriving for minutes afterwards.
    // "not there yet" and "landed where the server cannot read" are
    // indistinguishable from here, and turning the first into an error would
    // break every slow download. The REPORT carries the finding; the status does
    // not pretend to a certainty nothing established.
    hoisted.baseline = false;
    hoisted.after = false;

    const job = await runManagerDownload();

    expect(job.status).toBe("done");
  });

  it("does not run the Manager check on a LOCAL download", async () => {
    hoisted.remote = false;
    hoisted.baseline = false;
    hoisted.after = false;

    const started = await startDownloadJob(URL_, SUB, NAME);
    (await nextDispatch(0)).resolve(`/M/${SUB}/${NAME}`);
    await started.settled;

    expect(hoisted.visibilityCalls).toBe(0);
    // The local route's own verification still runs — this changed nothing there.
    expect(hoisted.landedCalls).toBe(1);
  });

  it("still baselines the LOCAL route, under its RESOLVED filename", async () => {
    // The capture moved for both routes (#1374 review, P1-2), so the local
    // route's baseline is re-pinned here: it was previously covered by nothing,
    // and a refactor that dropped it would have been invisible.
    //
    // The resolved name matters. No filename was requested, so the local route's
    // baseline must use the one resolveDownloadTarget derived — asking about a
    // name nobody will ever write is a baseline of the wrong entry.
    hoisted.remote = false;
    hoisted.baseline = false;
    hoisted.after = false;

    const started = await startDownloadJob(URL_, SUB, undefined);
    (await nextDispatch(0)).resolve(`/M/${SUB}/model.safetensors`);
    await started.settled;

    expect(hoisted.probed).toEqual([{ sub: SUB, name: "model.safetensors" }]);
    expect(hoisted.probedAtDispatch[0]).toBe(1); // before the transfer, not after
  });
});

// ---------------------------------------------------------------------------
// The four P1s the pre-merge review returned NO-SHIP on. Each is driven through
// the REAL startDownloadJob settle path, because every one of them is a defect
// of WIRING — the helper was already correct in isolation.
// ---------------------------------------------------------------------------

describe("#1374 review P1-1 — an UNKNOWN baseline is not a negative baseline", () => {
  it("does not credit a listing to a dispatch whose baseline was never taken", async () => {
    // No filename was asked for, so there is no name to baseline: the Manager
    // derives it from the URL and only reports it in the dispatch descriptor.
    // The post-check still has a name (from that descriptor) and the server
    // answers YES — which, before this, read as a landing. It is not one: the
    // file may have been sitting there the whole time.
    hoisted.baseline = false; // would be a clean negative IF anyone had asked
    hoisted.after = true;

    const started = await startDownloadJob(URL_, SUB, undefined);
    (await nextDispatch(0)).resolve(DESCRIPTOR());
    await started.settled;
    const job = getDownloadJob(started.job.id)!;

    // Nothing was baselined — no name to baseline.
    expect(hoisted.probed).toHaveLength(0);
    expect(job.live_visible).toBe("unknown");
    expect(job.verify_note).toMatch(/never established/);
  });

  it("does not credit a listing when the baseline read FAILED", async () => {
    // The other route to the same conflation: the name was known, the listing
    // call threw. "Could not ask" is not "was not there".
    hoisted.after = true;
    const { liveListingHasEntry } = await import("../../services/model-resolver.js");
    vi.mocked(liveListingHasEntry).mockRejectedValueOnce(new Error("connection reset"));

    const job = await runManagerDownload();

    expect(job.live_visible).toBe("unknown");
    expect(job.verify_note).toMatch(/never established/);
  });

  it("does not credit a listing when the baseline read was UNANSWERABLE", async () => {
    // liveListingHasEntry's own third state: it resolved, with `undefined`.
    // Collapsing that into `false` is the same bug wearing a return value.
    hoisted.baseline = undefined;
    hoisted.after = true;

    const job = await runManagerDownload();

    expect(hoisted.probed).toHaveLength(1); // it WAS asked
    expect(job.live_visible).toBe("unknown");
    expect(job.verify_note).toMatch(/never established/);
  });
});

describe("#1374 review P1-2 — the baseline is taken AFTER the same-destination wait", () => {
  it("does not credit a queued dispatch with the file the job ahead of it landed", async () => {
    // Two dispatches to the SAME (subfolder, name) from DIFFERENT urls: distinct
    // request keys, so the second does not adopt the first, but one shared
    // remoteSerializeKey — so the second waits for the first (#467 P1-C).
    //
    // Taken at construction time, the second job's baseline was read BEFORE the
    // first job had written anything: "not there". It then sat in the queue while
    // the first landed the file, and its own post-check found it — and credited a
    // dispatch that may have been REJECTED outright with someone else's bytes.
    // That is #1374's exact failure, manufactured by the serialization.
    hoisted.baseline = false; // nothing there when the FIRST job starts
    hoisted.after = true; // the first job's file is listed afterwards

    const first = await startDownloadJob(URL_, SUB, NAME);
    const second = await startDownloadJob(`${URL_}?mirror=2`, SUB, NAME);

    // The second job must not have dispatched yet — it is queued behind the first.
    expect(hoisted.dispatches).toHaveLength(1);

    // The first lands, and the world changes: the server now lists the name.
    hoisted.baseline = true;
    (await nextDispatch(0)).resolve(DESCRIPTOR());
    await first.settled;
    expect(getDownloadJob(first.job.id)!.live_visible).toBe("visible");

    // Only NOW does the second dispatch go out — and its baseline must have been
    // read from the world as it is at that moment, not as it was at construction.
    (await nextDispatch(1)).resolve(DESCRIPTOR());
    await second.settled;

    expect(getDownloadJob(second.job.id)!.live_visible).toBe("unknown");
    expect(getDownloadJob(second.job.id)!.verify_note).toMatch(/BEFORE this dispatch/);
  });
});

describe("#1374 review P1-4 — a not-listed Manager dispatch is not a FAILURE", () => {
  it("reports the finding without flagging wrongPlace", async () => {
    // `wrongPlace` means DEMONSTRABLY misplaced, and apply_manifest renders it as
    // `failed`. Nothing here was demonstrated: a Manager dispatch returns on
    // ACCEPTANCE and its queue can drain long before the transfer does (#1197),
    // so "not listed yet" is equally a 13 GB fetch still in flight. A caller who
    // believes a false failure re-runs and pays for the transfer twice.
    hoisted.baseline = false;
    hoisted.after = false;

    const r = describePlacement(await runManagerDownload());

    expect(r.wrongPlace).toBe(false);
    // Not softened — merely typed correctly. The observation is still stated.
    expect(r.confirmed).toBe(false);
    expect(r.warning).toMatch(/does NOT list/);
    // …with the hedge that makes it honest rather than alarming.
    expect(r.warning).toMatch(/still be arriving/);
  });

  it("never flags wrongPlace on ANY Manager outcome", async () => {
    // The route has no on-disk observation at all, so no outcome it can reach is
    // a demonstrated misplacement. Enumerated rather than sampled: this is the
    // property apply_manifest's `failed` branch depends on.
    for (const [baseline, after] of [
      [false, false],
      [false, true],
      [true, true],
      [undefined, undefined],
    ] as Array<[boolean | undefined, boolean | undefined]>) {
      resetDownloadJobs();
      hoisted.dispatches = [];
      hoisted.probed = [];
      hoisted.baseline = baseline;
      hoisted.after = after;

      const job = await runManagerDownload();
      expect(describePlacement(job).wrongPlace, `baseline=${baseline} after=${after}`).toBe(false);
      expect(describePlacement(job).confirmed, `baseline=${baseline} after=${after}`).toBe(false);
    }
  });
});

describe("#1374 review P1-3 — the verdict is on the RECORD before any reader sees done", () => {
  it("marks the Manager route pending in the same step it publishes done", async () => {
    // The tool used to re-probe the server itself because a Manager job could be
    // `done` with no verification field at all — an unreadable state that looked
    // identical to a pre-fix record. The field is now always populated, so the
    // record is the single source of the verdict and the second round trip (which
    // could not pass the baseline, and so DEFEATED it) is gone.
    hoisted.baseline = false;
    hoisted.after = false;
    // HOLD the check open. Without this the window closes in the same microtask
    // and the assertion below reads the FINAL verdict instead of the transient
    // one — which is exactly how an earlier version of this test survived the
    // mutation that reverts the fix.
    let openTheGate!: () => void;
    hoisted.visibilityGate = new Promise<void>((r) => {
      openTheGate = r;
    });

    const started = await startDownloadJob(URL_, SUB, NAME);
    (await nextDispatch(0)).resolve(DESCRIPTOR());

    // The check has been ENTERED, so `done` is already published — and it is
    // parked on the gate, so no verdict has been written yet. This is precisely
    // the state a reader whose grace window expired here would see.
    await vi.waitFor(() => {
      if (hoisted.visibilityCalls < 1) throw new Error("check not entered yet");
    });
    const midFlight = getDownloadJob(started.job.id)!;
    expect(midFlight.status).toBe("done");
    // The defect: `done` with NO verification field at all, indistinguishable
    // from a pre-fix record, which is what the tool re-probed to cover for.
    expect(midFlight.live_visible).toBe("pending");
    // Whatever a reader catches here, it is never a confirmed success.
    expect(describePlacement(midFlight).confirmed).toBe(false);

    openTheGate();
    await started.settled;
    expect(getDownloadJob(started.job.id)!.live_visible).toBe("not-visible");
  });

  it("asks the server exactly ONCE per dispatch", async () => {
    // The removed hot-path call made this 2, on the one route where a round trip
    // costs a remote request.
    hoisted.baseline = false;
    hoisted.after = false;

    await runManagerDownload();

    expect(hoisted.visibilityCalls).toBe(1);
  });
});

describe("#1374 — verifyManagerVisibility's own contract, exercised directly", () => {
  // Through `importActual`, NOT the module-level import. The mock above wraps
  // this function and OVERRIDES its `probe`, so calling the mocked binding here
  // would have measured the fixture instead of the function — the first version
  // of these two tests did exactly that and reported "unknown" for a probe that
  // said no. A harness that answers its own question is worse than no test.
  const real = async () =>
    (await vi.importActual<typeof import("../../services/model-resolver.js")>(
      "../../services/model-resolver.js",
    )).verifyManagerVisibility;

  it("answers not-listed only after actually being told no", async () => {
    const r = await (await real())(SUB, NAME, {
      attempts: 1,
      retryMs: 0,
      probe: async () => false,
    });
    expect(r.visibility).toBe("not-listed");
  });

  it("answers unknown — never not-listed — when the probe cannot answer", async () => {
    // The distinction the whole fix rests on: "the server says no" and "the
    // server could not be asked" must never collapse into one verdict.
    const r = await (await real())(SUB, NAME, {
      attempts: 1,
      retryMs: 0,
      probe: async () => undefined,
    });
    expect(r.visibility).toBe("unknown");
  });
});
