// #1479 — download_model action:"status" reported PROVEN-dead downloads as
// "still streaming".
//
// Three transfers died with their owning process. Status rendered them as
// **downloading — still streaming** with "the transfer may still be running … Do not
// report this download as failed or missing", while action:"cancel" on the same ids
// answered "that session is confirmed GONE — its process no longer exists".
//
// The evidence was already in the process: writerProcessGone() probes the owner pid
// (ESRCH ⇒ proven dead) but was only reached from the cancel path. Status branched on
// heartbeat AGE alone.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inflightNoteKind,
  provenDeadStatusNote,
} from "../../services/download-status-proven-dead.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#1479 which note to render", () => {
  it("a PROVEN-gone writer gets the proven-dead note", () => {
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: true, provenGone: true }),
    ).toBe("proven-dead");
  });

  it("proven-gone wins even when the heartbeat is not yet stale", () => {
    // The pid probe is the stronger evidence; waiting for the heartbeat to age would
    // keep reporting a dead transfer as live for no reason.
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: false, provenGone: true }),
    ).toBe("proven-dead");
  });

  it("UNKNOWN keeps the cautious wording — the whole point", () => {
    // writerProcessGone returns undefined when there is no recorded pid or the probe
    // failed. #761: a reconnect can interrupt persistence, so a missed heartbeat alone
    // does not prove the transfer stopped, and claiming death would be the same
    // over-reach in the other direction.
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: true, provenGone: undefined }),
    ).toBe("stale");
  });

  it("a live writer with a stale heartbeat stays cautious", () => {
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: true, provenGone: false }),
    ).toBe("stale");
  });

  it("says nothing when the record is not in flight", () => {
    for (const status of ["completed", "cancelled", "failed", undefined]) {
      expect(inflightNoteKind({ status, staleInflight: true, provenGone: true })).toBe("none");
    }
  });

  it("says nothing for a healthy in-flight record", () => {
    expect(inflightNoteKind({ status: "downloading" })).toBe("none");
  });
});

describe("#1479 the proven-dead note", () => {
  const note = () => provenDeadStatusNote({ staleForMs: 102_000 });

  it("states plainly that the transfer is not running", () => {
    expect(note()).toMatch(/NOT running/);
    expect(note().includes("recorded pid exists here")).toBe(true);
  });

  it("gives the EVIDENCE, not just the verdict", () => {
    // A caller told moments ago not to touch this download needs to know why the
    // answer changed.
    expect(note()).toMatch(/recorded pid exists here/);
    expect(note()).toMatch(/died with its session/);
  });

  it("does not repeat the do-not-act caution it replaces", () => {
    expect(note()).not.toMatch(/may still be running/);
    expect(note()).not.toMatch(/Do not report this download as failed or missing/);
  });

  it("says a re-issue is safe, because nothing is writing the file", () => {
    expect(note()).toMatch(/No local process is writing this file/);
    // Round 3 of review: a pid from another host or container ESRCHes here too, and the
    // record carries no host to check against. So the verdict is scoped to the local
    // evidence and recovery routes through cancel, which re-probes and refuses when it
    // cannot confirm. A wrong verdict then costs a refused cancel, not a duplicated
    // multi-gigabyte download.
    expect(note()).toMatch(/NOT running on this machine/);
    expect(note()).toMatch(/would look the same from\s+here/);
    expect(note()).toMatch(/before re-issuing/);
    // Round 4: cancel runs the SAME local probe, so claiming it is safe either way was
    // false for a foreign-host writer. The message names the shared blind spot instead
    // of promising around it.
    expect(note()).toMatch(/cancel uses/);
    expect(note()).toMatch(/SAME local probe/);
    expect(note()).not.toMatch(/safe either way/);
    expect(note()).not.toMatch(/is safe to re-issue the download/);
  });

  it("reports how long ago the heartbeat stopped when known", () => {
    expect(note()).toMatch(/heartbeat stopped 102s ago/);
    // and omits the clause rather than printing a bogus 0s
    expect(provenDeadStatusNote({})).not.toMatch(/heartbeat stopped/);
    expect(provenDeadStatusNote({ staleForMs: 0 })).not.toMatch(/heartbeat stopped/);
  });

  it("does NOT claim a Manager dispatch is dead — only its local owner", () => {
    // The server-side fetch runs elsewhere; declaring it dead would be the same
    // over-reach this issue is about, pointed the other way.
    const m = provenDeadStatusNote({ staleForMs: 102_000, viaManager: true });
    expect(m).toMatch(/SERVER-side fetch may still\s+be running/);
    expect(m).toMatch(/only the local record's owner is proven gone/);
    expect(m).not.toMatch(/safe to re-issue/);
    expect(m).toMatch(/list_local_models/);
  });
});

describe("#1479 WIRING", () => {
  const jobs = readFileSync(join(HERE, "../../services/download-jobs.ts"), "utf8");
  const tool = readFileSync(join(HERE, "../../tools/model-management.ts"), "utf8");

  it("the pid verdict is carried onto the job view", () => {
    expect(jobs).toMatch(/writerProvenGone\?: boolean;/);
    expect(jobs).toMatch(/writerProvenGone: writerProcessGone\(rec\) === true \? true : undefined/);
  });

  it("only TRUE is carried — 'cannot tell' must not render as death", () => {
    // The projection maps undefined/false to absent, so the renderer can never read a
    // failed probe as proof.
    expect(jobs).not.toMatch(/writerProvenGone: writerProcessGone\(rec\),/);
  });

  it("status renders through the shared decision", () => {
    expect(tool).toMatch(
      /import \{[\s\S]*?inflightNoteKind,[\s\S]*?\} from "\.\.\/services\/download-status-proven-dead\.js";/,
    );
    expect(tool).toMatch(/const noteKind = inflightNoteKind\(\{/);
    expect(tool).toMatch(/noteKind === "proven-dead"/);
  });

  it("the STATUS LINE agrees with the note", () => {
    // The note alone would leave the reply contradicting itself: "still streaming"
    // immediately followed by "this transfer is NOT running".
    expect(tool).toMatch(/j\.writerProvenGone === true/);
    expect(tool).toMatch(/NOT running — the owning process is gone/);
  });

  it("the cautious stale wording survives for the unproven case", () => {
    expect(tool).toMatch(/heartbeat stale for/);
    expect(tool).toMatch(/the transfer may still be running/);
  });
});

describe("#1479 a Manager dispatch is never declared dead", () => {
  const m = () => provenDeadStatusNote({ staleForMs: 102_000, viaManager: true });

  it("does not OPEN by calling the transfer dead", () => {
    // The first cut said "this transfer is NOT running" and then admitted the
    // server-side fetch may still be live — the same self-contradiction this issue is
    // about, written into its own fix. My tests asserted only the tail, so they passed
    // while the opening sentence was wrong; review caught it, and a mutation confirmed
    // the case was uncovered.
    expect(m()).not.toMatch(/this transfer is NOT running/);
    expect(m()).toMatch(/the local owner of this record is gone/);
  });

  it("scopes the pid evidence to the LOCAL owner", () => {
    expect(m()).toMatch(/only the local record's owner is proven gone/);
  });

  it("the non-Manager note still states the plain verdict", () => {
    expect(provenDeadStatusNote({ staleForMs: 1000 })).toMatch(/this transfer is NOT running/);
  });
});

describe("#1479 WIRING: the status line is route-aware too", () => {
  const tool2 = readFileSync(join(HERE, "../../tools/model-management.ts"), "utf8");

  it("a Manager dispatch does not read 'NOT running' at a glance", () => {
    // The status line is what a reader takes first; leaving it absolute would have it
    // contradict the note directly beneath it.
    expect(tool2).toMatch(/j\.viaManager/);
    expect(tool2).toContain("local owner gone");
    expect(tool2).toContain("the server-side fetch may still be running");
  });
});
