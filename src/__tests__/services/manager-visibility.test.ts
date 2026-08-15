// #1086 — ask the server, instead of telling the caller to ask it.
//
// A Manager dispatch could only ever say "confirm with list_local_models before
// relying on it". A reporter who did not confirm lost a multi-GB model: ComfyUI-
// Manager picks its own destination root and does not necessarily honour
// extra_model_paths, so their file landed in the install's base models directory
// — an ephemeral 20GB overlay — while their ComfyUI read from a 100GB volume.
// Nothing contradicted "download complete" until a pod restart made it absent.
//
// verifyLandedModel cannot answer this. It stats the local filesystem first and
// returns `unknown` outright in remote mode — exactly the case a Manager dispatch
// creates, since there is no local file. But the LISTING question is answerable
// remotely, because it asks the server.
//
// THE TRAP THIS FILE PINS. A Manager dispatch returns when the task is ACCEPTED,
// so a large file is still arriving for minutes afterwards. "not-listed" must
// therefore NEVER be rendered as failure — "not there yet" and "landed somewhere
// the server cannot read" are indistinguishable from here, and claiming the
// second would be a fabricated failure mirroring the fabricated success.
//
// The probe is INJECTED. Mocking the module does not work: the function resolves
// `liveListingHasEntry` through a module-local binding, not the namespace object,
// so a first draft of this file silently queried the developer's real ComfyUI —
// which is why three of its assertions "failed" with plausible-looking values.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { verifyManagerVisibility } from "../../services/model-resolver.js";

describe("verifyManagerVisibility asks the live server", () => {
  it("reports VISIBLE when the server lists the file", async () => {
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("clip_vision", "clip_vision_h.safetensors", {
      // The baseline is EXPLICIT and negative — the only shape that lets a
      // listing be credited to this dispatch (#1374 review, P1-1).
      listedBefore: false,
      attempts: 1,
      probe,
    });

    expect(r.visibility).toBe("visible");
    expect(r.note).toMatch(/now lists clip_vision\/clip_vision_h\.safetensors/);
  });

  it("reports NOT-LISTED without calling it a failure", async () => {
    const probe = vi.fn().mockResolvedValue(false);

    const r = await verifyManagerVisibility("clip_vision", "clip_vision_h.safetensors", {
      attempts: 1,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("not-listed");
    // The load-bearing hedge: a dispatch returns on ACCEPTANCE.
    expect(r.note).toMatch(/not proof of failure/i);
    expect(r.note).toMatch(/still be arriving/i);
    // …and the actionable half, which is what the reporter needed.
    expect(r.note).toMatch(/does not necessarily honour/);
    expect(r.note).toMatch(/ephemeral overlay/);
  });

  it("says UNKNOWN when the server could not be asked — not 'not-listed'", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);

    const r = await verifyManagerVisibility("loras", "x.safetensors", {
      attempts: 2,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("unknown");
    expect(r.note).toMatch(/could not be asked/);
    // An unanswerable probe must not masquerade as a negative observation.
    expect(r.note).not.toMatch(/does NOT list/);
  });

  it("says UNKNOWN when the file was ALREADY listed before the dispatch", async () => {
    // A pre-existing file of the same name would otherwise read as a successful
    // landing — the same trap the local path's `listedBefore` guards.
    const probe = vi.fn();

    const r = await verifyManagerVisibility("checkpoints", "sdxl.safetensors", {
      listedBefore: true,
      attempts: 1,
      probe,
    });

    expect(r.visibility).toBe("unknown");
    expect(r.note).toMatch(/already listed .* BEFORE this dispatch/);
    expect(probe).not.toHaveBeenCalled(); // no point asking
  });

  it("retries before concluding not-listed, and stops early once seen", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const r = await verifyManagerVisibility("loras", "x.safetensors", {
      listedBefore: false,
      attempts: 3,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("visible");
    expect(probe).toHaveBeenCalledTimes(2); // stopped at the hit
  });

  it("never throws outward when the probe explodes", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("connection reset"));

    const r = await verifyManagerVisibility("loras", "x.safetensors", {
      attempts: 1,
      retryMs: 0,
      probe,
    });

    // A verification hiccup must not turn a transfer into an error.
    expect(r.visibility).toBe("unknown");
  });
});

// #473 — LISTING IS NOT VALIDITY, and saying otherwise was my regression.
//
// A reporter on 0.50.34 got six byte-identical 10,038-byte CivitAI Login HTML
// documents saved as models, and observed that `download_model` "sometimes
// upgraded the filename-presence check to CONFIRMED". That upgrade was this
// check, shipped in 0.50.29.
//
// Manager writes whatever the URL returned under the name you asked for, and it
// cannot carry this MCP's credentials — so an auth-gated URL yields a login page
// with a .safetensors name. It lists perfectly. It deserializes into
// "SafetensorError: header too large" the moment a LoraLoader touches it.
//
// This is #473's original failure (the landing watcher treating presence as
// success) reintroduced one layer up, which is why the wording is pinned here.
describe("a visible verdict never implies the payload is a real model", () => {
  it("says placement, and explicitly disclaims validity", async () => {
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("loras", "KNP_000003000.safetensors", {
      listedBefore: false,
      attempts: 1,
      probe,
    });

    expect(r.visibility).toBe("visible");
    expect(r.note).toMatch(/PLACEMENT, not validity/i);
    // The mechanism, so the reader can tell WHY a listing proves so little.
    expect(r.note).toMatch(/whatever the URL returned under the name you asked for/i);
    expect(r.note).toMatch(/cannot carry this MCP's credentials/i);
    // The tell a caller can actually act on.
    expect(r.note).toMatch(/login page is ~10KB/i);
  });

  it("does not use the word CONFIRMED for a Manager dispatch", async () => {
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("loras", "x.safetensors", {
      listedBefore: false,
      attempts: 1,
      probe,
    });

    // The label is the whole defect: "CONFIRMED" reads as "this worked".
    expect(r.note).not.toMatch(/\bCONFIRMED\b/);
  });
});

// #1374 review, P1-1 — THE BASELINE IS A TRI-STATE AND THE THIRD STATE IS THE ONE
// THAT WAS LOST.
//
// The guard checked `listedBefore === true` only, so BOTH "we asked and it was
// not there" and "we never found out" arrived as `undefined` and were treated as
// a clean negative. A dispatch that fetched nothing could then be credited with a
// file that had been sitting there all along — #369, on the one route that had no
// guard against it. Only an EXPLICIT `false` may license a `visible` verdict.
describe("an UNKNOWN baseline is not a negative baseline", () => {
  it("downgrades a listing to UNKNOWN when the baseline could not be established", async () => {
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("checkpoints", "sdxl.safetensors", {
      listedBefore: "unknown",
      attempts: 1,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("unknown");
    expect(r.note).toMatch(/never established/);
    // It must not borrow the confident wording of a real landing.
    expect(r.note).not.toMatch(/so the dispatch landed/);
  });

  it("downgrades a listing to UNKNOWN when NO baseline was passed at all", async () => {
    // Omission is the shape a caller reaches by accident, so it must fail the
    // same safe way as an explicit "unknown" rather than silently permitting.
    const probe = vi.fn().mockResolvedValue(true);

    const r = await verifyManagerVisibility("checkpoints", "sdxl.safetensors", {
      attempts: 1,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("unknown");
    expect(r.note).toMatch(/never established/);
  });

  it("still reports a NEGATIVE observation with an unknown baseline", async () => {
    // Only the POSITIVE direction is withheld. "The server says no" is a real
    // observation and does not need a baseline to be worth reporting — folding it
    // into `unknown` would throw away the whole #1374 finding.
    const probe = vi.fn().mockResolvedValue(false);

    const r = await verifyManagerVisibility("checkpoints", "sdxl.safetensors", {
      listedBefore: "unknown",
      attempts: 1,
      retryMs: 0,
      probe,
    });

    expect(r.visibility).toBe("not-listed");
  });
});

// THE WIRING. The label lives in the tool's Manager branch, so the helper tests
// above cannot see a revert to "CONFIRMED:" there — the same call-site blindness
// that has bitten this suite repeatedly. Read the source, the way the other
// prose gates in this repo do.
describe("the tool's Manager branch never labels a listing as confirmation", () => {
  it("has no CONFIRMED label on the viaManager path", () => {
    const src = readFileSync(
      new URL("../../tools/model-management.ts", import.meta.url),
      "utf-8",
    );
    const start = src.indexOf("const text = job.viaManager");
    expect(start, "the viaManager branch must still exist").toBeGreaterThan(-1);
    const branch = src.slice(start, start + 1400);

    // The regression, stated exactly: `CONFIRMED: ${managerSeen.note}`.
    expect(branch).not.toMatch(/`CONFIRMED[:\s]/);
    expect(branch).toMatch(/LISTED \(placement only, NOT validity\)/);
  });

  // #1374 review, P1-3 — and it does not ASK AGAIN, either.
  //
  // downloadAction used to call verifyManagerVisibility a second time and prefer
  // that result. The baseline lives inside startDownloadJob and is unreachable
  // from a tool, so that call could never pass one — which made it structurally
  // incapable of telling a landing from a pre-existing file, and preferring it
  // DEFEATED the baselined verdict the job had just recorded. It also spent a
  // second Manager-only network round trip on an answered question.
  //
  // A behavioural test cannot see this (both calls return the same thing on a
  // healthy server — the defect is which one is trusted, and what it cost), so
  // the call site is read, the way the label above is.
  it("does not re-probe the server from the tool's hot path", () => {
    const src = readFileSync(
      new URL("../../tools/model-management.ts", import.meta.url),
      "utf-8",
    );
    // Bound the slice to downloadAction's own body: a match anywhere else in this
    // 1000-line file would be a different call site with different stakes.
    const start = src.indexOf("async function downloadAction(");
    expect(start, "downloadAction must still exist").toBeGreaterThan(-1);
    const rest = src.slice(start);
    const end = rest.indexOf("\r\n}\r\n") >= 0 ? rest.indexOf("\r\n}\r\n") : rest.indexOf("\n}\n");
    expect(end, "downloadAction's body must be delimitable").toBeGreaterThan(0);
    const body = rest.slice(0, end);

    // Sanity: the slice really does contain the Manager render, or the assertion
    // below would pass by looking at the wrong text.
    expect(body).toMatch(/LISTED \(placement only, NOT validity\)/);
    // The defect, stated exactly: a CALL, not the word in a comment.
    expect(body).not.toMatch(/verifyManagerVisibility\s*\(/);
    // And the replacement is actually wired: the verdict comes off the record.
    expect(body).toMatch(/job\.live_visible === "visible"/);
  });
});
