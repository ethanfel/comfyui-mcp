import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No wait may outlive the test that contains it (#1325).
 *
 * The helper's default is 15s. A test whose OWN budget is smaller — `it(name, fn, 10000)` —
 * hits the runner's deadline first, and vitest then reports its generic "test timed out"
 * instead of the wait naming what never arrived. That is the opposite of the point of the
 * change. Codex found the first instance in `run-template.test.ts`; an audit found two more
 * in `ui-bridge.test.ts` that I had not thought to look for.
 *
 * A guard rather than a one-time sweep: the next tight-budget test is one `it(…, 5000)`
 * away and nothing else would notice. The fix at each site is a small explicit timeout with
 * a note about why that number — not raising the test's budget, which is usually deliberate.
 *
 * ## Why this parses instead of pattern-matching
 *
 * Two earlier versions of this audit were wrong in opposite directions, both from reading
 * `}, 80);` as a test budget:
 *
 *   - an indent-blind regex counted `setTimeout(fn, 80)` written across lines as an 80ms
 *     test, inventing offenders;
 *   - a lookahead (`waitFor\((?![^)]*timeout)`) stopped at the first `)`, which is inside
 *     `expect(...)`, so every bounded wait looked unbounded.
 *
 * So the third version finds the `it(` call and walks its parens to the real end, which is
 * the only way to know whether a trailing number is that call's timeout argument.
 */
const TEST_ROOT = "src/__tests__";
const HELPER_DEFAULT_MS = 15_000;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Index just past the `)` that closes the call whose `(` sits at `from - 1`. */
function callEndsAt(src: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < src.length && depth > 0) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") depth--;
    i++;
  }
  return i;
}

/** Every `it(...)`/`test(...)` call with an explicit timeout argument, as [body, ms]. */
export function timedTests(src: string): { body: string; ms: number; at: number }[] {
  const out: { body: string; ms: number; at: number }[] = [];
  for (const m of src.matchAll(/\b(?:it|test)(?:\.\w+)?\(/g)) {
    const start = m.index! + m[0].length;
    const end = callEndsAt(src, start);
    const call = src.slice(start, end - 1);
    // The timeout is the LAST argument: `…}, 10000` at the top level of this call.
    const tail = /,\s*(\d+)\s*$/.exec(call);
    if (!tail) continue;
    out.push({ body: call, ms: Number(tail[1]), at: src.slice(0, m.index!).split("\n").length });
  }
  return out;
}

/** Waits in `body` that state no timeout of their own. */
export function untimedWaits(body: string): number {
  let n = 0;
  for (const wm of body.matchAll(/waitFor\(/g)) {
    const call = body.slice(wm.index!, callEndsAt(body, wm.index! + wm[0].length));
    if (!call.includes("timeout:")) n++;
  }
  return n;
}

describe("#1325 — a wait never outlives its test's budget", () => {
  it("every untimed waitFor sits in a test with room for the 15s default", () => {
    const offenders: string[] = [];
    for (const file of testFiles(TEST_ROOT)) {
      // …except THIS file, which contains a deliberately offending fixture so the audit can
      // be shown to detect one. Skipping it by name rather than by a marker comment: a
      // marker would be one more thing another file could accidentally acquire.
      if (file.endsWith("wait-for-budgets.test.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (!src.includes("waitFor(")) continue;
      for (const t of timedTests(src)) {
        if (t.ms >= HELPER_DEFAULT_MS) continue;
        const n = untimedWaits(t.body);
        if (n) {
          offenders.push(
            `${file}:${t.at} — test budget ${t.ms}ms < ${HELPER_DEFAULT_MS}ms default, ` +
              `with ${n} untimed wait(s) inside it`,
          );
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the audit can actually SEE an offender, and is not fooled by a stray number", () => {
    // A check that scans for a condition passes trivially when the scan is broken, and both
    // earlier versions of this one were. So drive it over a fixture that must trip it, and
    // one that must not.
    const offending = `
      it("a tight one", async () => {
        await waitFor(() => expect(thing()).toBe(true));
      }, 5000);
    `;
    const bounded = `
      it("a tight one that bounds its wait", async () => {
        await waitFor(() => expect(thing()).toBe(true), { timeout: 1000 });
      }, 5000);
    `;
    const notATimeout = `
      it("uses a delay, which is not a test budget", async () => {
        await new Promise((r) => setTimeout(() => {
          r(undefined);
        }, 80));
        await waitFor(() => expect(thing()).toBe(true));
      });
    `;

    expect(timedTests(offending).map((t) => t.ms)).toEqual([5000]);
    expect(untimedWaits(timedTests(offending)[0].body)).toBe(1);
    // Bounded: the test is still found, but it has nothing untimed in it.
    expect(untimedWaits(timedTests(bounded)[0].body)).toBe(0);
    // A trailing 80 belongs to setTimeout, not to `it` — so this is not a timed test at all.
    expect(timedTests(notATimeout)).toEqual([]);
  });
});
