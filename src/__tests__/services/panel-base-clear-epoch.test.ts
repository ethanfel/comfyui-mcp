// #1222 — a background prime landed its answer AFTER the cache was cleared.
//
// Three tests in the recovery-wording family flaked, and the wording is what
// makes it expensive: `panelRecoveryContext()` picks between two entirely
// different remedies depending on `installPanelUsable`, one input to which is
// the panel-base cache. A test that inherits a primed cache gets the other
// remedy and fails on an assertion about English, which is indistinguishable
// from a real regression.
//
// MY FILED DIAGNOSIS WAS WRONG, and this file exists partly to record that: the
// issue said the affected tests never call `__resetPanelBaseCache()`. They all
// do, and had for days. The actual cause is written down in
// ui-bridge.test.ts's own comment — a capability refusal fires an unawaited
// `void primePanelBase()`, and "a late resolution lands in whichever test is
// running when it settles". A reset cannot fix that: the write arrives mid-test,
// after the reset has run.
//
// WHY THE EXISTING GUARD MISSED IT. `primePanelBase` already refuses to clobber
// a newer write, by capturing `cached` at probe start and comparing by
// reference. That has exactly one blind spot and it is the common case: a probe
// that starts with an EMPTY cache records `undefined`, a clear leaves it
// `undefined`, and the two compare equal — so the clear is invisible and the
// stale answer is written in. A clear is an EVENT, not a value, so it is now
// counted; `undefined → undefined` is indistinguishable by reference and
// unmistakable by count.
//
// The mitigation until now was POSITIONAL — those tests sit last in their
// describe so a late resolution has nothing left to perturb. That works until
// someone adds a test after them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The race is a SEQUENCE here, not a timing hope: `primePanelBase` awaits at
// least once before it writes, so clearing synchronously after the call — and
// awaiting afterwards — puts the clear strictly between probe-start and
// probe-settle every run. No sleeps, no ordering luck, no mocks.
const {
  primePanelBase,
  lastPanelBaseResolution,
  __resetPanelBaseCache,
  __setPanelBaseForTests,
  clearPanelDiskObservation,
} = await import("../../services/panel-workspace.js");

beforeEach(() => {
  __resetPanelBaseCache();
});

afterEach(() => {
  __resetPanelBaseCache();
});

describe("a clear beats a probe that started before it (#1222)", () => {
  it("does not repopulate the cache after __resetPanelBaseCache", async () => {
    // Seed, so there is something for a stale probe to differ from.
    __setPanelBaseForTests("/seeded/base");
    expect(lastPanelBaseResolution()?.base).toBe("/seeded/base");

    // A probe starts while a value is cached...
    const inFlight = primePanelBase({ force: true });
    // ...the cache is cleared mid-probe (the afterEach of the test that fired it)...
    __resetPanelBaseCache();
    expect(lastPanelBaseResolution(), "cleared means cleared").toBeUndefined();

    // ...and the probe settles.
    await inFlight;

    expect(
      lastPanelBaseResolution(),
      "a probe that predates the clear must not undo it",
    ).toBeUndefined();
  });

  it("holds even when the cache was EMPTY when the probe started", async () => {
    // THE REPORTED SHAPE. A capability refusal fires the background prime
    // precisely because nothing was primed yet, so `cached` is undefined at
    // start — and the reference guard compares undefined to undefined and lets
    // the write through. This is the case that actually flaked.
    expect(lastPanelBaseResolution()).toBeUndefined();

    const inFlight = primePanelBase();
    __resetPanelBaseCache();
    await inFlight;

    expect(
      lastPanelBaseResolution(),
      "the empty-to-empty case is the one the reference check cannot see",
    ).toBeUndefined();
  });

  it("still caches normally when NO clear intervenes", async () => {
    // The other direction: the guard must not disable caching outright, or every
    // caller re-probes and the cache stops being a cache.
    __setPanelBaseForTests("/kept/base");
    const before = lastPanelBaseResolution();
    expect(before?.base).toBe("/kept/base");

    await primePanelBase();

    expect(lastPanelBaseResolution(), "an untouched cache survives").toBeDefined();
  });

  it("returns the probe's own answer to ITS caller even when the cache is left alone", async () => {
    // The caller asked and this is what the probe found — withholding it would
    // turn a cache-hygiene rule into a wrong answer for the one caller who is
    // entitled to it.
    //
    // Compared against a CONTROL run rather than checked for truthiness: a bare
    // `{ source: "none" }` placeholder is also truthy, and substituting one drops
    // the diagnostic fields (`liveProbeFailed`, `liveRootUnderivable`) that
    // downstream uses to explain WHY nothing resolved. Asserting deep equality
    // with the un-cleared answer pins the property without naming those fields,
    // so it keeps holding as they change.
    const control = await primePanelBase({ force: true });
    __resetPanelBaseCache();

    const inFlight = primePanelBase({ force: true });
    __resetPanelBaseCache();
    const answer = await inFlight;

    expect(answer, "the caller gets the probe's OWN answer, not a placeholder").toEqual(control);
    expect(lastPanelBaseResolution(), "but the shared cache stays cleared").toBeUndefined();
  });

  it("counts EVERY clear, so two in a row are not one", async () => {
    const inFlight = primePanelBase({ force: true });
    __resetPanelBaseCache();
    __resetPanelBaseCache();
    await inFlight;

    expect(lastPanelBaseResolution()).toBeUndefined();
  });
});

// CODEX REVIEW asked which OTHER paths clear the cache, and found a production
// one: `clearPanelDiskObservation()` also drops the resolved base, and it runs on
// every panel hello — the moment ComfyUI may have restarted with different launch
// flags and therefore a different custom_nodes tree. Its own comment says keeping
// the previous root would "let the very next operation freeze the wrong tree",
// which is exactly what an in-flight probe does when it writes its pre-hello
// answer back in a moment later. Tests were covered by __resetPanelBaseCache;
// production was not.
describe("a hello's clear also beats an in-flight probe (#1222)", () => {
  it("clearPanelDiskObservation is not undone by a probe that predates it", async () => {
    __setPanelBaseForTests("/pre-restart/base");
    const inFlight = primePanelBase({ force: true });

    clearPanelDiskObservation();
    expect(lastPanelBaseResolution(), "the hello cleared it").toBeUndefined();

    await inFlight;

    expect(
      lastPanelBaseResolution(),
      "the pre-restart root must not be frozen back in",
    ).toBeUndefined();
  });

  it("holds for the empty-cache start, the case reference comparison cannot see", async () => {
    const inFlight = primePanelBase();
    clearPanelDiskObservation();
    await inFlight;

    expect(lastPanelBaseResolution()).toBeUndefined();
  });
});
