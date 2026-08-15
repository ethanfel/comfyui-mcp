// #1567 — the receipt told the user a queued respawn was nothing to worry about.
//
// `panel_request_secret` printed BOTH of these in one message:
//
//   "…the tool process already running picks it up — no reload, and no respawn required."
//   "Tool sessions being rebuilt with the new environment: 1 queued for the end of this turn (of 1 live)."
//
// The first sentence is about LIVE PICKUP: this key is re-read from disk at use time, so
// the running tools do not NEED a respawn to see it. True, and useful. But it says "no
// respawn required" on the same message that reports one already queued — and a queued
// respawn still tears the tool session down when it fires.
//
// The reporter read it as safe-to-proceed, started ~48 GB of downloads over the following
// turns, and lost all nine when the respawn landed. #1378's at-risk warning could not help:
// its snapshot is taken at SAVE time, and at save time nothing was in flight.
//
// So this file pins the one thing the renderer can always know at save time — that a
// respawn IS pending — and stops it claiming otherwise. The deeper ordering fix (re-taking
// the snapshot at respawn-execution time) is separate; this is the sentence that invited
// the loss.
import { describe, expect, it } from "vitest";

import { describeComfyuiSecretSave } from "../../orchestrator/panel-tools.js";
import type { SecretSaveReceipt } from "../../services/panel-secrets.js";

const base: SecretSaveReceipt = {
  key: "CIVITAI_API_TOKEN",
  path: "/home/u/.comfyui-mcp/.env",
  persisted: "yes",
  livePickup: true,
  respawn: null,
};

/** The exact claim that has to stop appearing beside a queued respawn. */
const NO_RESPAWN_CLAIM = /no respawn required/i;

describe("a QUEUED respawn is never described as 'no respawn required' (#1567)", () => {
  it("drops the claim when a respawn is scheduled", () => {
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 1, applied: 0, scheduled: 1 },
    });
    expect(text).not.toMatch(NO_RESPAWN_CLAIM);
    // …and still says the useful half: the running tools DO see the value already.
    expect(text).toMatch(/picks it up/i);
    // The pending teardown has to be stated, not merely implied by a count.
    expect(text).toMatch(/pending|will still|when it fires|is queued/i);
  });

  it("warns that transfers started before it fires are at risk", () => {
    // The receipt cannot know what will be in flight later — that is the whole defect —
    // so it must warn about the WINDOW rather than about a list it cannot have.
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 1, applied: 0, scheduled: 1 },
    });
    expect(text).toMatch(/download|transfer/i);
    // Naming downloads is not enough on its own: the load-bearing part is WHY nothing is
    // listed. Without it the message reads as a generic caution rather than "the check you
    // are used to seeing cannot cover what you do next", which is the actual trap.
    // A first version of this test asserted only the word "download" and was satisfied by
    // an unrelated sentence, so a mutation deleting the warning survived.
    // BOTH halves, not an alternation: the first draft accepted any one of three phrases,
    // so deleting one of them left the test green. The claim is a conjunction — nothing is
    // listed (1) BECAUSE a transfer started later did not exist when the check ran (2) —
    // and either half alone is a different, weaker statement.
    expect(text).toMatch(/cannot list/i);
    expect(text).toMatch(/after this save/i);
    expect(text).toMatch(/did not exist/i);
  });

  it("keeps the claim when NOTHING is scheduled — the sentence is correct there", () => {
    // Live pickup with no respawn pending is exactly when "no respawn required" is the
    // right thing to say, and the reason not to simply delete the sentence.
    for (const respawn of [
      null,
      { live: 1, applied: 0, scheduled: 0 },
      { live: 3, applied: 0, scheduled: 0 },
    ] as SecretSaveReceipt["respawn"][]) {
      const text = describeComfyuiSecretSave({ ...base, respawn });
      expect(text, JSON.stringify(respawn)).toMatch(NO_RESPAWN_CLAIM);
    }
  });

  it("an APPLIED-only respawn does not claim 'no respawn required' either", () => {
    // It already happened. Saying none was required describes a different save.
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 2, applied: 2, scheduled: 0 },
    });
    expect(text).not.toMatch(NO_RESPAWN_CLAIM);
  });

  it("a NON-live-pickup key is unaffected — it never made the claim", () => {
    const text = describeComfyuiSecretSave({
      ...base,
      livePickup: false,
      respawn: { live: 1, applied: 0, scheduled: 1 },
    });
    expect(text).not.toMatch(NO_RESPAWN_CLAIM);
    expect(text).toMatch(/only a respawned tool session will see it/i);
  });

  it("an UNCONFIRMED save still refuses to make any pickup claim", () => {
    // The #826 rule outranks this one: nothing about pickup may be asserted when the
    // store could not be read back.
    const text = describeComfyuiSecretSave({
      ...base,
      persisted: "unknown",
      uncertainty: "the file could not be re-read",
      respawn: { live: 1, applied: 0, scheduled: 1 },
    });
    expect(text).not.toMatch(NO_RESPAWN_CLAIM);
    expect(text).not.toMatch(/picks it up/i);
  });
});
