// #1471 — "restart to pick it up" named a restart that does not pick it up.
//
// An npx-mode update check reported {mode:"npx", from:0.51.15, to:0.51.16,
// note:"npx fetches the latest on next run; restart to pick it up"}. The user did
// exactly that — the panel's /restart — confirmed it, and the status check still read
// 0.51.15 from the same _npx package dir.
//
// The note is right about npx and wrong about WHICH restart. The panel's restart
// controls do not restart the long-lived orchestrator process, which is the one
// running this code and keeps the build it started with — a fact panel_reload's own
// description already states. The note said "restart" and let the reader supply the
// wrong one.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npxUpdateNote } from "../../services/npx-restart-scope.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#1471 the note names the restart that works", () => {
  const note = npxUpdateNote("0.51.16");

  it("still says what npx does, and when", () => {
    expect(note).toMatch(/0\.51\.16 available/);
    expect(note).toMatch(/next launch/i);
  });

  it("says npx will TRY to resolve, not that it WILL fetch the latest", () => {
    // Round 2 of review, and a fair hit: "npx fetches the latest on its next launch"
    // is false for a pinned package spec or an offline/preferred cache. Promising the
    // fetch makes the next sentence ("re-check the version") read as a clean pass/fail
    // when it is not one.
    expect(note).toMatch(/TRY to resolve/);
    expect(note).not.toMatch(/npx fetches the latest/);
  });

  it("names the restarts that do NOT apply it", () => {
    // The reporter reached for /restart precisely because nothing said it was the
    // wrong lever. Naming only the correct one still leaves them to discover that
    // the obvious button did nothing.
    expect(note).toMatch(/\/restart/);
    expect(note).toMatch(/panel_reload/);
    expect(note).toMatch(/do NOT/);
  });

  it("says WHY, so it reads as a cause rather than a rule", () => {
    expect(note).toMatch(/long-lived orchestrator process/);
    expect(note).toMatch(/keeps the build it[\s\S]*started with/);
  });

  it("gives the action that does work, without undoing a deliberate pin", () => {
    // Round 2 of review: the old text spelled the relaunch as "npx -y comfyui-mcp ...",
    // which someone launched as comfyui-mcp@0.51.15 could read as the command to run -
    // silently discarding a pin they chose. It now says to reuse THEIR command.
    expect(note).toMatch(/Stop that process and start it again/);
    expect(note).toMatch(/SAME command that launched it/);
    expect(note).toMatch(/silently undo a pin/);
  });

  it("does not print a relaunch command that drops the version spec", () => {
    // The specific regression: a bare, copyable "npx -y comfyui-mcp ..." example.
    expect(note).not.toMatch(/npx -y comfyui-mcp/);
  });

  it("does not claim npm cache clean fixes this", () => {
    // Round 2, and the same defect class as the bug: naming a lever that cannot move
    // the thing. `npm cache clean --force` clears npm's CONTENT cache; the stale build
    // is served from npx's separate EXECUTION cache, so a user could follow that advice
    // exactly, relaunch, and still be on the old version.
    expect(note).not.toMatch(/npm cache clean --force\b.*clears/);
    expect(note).toMatch(/does NOT clear npx's execution cache/);
  });

  it("names one command that overrides BOTH a pin and a cached copy", () => {
    expect(note).toMatch(/comfyui-mcp@latest/);
  });

  it("names the check, and refuses to over-read its result", () => {
    // The check is real evidence but NOT a diagnosis: an unchanged version cannot
    // distinguish "the restart never reached this process" from "npx relaunched and
    // the cache served the old build". Claiming it proves the update was not applied
    // is the same over-claim this whole issue is about - a message that reads as
    // conclusive when it is only suggestive.
    expect(note).toMatch(/self_update_action:"status"/);
    expect(note).toMatch(/does not say why/);
    expect(note).toMatch(/look identical from here/);
    expect(note).not.toMatch(/whatever any restart appeared to do/);
  });

  it("names all three indistinguishable causes, not just one", () => {
    // An unchanged version has three explanations and the note must not pick one:
    // the restart missed this process, a pin is holding it, or the execution cache
    // served an old copy.
    expect(note).toMatch(/never reached this process/);
    expect(note).toMatch(/version pin/);
    expect(note).toMatch(/execution cache/);
    expect(note).toMatch(/look identical from here/);
  });

  it("no longer promises that a bare restart suffices", () => {
    expect(note).not.toMatch(/restart to pick it up/);
  });
});

describe("#1471 WIRING: both npx branches use it", () => {
  const src = readFileSync(join(HERE, "../../services/self-update.ts"), "utf8");

  it("the old sentence is gone from self-update", () => {
    expect(src).not.toMatch(/npx fetches the latest on next run; restart to pick it up/);
  });

  it("both npx-mode notes call the shared builder", () => {
    // There are two: the status path and the notify path the reporter hit. Fixing one
    // and leaving the other is how half a message survives a rename.
    expect(src).toMatch(/import \{ npxUpdateNote \} from "\.\/npx-restart-scope\.js";/);
    expect((src.match(/npxUpdateNote\(latest\)/g) ?? []).length).toBe(2);
  });
});
