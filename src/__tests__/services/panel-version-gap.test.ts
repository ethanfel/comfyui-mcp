// #1043 — a fence deadlock that is really a VERSION GAP should say so.
//
// Three reports end the same way: a command re-points the active workflow
// (panel_new_workflow, a Save-As), the session's fence is not re-derived, and
// every later panel_* call is refused with `workflow instance mismatch`. The
// documented recovery then fails because it needs a read the fence blocks.
//
// The orchestrator already has the repair — refreshFenceFromOwnReply (#1161)
// trusts the workflow_uuid the command's OWN reply carries, and never makes that
// read. It depends on the panel PUBLISHING that uuid, which is panel #800, first
// shipped in panel 0.11.45 (verified against the panel repo: #800 landed after
// the 0.11.44 release commit).
//
// Every reporter was below it — #1043 on 0.11.43, #1174 on 0.11.44 — so the fix
// was present and inert, and the message said only that the identity "could not
// be read". That reads as a mystery instead of "update the panel".

import { describe, expect, it } from "vitest";
import { UiBridge, PANEL_MIN_VERSION_REPLY_UUID } from "../../services/ui-bridge.js";

/** A bridge whose resolveTarget reports the given panel version. `advertised`
 *  models whether THIS connection's hello carried it (vs inheriting it from a
 *  previous one) — the distinction codex review showed is load-bearing. */
function bridgeWithPanel(version: string | undefined, advertised = true): UiBridge {
  const b = new UiBridge(0) as UiBridge & {
    resolveTarget: (id: string) => { panelVersion?: string; panelVersionAdvertised?: boolean };
  };
  b.resolveTarget = () => ({ panelVersion: version, panelVersionAdvertised: advertised });
  return b;
}

describe("panelTooOldForReplyUuid (#1043)", () => {
  it("says TOO OLD for the versions the reporters were actually on", () => {
    for (const v of ["0.11.43", "0.11.44"]) {
      const r = bridgeWithPanel(v).panelTooOldForReplyUuid("t");
      expect(r.tooOld, `${v} should be too old`).toBe(true);
      expect(r.version).toBe(v);
      expect(r.needed).toBe(PANEL_MIN_VERSION_REPLY_UUID);
    }
  });

  it("says NOT too old at the exact minimum and above", () => {
    for (const v of ["0.11.45", "0.11.51", "0.12.0"]) {
      expect(bridgeWithPanel(v).panelTooOldForReplyUuid("t").tooOld, v).toBe(false);
    }
  });

  it("an UNKNOWN version is never called too old", () => {
    // Telling someone to update a panel that may already be current is a wrong
    // remedy, and the whole point of this file is not handing out those.
    for (const v of [undefined, "", "dev", "nightly", "not-a-version"]) {
      expect(bridgeWithPanel(v).panelTooOldForReplyUuid("t").tooOld, String(v)).toBe(false);
    }
  });

  it("an INHERITED version is not narrated as too old (codex review)", () => {
    // A re-hello that omits panel_version inherits the previous value, so a panel
    // that was updated and reloaded without re-advertising would still read as
    // old — and we would tell someone to update a panel they just updated.
    expect(bridgeWithPanel("0.11.43", false).panelTooOldForReplyUuid("t").tooOld).toBe(false);
    // …while a freshly advertised old version still is.
    expect(bridgeWithPanel("0.11.43", true).panelTooOldForReplyUuid("t").tooOld).toBe(true);
  });

  it("never throws when the tab cannot be resolved", () => {
    const b = new UiBridge(0) as UiBridge & { resolveTarget: () => never };
    b.resolveTarget = () => {
      throw new Error("no such tab");
    };
    expect(() => b.panelTooOldForReplyUuid("ghost")).not.toThrow();
    expect(b.panelTooOldForReplyUuid("ghost").tooOld).toBe(false);
  });

  it("pins the minimum to the release that actually publishes the uuid", () => {
    // Verified against the panel repo rather than assumed: panel #800 landed
    // after the 0.11.44 release commit and first shipped in 0.11.45. A wrong
    // constant here would either miss the reporters or slander a good panel.
    expect(PANEL_MIN_VERSION_REPLY_UUID).toBe("0.11.45");
  });
});

// THE WIRING, at two levels. The accessor above cannot see whether the failure
// message carries its answer, and describeFenceRebind is pure — so it cannot see
// whether its callers pass one. Both are the call-site blindness this repo keeps
// getting caught by.
describe("the rebind failure message carries the version gap (#1043)", () => {
  it("threads the note into describeFenceRebind and prints it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf-8",
    );

    // The renderer prints whatever it is given, in the not_recovered branch.
    const start = src.indexOf("Could NOT read the live canvas identity");
    expect(start, "the failure message must still exist").toBeGreaterThan(-1);
    expect(src.slice(start, start + 1400)).toContain("panelGapNote");

    // Exactly TWO call sites pass it — panel_save_workflow and panel_new_workflow,
    // the commands whose replies actually carry a workflow_uuid. Codex review
    // caught panel_set_workflow_target getting it too, where the claim "updating
    // removes this failure" is false: that command has no own-reply uuid to gain,
    // so an updated panel would still make this read.
    const withNote = src.split("panelTooOldNote(ctx)").length - 1;
    expect(withNote, "save + new only").toBe(2);
  });

  it("the note names the version they have, the one they need, and how to get it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf-8",
    );
    const start = src.indexOf("function panelTooOldNote");
    // Widened for #1560, which inserted the never-advertised branch ahead of this
    // one. The bound is the function, not a byte count that silently truncates:
    // a slice that stops early would pass by asserting against the wrong text.
    const end = src.indexOf("\n}", src.indexOf("if (!v?.tooOld) return \"\"", start));
    const body = src.slice(start, end);
    expect(body).toContain("${v.version}");
    expect(body).toContain("${v.needed}");
    expect(body).toMatch(/panel_action:"sync"/);
    // And it stays silent unless PROVEN too old.
    expect(body).toMatch(/if \(!v\?\.tooOld\) return ""/);
  });

  // ── #1560: a panel too old to help is also too old to say so ────────────────

  it("a panel that NEVER advertised a version is reported as never-advertised", async () => {
    const { UiBridge } = await import("../../services/ui-bridge.js");
    const b = new UiBridge(0) as UiBridge & { resolveTarget: (id: string) => unknown };
    // No version has ever arrived on this tab — only possible below panel 0.11.83,
    // which is where `panel_version` started riding the hello.
    b.resolveTarget = () => ({ panelVersion: undefined, panelVersionAdvertised: false });
    const r = b.panelTooOldForReplyUuid("t");
    expect(r.neverAdvertised).toBe(true);
    // NOT asserted as a version comparison — it is an inference from a missing field.
    expect(r.tooOld).toBe(false);
  });

  it("an INHERITED version stays silent — the original guard is unchanged", async () => {
    const { UiBridge } = await import("../../services/ui-bridge.js");
    const b = new UiBridge(0) as UiBridge & { resolveTarget: (id: string) => unknown };
    // A re-hello omitted panel_version, so the previous value is inherited. This is
    // the case the tri-state guard was written for: saying anything here could tell
    // someone to update a panel they just updated.
    b.resolveTarget = () => ({ panelVersion: "0.11.43", panelVersionAdvertised: false });
    const r = b.panelTooOldForReplyUuid("t");
    expect(r.neverAdvertised, "an inherited version is NOT never-advertised").toBeUndefined();
    expect(r.tooOld).toBe(false);
  });

  it("an UNRESOLVABLE tab is not narrated as an old panel (review, P1)", async () => {
    // resolveTarget throwing leaves version undefined, which is indistinguishable
    // from "never sent one" unless the lookup's own success is tracked. Without
    // that, a CURRENT panel whose socket closed mid-command would be told to
    // update — a false accusation built from a failed observation.
    const { UiBridge } = await import("../../services/ui-bridge.js");
    const b = new UiBridge(0) as UiBridge & { resolveTarget: () => never };
    b.resolveTarget = () => {
      throw new Error("no such tab");
    };
    const r = b.panelTooOldForReplyUuid("ghost");
    expect(r.neverAdvertised, "an unreadable tab proves nothing about the panel").toBeUndefined();
    expect(r.tooOld).toBe(false);
  });

  it("the never-advertised note hedges, and names a reader that can answer", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf-8",
    );
    const start = src.indexOf("if (v?.neverAdvertised) {");
    expect(start, "the never-advertised branch must exist").toBeGreaterThan(-1);
    const body = src.slice(start, start + 1400);
    // It must not assert a version it never saw.
    // Asserted on text that is CONTIGUOUS in source — the sentence spans a string
    // concatenation, so the full phrase never appears as one literal.
    expect(body).toContain("has never ");
    // Review, P1: an absent version proves only "below 0.11.83". Panels in
    // 0.11.45–0.11.82 publish the reply uuid and simply do not advertise, so the
    // note must NOT conclude they are too old — it must say what to check.
    expect(body).toMatch(/does NOT by itself mean it is too old/i);
    expect(body).toMatch(/0.11.45–0.11.82 do that while still not advertising/);
    expect(body).toMatch(/WORTH CHECKING/);
    // The remedy must name tools that exist — a citation nobody can run reads as
    // the answer while being a dead end.
    expect(body).toMatch(/panel_action:"status"/);
    expect(body).toMatch(/panel_action:"sync"/);
    // The reporter's actual trap: Manager said the update failed, so the OLD JS is
    // still running in the open tab.
    expect(body).toMatch(/HARD-REFRESH/);
  });
});
