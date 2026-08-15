// #1331 — after a reconnect, every mutating panel_* call is refused with "this workflow
// has no trusted identity", while reads keep working. The reporter's recovery took four
// calls to reach a state the panel already believed it was in.
//
// THIS IS THE MIGRATION TWIN OF #689, which hello-stamp-retention.test.ts already defends
// for the same-id path. Same asymmetry, one branch over:
//
//   • a CARRIED-but-stale stamp authorizes nothing a correct one would not — the panel
//     authorizes iff stamp === the live active workflow uuid, so a stale value simply
//     mismatches and is refused;
//   • an ABSENT stamp makes UiBridge send frames with no `workflow_uuid`, which the panel
//     also counts as a mismatch (#718, fail-closed). So erasing does not relax the fence,
//     it refuses HARDER — across everything the fence covers — and the panel's
//     re-advertise repair is capped at MISMATCH_REHELLO_MAX_PER_IDENTITY (3), after which
//     nothing retries and the tab is wedged for the session.
//
// And it is a REGRESSION with a name. #436 added `carryWorkflowCommandStamp` for exactly
// this, recording that deleting the stamp "flapped sessions". The #884 orchestrator-scoped
// -sessions refactor rewrote the migration block and left a bare delete behind. The
// argument survived in the comments; the code implementing it did not.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { carryWorkflowCommandStamp, workflowIdentityParts } from "../../orchestrator/session-store.js";

/** Source with comments stripped.
 *
 *  Two tests in #873 passed because the paragraph I wrote ABOVE a fix contained the
 *  strings the test grepped for — deleting the code left them green. Every source
 *  assertion below reads code only, and the header of this file names the very
 *  identifiers it asserts on, so without this the tests would be a spell-check. */
function orchestratorCode(): string {
  return readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");
}

/** The `migratedFrom` block, isolated so an unrelated `tabCommandWorkflowUuid` site
 *  elsewhere in this very large file cannot satisfy the assertions. */
function migrationBlock(src: string): string {
  const anchor = src.indexOf("if (migratedFrom && migratedFrom !== panelTab) {");
  expect(anchor, "the same-socket migration block must still exist").toBeGreaterThan(-1);
  const rest = src.slice(anchor);
  const end = rest.indexOf("if (newIdentity) {");
  expect(end, "the identity block must still follow the migration block").toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe("a tab-id migration CARRIES the workflow stamp (#1331)", () => {
  it("WIRING: the hello handler CALLS the carry, it does not reimplement it", () => {
    // The previous version of this file asserted the shape of inlined statements —
    // `get(migratedFrom)`, `set(panelTab, carriedStamp)`, `delete(migratedFrom)` in that
    // order. Codex's objection was right: a DEAD `set` before the delete satisfies every
    // one of those string checks, and the behavioural half was a re-implementation of what
    // the handler ought to do rather than the thing it does. Two independent copies of a
    // rule agreeing with each other proves nothing about the third copy in production.
    //
    // So the logic is extracted (restoring the name #436 gave it) and the handler calls it.
    // The tests below then exercise the FUNCTION PRODUCTION RUNS, and this one only has to
    // check that the call site exists inside the migration branch.
    const block = migrationBlock(orchestratorCode());
    expect(block).toMatch(
      /carryWorkflowCommandStamp\(tabCommandWorkflowUuid,\s*migratedFrom,\s*panelTab\)/,
    );
    // …and nothing hand-rolls the same operations alongside it.
    expect(block).not.toMatch(/tabCommandWorkflowUuid\.delete\(migratedFrom\)/);
  });

  it("SOURCE: a hello that DOES resolve an identity still overwrites the carried stamp", () => {
    // The carry is a floor, never a ceiling. If this hello proves an identity, that wins.
    const src = orchestratorCode();
    const at = src.indexOf("if (newIdentity) {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain(
      "tabCommandWorkflowUuid.set(panelTab, newIdentity.uuid);",
    );
  });
});

describe("the inputs that trigger the wedge are what a real reconnect produces (#1331)", () => {
  it("a hello that lands before the canvas identity is readable yields NO identity", () => {
    // Not a hypothetical branch. These are the exact shapes a reconnect emits, and each
    // one leaves `newIdentity` undefined — which, before this fix, meant the deleted
    // stamp was never restored.
    const origin = "http://127.0.0.1:8188";
    expect(workflowIdentityParts({ workflowUuid: undefined, origin })).toBeUndefined();
    expect(workflowIdentityParts({ workflowUuid: "", origin })).toBeUndefined();
    // …and an unresolvable server origin is untrusted too.
    const uuid = "44444444-4444-4444-8444-444444444444";
    expect(workflowIdentityParts({ workflowUuid: uuid, origin: undefined })).toBeUndefined();
    // A fully-formed hello IS trusted, or the branch above would be the only one ever
    // taken and none of this would prove anything about untrusted input.
    expect(workflowIdentityParts({ workflowUuid: uuid, origin })).toEqual({ origin, uuid });
  });
});

describe("the carry's semantics, exercised (#1331)", () => {
  // The hello handler is a few hundred lines inside a much larger closure, so the
  // assertions above read its source. This exercises the SEMANTICS the source implements,
  // so a future refactor that keeps the identifiers but inverts the meaning still fails.
  // The REAL function the handler calls — not a local restatement of it. The `newIdentity`
  // overwrite stays here because it lives in the handler, one branch later.
  function migrate(
    stamps: Map<string, string>,
    migratedFrom: string,
    panelTab: string,
    newIdentityUuid?: string,
  ): void {
    carryWorkflowCommandStamp(stamps, migratedFrom, panelTab);
    if (newIdentityUuid) stamps.set(panelTab, newIdentityUuid);
  }

  const WF = "11111111-1111-4111-8111-111111111111";

  it("THE REPORTED CASE: save/rename migrates the id, hello carries no uuid — the stamp survives", () => {
    // panel_new_workflow → build → panel_rename_workflow → panel_save_workflow mints a new
    // tab id (tmp: → wf:). Before this fix the stamp was deleted here and, with no uuid in
    // the hello, never restored: every mutating panel_* call refused for the session.
    const stamps = new Map([["tmp:abc", WF]]);
    migrate(stamps, "tmp:abc", "wf:abc", undefined);
    expect(stamps.get("wf:abc"), "the new id must keep the identity we already proved").toBe(WF);
    expect(stamps.has("tmp:abc"), "the retired id must not resolve").toBe(false);
  });

  it("new evidence beats carried evidence", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const stamps = new Map([["tmp:abc", WF]]);
    migrate(stamps, "tmp:abc", "wf:abc", other);
    expect(stamps.get("wf:abc")).toBe(other);
  });

  it("a stamp already recorded for the new id is not overwritten by the older carried one", () => {
    const newer = "22222222-2222-4222-8222-222222222222";
    const stamps = new Map([
      ["tmp:abc", WF],
      ["wf:abc", newer],
    ]);
    migrate(stamps, "tmp:abc", "wf:abc", undefined);
    expect(stamps.get("wf:abc")).toBe(newer);
  });

  it("nothing to carry stays nothing — a migration does not invent a stamp", () => {
    const stamps = new Map<string, string>();
    migrate(stamps, "tmp:abc", "wf:abc", undefined);
    expect(stamps.has("wf:abc")).toBe(false);
  });

  it("carrying cannot widen authorization: the fence still decides on EQUALITY", () => {
    // The load-bearing safety claim. A carried stamp naming workflow A, on a canvas now
    // showing workflow B, is refused exactly as an absent one would be — so carrying
    // permits no write that a correct stamp would not.
    const other = "22222222-2222-4222-8222-222222222222";
    const stamps = new Map([["tmp:abc", WF]]);
    migrate(stamps, "tmp:abc", "wf:abc", undefined);
    const authorized = (liveWorkflowUuid: string): boolean =>
      stamps.get("wf:abc") === liveWorkflowUuid;
    expect(authorized(WF)).toBe(true);
    expect(authorized(other)).toBe(false);
  });
});
