// #988 — the changelog range reaches too far back, every single release.
//
// `describe --tags --abbrev=0` returns the newest tag REACHABLE from HEAD. The
// release flow pushes the tag from a LOCAL commit and then squash-merges the
// version bump onto protected main, which writes a different sha — so a version
// tag is NEVER an ancestor of main and `describe` walks straight past it.
//
// 0.50.3, 0.50.4 and 0.50.5 each generated a section listing every commit back
// to v0.50.1 (28 entries for a 5-commit release), and each had to be trimmed by
// hand before the tag was pushed. Three hand-corrections is how a wrong
// changelog eventually ships.
//
// A narrower RANGE was tried and rejected: bounding by the newest release COMMIT
// on the branch under-includes instead, silently dropping anything merged
// between the tag being cut and the reconcile PR landing (#976 fell in exactly
// that window). Dropping an entry is worse than repeating one — a duplicate is
// visible, a gap is not. Both directions are covered below.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "gen-changelog.mjs");

let dir: string;
let changelog: string;

/** A repo with a real history, so the script's own git queries work. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function commit(subject: string): void {
  writeFileSync(join(dir, "f.txt"), subject);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", subject], dir);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cl-"));
  changelog = join(dir, "CHANGELOG.md");
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  // The generator writes into an "## Unreleased" section; without one there is
  // nowhere to put the entry and it refuses (correctly).
  writeFileSync(changelog, "# Changelog\n\n## Unreleased\n\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "chore: init"], dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the real script against the scratch repo. */
function generate(version: string): string {
  execFileSync(process.execPath, [SCRIPT, version], {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COMFYUI_MCP_CHANGELOG_ROOT: dir },
  });
  return readFileSync(changelog, "utf-8");
}

describe("#988: an over-reaching range does not duplicate what is already written", () => {
  it("omits entries a previous section already documents", () => {
    commit("fix(a): first thing (#101)");
    const first = generate("1.0.0");
    expect(first).toContain("first thing (#101)");

    // No new commits, but the range still reaches back past #101 (the tag this
    // flow would have created is not an ancestor here either).
    commit("fix(b): second thing (#102)");
    const second = generate("1.0.1");

    // The new one appears…
    expect(second).toContain("second thing (#102)");
    // …and the old one is NOT repeated in the new section.
    const newSection = second.slice(second.indexOf("## [1.0.1]"), second.indexOf("## [1.0.0]"));
    expect(newSection).not.toContain("(#101)");
    // …while still being present in its own, earlier section.
    expect(second.slice(second.indexOf("## [1.0.0]"))).toContain("(#101)");
  });

  it("says so plainly when everything in range is already documented", () => {
    commit("fix(a): only thing (#101)");
    generate("1.0.0");
    const again = generate("1.0.1");
    const section = again.slice(again.indexOf("## [1.0.1]"), again.indexOf("## [1.0.0]"));
    expect(section).toContain("_No user-facing changes._");
  });

  it("dedupes across SEVERAL earlier sections, not just the newest", () => {
    commit("fix(a): one (#101)");
    generate("1.0.0");
    commit("fix(b): two (#102)");
    generate("1.0.1");
    commit("fix(c): three (#103)");
    const out = generate("1.0.2");
    const section = out.slice(out.indexOf("## [1.0.2]"), out.indexOf("## [1.0.1]"));
    expect(section).toContain("(#103)");
    expect(section).not.toContain("(#101)");
    expect(section).not.toContain("(#102)");
  });
});

describe("#988: it must not UNDER-include — the failure the narrow range had", () => {
  // The #976 shape: a commit lands after the previous tag was cut but before its
  // reconcile PR merged, so it belongs to NO release yet. A range bounded by the
  // release commit would skip it forever. Filtering by what is written cannot,
  // because nothing has written it.
  it("includes a commit that no section documents, however wide the range", () => {
    commit("fix(a): released thing (#101)");
    generate("1.0.0");
    commit("fix(b): fell in the release window (#976)");
    commit("fix(c): later thing (#102)");
    const out = generate("1.0.1");
    const section = out.slice(out.indexOf("## [1.0.1]"), out.indexOf("## [1.0.0]"));
    expect(section).toContain("(#976)");
    expect(section).toContain("(#102)");
  });

  // A commit with no PR number cannot be deduped by number. It must still be
  // emitted rather than silently dropped — the conservative direction.
  it("keeps an entry that carries no PR number to match on", () => {
    commit("fix(a): numbered (#101)");
    generate("1.0.0");
    commit("fix(b): unnumbered local fix");
    const out = generate("1.0.1");
    const section = out.slice(out.indexOf("## [1.0.1]"), out.indexOf("## [1.0.0]"));
    // Conventional-with-no-PR is housekeeping only when its TYPE is unmapped;
    // a `fix:` is a real entry and must survive.
    expect(section).toContain("unnumbered local fix");
  });
});

// #1309 — the subject THIS repo writes on every release was not recognised as a
// release, so each release-reconcile commit appeared in the NEXT release's entry
// under "Changed".
//
// `isReleaseSubject` matched `release: …` and a bare `0.50.85 (#1302)`. The flow
// actually produces `chore(release): 0.50.85 (#1302)` — `npm version patch -m
// "chore(release): %s"`, squash-merged with the PR number appended — which
// matches neither, falls to the conventional-commit parser, and is read as a
// `chore` with scope `release`.
//
// Nothing else catches it: the de-duplication that makes the deliberately-wide
// range safe is "filter out PRs the changelog already documents", and a
// release-reconcile PR is never documented, because it is not a change.
describe("#1309: a release commit is not a change", () => {
  /** A release commit touches the files a release touches — package.json and the
   *  changelog. This matters: an earlier version of this test committed the same
   *  scratch file as every other commit, and the entry was dropped for an
   *  unrelated reason, so the test passed with the fix REVERTED. It was verifying
   *  nothing. Reproduced against the real 0.50.86 history to find that out. */
  function releaseCommit(subject: string): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: subject }));
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", subject], dir);
  }

  it("does not file the previous release under the next one", () => {
    commit("fix(a): a real change (#101)");
    generate("1.0.0");
    // Exactly what the release flow writes, squash-merged.
    releaseCommit("chore(release): 1.0.0 (#102)");
    commit("fix(b): another real change (#103)");
    const out = generate("1.0.1");

    const section = out.slice(out.indexOf("## [1.0.1]"), out.indexOf("## [1.0.0]"));
    expect(section, "the new change belongs here").toContain("another real change (#103)");
    expect(section, "the release commit does not").not.toContain("(#102)");
    expect(section).not.toContain("1.0.0 (#102)");
  });

  it("recognises the other two release shapes too — they were already handled", () => {
    commit("fix(a): a real change (#101)");
    generate("1.0.0");
    releaseCommit("release: v1.0.0 — the hand-written form (#102)");
    releaseCommit("1.0.0 (#104)");
    commit("fix(b): another real change (#103)");
    const out = generate("1.0.1");

    const section = out.slice(out.indexOf("## [1.0.1]"), out.indexOf("## [1.0.0]"));
    expect(section).toContain("another real change (#103)");
    expect(section).not.toContain("(#102)");
    expect(section).not.toContain("(#104)");
  });

  it("an ORDINARY chore is still a change — the skip is scoped, not blanket", () => {
    // A general `chore:` skip would be the easy fix and the wrong one: an
    // ordinary chore can be user-facing, and dropping entries silently is the
    // failure this file exists to prevent. Only the `release` scope is a release.
    commit("chore: bump the pinned frontend floor (#201)");
    commit("chore(deps): update a runtime dependency (#202)");
    const out = generate("1.0.0");

    expect(out).toContain("(#201)");
    expect(out).toContain("(#202)");
  });

  it("a breaking release subject is still a release", () => {
    commit("fix(a): a real change (#101)");
    generate("1.0.0");
    releaseCommit("chore(release)!: 2.0.0 (#102)");
    commit("fix(b): another real change (#103)");
    const out = generate("2.0.1");

    const section = out.slice(out.indexOf("## [2.0.1]"), out.indexOf("## [1.0.0]"));
    expect(section).toContain("another real change (#103)");
    expect(section).not.toContain("(#102)");
  });
});
