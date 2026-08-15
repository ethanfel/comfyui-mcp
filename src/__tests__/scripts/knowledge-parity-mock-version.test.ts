import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MOCK_WORKFLOW_UUID } from "../../../scripts/knowledge-parity-mock-graph.mjs";
import {
  BRIDGE_CMD_MIN_PANEL_VERSION,
  BRIDGE_CAPABILITY_MIN_PANEL_VERSION,
  requiredPanelVersion,
} from "../../services/ui-bridge.js";

/**
 * #1384 — the smoke's mock panel must stay new enough to be allowed to write.
 *
 * The reported failure was not a bug in the product: the mock's hello carried no
 * `panel_version`, so the graph-write fence correctly refused `graph_clear` before the
 * mock executor ever saw it, and the smoke reported a capability failure that was really a
 * harness failure. Pinning a literal version in the script fixes today and rots tomorrow —
 * the floor had ALREADY moved twice (0.11.30 → 0.11.35, then 0.13.0 for #1359) while the
 * reporter's suggested 0.11.35 was being written down.
 *
 * So the number is ratcheted against the product's own derived minimum. Raising any fence
 * fails here, in a test that names the file to edit, instead of surfacing later as a smoke
 * that refuses every write for a reason nobody connects to a table three modules away.
 */
const SMOKE = new URL("../../../scripts/codex-knowledge-parity-smoke.mjs", import.meta.url);

const source = (): string => readFileSync(SMOKE, "utf8");

/** Source with comments removed, for assertions that are about CODE. A prose sentence
 *  satisfying a code assertion is a spell-check on my own comments — which has happened in
 *  this repo more than once. Block comments only where a naive `//` strip would eat a URL. */
const codeOnly = (): string => source().replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const declared = (name: string): string => {
  const m = source().match(new RegExp(`const ${name} = "([^"]+)"`));
  expect(m, `${name} must be declared in the smoke script`).not.toBeNull();
  return m![1];
};

/**
 * Semver-aware enough for a version FLOOR (codex P2).
 *
 * The first version split on "." and called Number on each part, so `0.13.0-rc1` parsed as
 * [0, 13, NaN] and every comparison against it was false — a ratchet that answers "no" to
 * everything is not a ratchet. The tables hold plain releases today, but the production
 * reader accepts prerelease forms, so a floor written as one would have silently failed
 * this test rather than raising the mock.
 *
 * A prerelease sorts BELOW its release (0.13.0-rc1 < 0.13.0), which is the semver rule and
 * also the safe direction here: satisfying a release floor satisfies its prereleases.
 */
const parse = (v: string): { nums: number[]; pre: string | undefined } => {
  const [core, ...rest] = v.trim().split("-");
  return {
    nums: core.split(".").map((n) => Number(n) || 0),
    pre: rest.length ? rest.join("-") : undefined,
  };
};
const atLeast = (have: string, want: string): boolean => {
  const a = parse(have);
  const b = parse(want);
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  // Same numbers: a release satisfies a prerelease floor, a prerelease does not satisfy a
  // release floor, and two prereleases compare as strings.
  if (a.pre === b.pre) return true;
  if (a.pre === undefined) return true;
  if (b.pre === undefined) return false;
  return a.pre >= b.pre;
};

describe("#1384 — the knowledge-parity mock keeps up with the fences", () => {
  it("the mock's panel version satisfies every command and capability minimum", () => {
    const mock = declared("MOCK_PANEL_VERSION");
    const required = requiredPanelVersion();
    expect(
      atLeast(mock, required),
      `MOCK_PANEL_VERSION is ${mock}, but the orchestrator now requires ${required}. ` +
        `Raise it in scripts/codex-knowledge-parity-smoke.mjs — otherwise the smoke's ` +
        `graph writes are refused by the fence and the run reports a capability failure ` +
        `that is really a harness failure.`,
    ).toBe(true);
  });

  it("…including any fence added after this test was written", () => {
    // requiredPanelVersion() is an aggregate, so a new entry BELOW the current maximum
    // does not move it and the test above would not notice. Checking every entry
    // individually is what makes this a ratchet rather than a snapshot of one number.
    const mock = declared("MOCK_PANEL_VERSION");
    const all = [
      ...Object.entries(BRIDGE_CMD_MIN_PANEL_VERSION),
      ...Object.entries(BRIDGE_CAPABILITY_MIN_PANEL_VERSION),
    ];
    expect(all.length, "the tables must not be empty, or this asserts nothing").toBeGreaterThan(5);
    const behind = all.filter(([, min]) => !atLeast(mock, min));
    expect(behind, `the mock (${mock}) is older than: ${behind.map(([k]) => k).join(", ")}`).toEqual(
      [],
    );
  });

  it("the comparator handles the version forms the product accepts", () => {
    // The ratchet is only as good as its comparison. The first version parsed "0.13.0-rc1"
    // as [0, 13, NaN] and answered false to everything (codex P2) — a floor written that
    // way would have failed this test silently instead of raising the mock.
    expect(atLeast("0.13.0", "0.13.0")).toBe(true);
    expect(atLeast("0.13.1", "0.13.0")).toBe(true);
    expect(atLeast("0.12.99", "0.13.0")).toBe(false);
    expect(atLeast("0.13", "0.13.0")).toBe(true);
    expect(atLeast("1.0.0", "0.99.99")).toBe(true);
    // Multi-digit parts must compare numerically, not lexically: "0.9.0" < "0.10.0".
    expect(atLeast("0.10.0", "0.9.0")).toBe(true);
    expect(atLeast("0.9.0", "0.10.0")).toBe(false);
    // Prereleases sort below their release, which is also the safe direction for a floor.
    expect(atLeast("0.13.0", "0.13.0-rc1")).toBe(true);
    expect(atLeast("0.13.0-rc1", "0.13.0")).toBe(false);
    expect(atLeast("0.13.0-rc2", "0.13.0-rc1")).toBe(true);
  });

  it("the mock advertises BOTH write-fence capabilities, not just a version", () => {
    // A version alone does not pass the write fence: the dispatch-time stamp check and the
    // after-await write-boundary recheck are separate handshake capabilities, and a mock
    // claiming a new version while advertising neither is a panel that lies — which is a
    // worse harness than one that is simply old.
    const s = source().replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    for (const cap of Object.keys(BRIDGE_CAPABILITY_MIN_PANEL_VERSION)) {
      expect(s, `the mock hello must advertise ${cap}`).toMatch(
        new RegExp(`${cap}:\\s*true`),
      );
    }
    // …and a workflow uuid for the per-command stamp to fence on. It is DECLARED in the
    // mock-graph module now and imported here, so this reads the module rather than the
    // script — a grep that keeps passing on a file the value has left is not a check.
    expect(s).toMatch(/workflow_uuid: MOCK_WORKFLOW_UUID/);
    expect(MOCK_WORKFLOW_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("an unimplemented command names the harness, so it is not filed as a panel defect", () => {
    // The subset will never be complete, so the REFUSAL has to carry its own provenance.
    // A bare `unknown <cmd>` from a tab advertising a current panel version reads as a
    // product defect, and an agent with a bug-report tool files it as one — which is
    // exactly what happened.
    // Both markers ASSERTED (codex P3). An unguarded indexOf returns -1 and slice(-1, …)
    // silently widens to most of the file, so the assertion would keep passing on text it
    // was never about. Comments stripped for the same reason: a sentence in a comment
    // satisfying a code assertion is a spell-check.
    const s = codeOnly();
    const from = s.indexOf("const fn = EXEC[m.cmd]");
    const to = s.indexOf("console.log(`   <cmd");
    expect(from, "the dispatch must still exist").toBeGreaterThan(-1);
    expect(to, "the dispatch's end marker must still exist").toBeGreaterThan(from);
    const dispatch = s.slice(from, to);
    expect(dispatch).toMatch(/SMOKE MOCK/);
    expect(dispatch).toMatch(/[Dd]o not file this as a panel defect/);
  });

  it("the mock's socket sends an Origin, because a real panel's does", () => {
    // The THIRD fence this mock had to stop failing. A browser sets Origin on the upgrade
    // and forbids page JS from overriding it, so the bridge treats it as trusted
    // provenance and refuses every graph EDIT without one. The `ws` library sends none by
    // default, so the mock read as a relay connection of unknown provenance and the smoke
    // reported a knowledge failure that was really its own handshake.
    //
    // Asserted here rather than left to the run, because the failure mode is a PASS on the
    // read-only half with "built nodes on the live canvas: NO" — which looks like a model
    // that did not try.
    // NOT comment-stripped, unlike the assertions above: the naive `//.*` strip treats the
    // `//` in `ws://127.0.0.1` as a line comment and deletes the rest of the line — the
    // construction being asserted. A comment cannot satisfy this pattern anyway, because
    // the match must START at `new WebSocket(`.
    expect(source()).toMatch(/new WebSocket\([\s\S]{0,200}?headers:\s*\{\s*Origin:/);
  });

  it("the mock implements the commands the scenario drives", () => {
    // Reads the MOCK GRAPH module, which is where the executors live now. Pointed at the
    // smoke script it passed on a file that no longer contains any of them — an assertion
    // is only about the thing it actually reads.
    //
    // The reply SHAPES and the refusal behaviour are asserted by calling the real
    // executors in knowledge-parity-mock-graph.test.ts; source text cannot see either,
    // as mutation testing demonstrated twice here.
    const mock = readFileSync(new URL("../../../scripts/knowledge-parity-mock-graph.mjs", import.meta.url), "utf8");
    for (const cmd of [
      "graph_clear",
      "graph_load",
      "graph_get_state",
      "graph_outline",
      "graph_find_nodes",
    ]) {
      expect(mock, `the mock executor must implement ${cmd}`).toMatch(new RegExp(`${cmd}:\\s*[({]`));
    }
  });
});
