import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Source-level guards for the translated CLI surface.
 *
 * These read the SOURCE rather than the rendered output on purpose. Both properties they
 * check are invisible in a rendering: a key typo'd out of its namespace still renders
 * perfect English (the fallback is right there at the call site), and translating a tool
 * definition also renders perfectly — right up until a model stops routing on it. Neither
 * failure has an observable symptom until a catalog exists, by which point the mistake is
 * spread across twelve of them.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The files this unit translates. */
const CLI_SURFACE = [
  join(SRC, "transport", "cli.ts"),
  join(SRC, "boot.ts"),
  join(SRC, "services", "agent-setup.ts"),
];

/** `tr("key"` — the key is always the first argument and always a plain literal. */
const KEY = /\btr\(\s*"([^"]+)"/g;

/** `tr("key", "fallback"` / `tr("key", 'fallback'` — the fallback's first literal fragment. */
const KEY_AND_FALLBACK =
  /\btr\(\s*"([^"]+)"\s*,\s*(?:("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*'))/g;

function matchAll(re: RegExp, text: string): RegExpExecArray[] {
  return [...text.matchAll(new RegExp(re.source, re.flags))];
}

describe("CLI translation call sites", () => {
  it("namespaces every key under `cli.`", () => {
    for (const file of CLI_SURFACE) {
      const src = readFileSync(file, "utf8");
      const keys = matchAll(KEY, src).map((m) => m[1]);
      expect(keys.length, `${relative(SRC, file)} should have translated strings`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key, `${relative(SRC, file)}: key "${key}" must start with "cli."`).toMatch(/^cli\./);
      }
    }
  });

  it("gives one key exactly one English text", () => {
    // A key is the identity of a string in twelve catalogs at once. Two call sites sharing
    // a key with DIFFERENT English is the one mistake a translator cannot detect and cannot
    // fix: whichever wording they are shown, the other call site silently renders it.
    // Sharing a key for genuinely identical text is fine, and this allows it.
    const byKey = new Map<string, Set<string>>();
    for (const file of CLI_SURFACE) {
      for (const m of matchAll(KEY_AND_FALLBACK, readFileSync(file, "utf8"))) {
        const set = byKey.get(m[1]) ?? new Set<string>();
        set.add(m[2] ?? m[3]);
        byKey.set(m[1], set);
      }
    }
    expect(byKey.size).toBeGreaterThan(0);
    for (const [key, texts] of byKey) {
      expect([...texts], `key "${key}" carries more than one English text`).toHaveLength(1);
    }
  });
});

/** Every .ts under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * The files whose ENGLISH IS THE INTERFACE. Enumerated, not pattern-matched: an over-broad
 * guard here would block the units that legitimately DO translate parts of the orchestrator
 * (the ready banner, the start-failure notice, the `say` frames), and a guard that blocks
 * the fix is worse than the one it replaced.
 */
function agentFacingFiles(): string[] {
  return [
    ...walk(join(SRC, "tools")),
    // The per-backend system prompts: the wording each harness's model is steered by.
    ...readdirSync(join(SRC, "orchestrator"))
      .filter((n) => n.endsWith("-backend.ts"))
      .map((n) => join(SRC, "orchestrator", n)),
    join(SRC, "orchestrator", "panel-tools.ts"),
    join(SRC, "orchestrator", "fence-refusal.ts"),
    join(SRC, "orchestrator", "call-tool-admission.ts"),
    join(SRC, "orchestrator", "cli-remedy.ts"),
  ];
}

describe("the agent-facing surface is NOT translated", () => {
  it("keeps the translation runtime out of the files a model routes on", () => {
    // The boundary from src/i18n/index.ts, enforced instead of only documented. Everything
    // below is prompt engineering — its exact English wording is what the model selects on,
    // `check:vocabulary` gates it in CI, and translating it degrades behaviour with nothing
    // in this repo failing. A reviewer looking at a diff full of plausible `tr()` calls has
    // no way to see which side of the line each one is on; this does.
    //
    // Both the import AND the call are checked. Matching only the import would miss
    // `const { tr } = await import("../i18n/index.js")`, which is the form boot.ts already
    // uses elsewhere in this very change; matching only the call would miss a re-export.
    const IMPORTS_I18N = /(?:from|import\()\s*["'][^"']*i18n\/index\.js["']/;
    // `(?:For)?`, not `For?` — the latter reads as "trFo" + optional "r" and matches neither
    // `tr(` nor anything else that exists. It looked right and passed, which is exactly why
    // this guard was mutation-tested against a call it was supposed to catch.
    const CALLS_TR = /\btr(?:For)?\(/;
    for (const file of agentFacingFiles()) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue; // a module that has since been renamed is not this test's business
      }
      const where = relative(SRC, file);
      expect(src, `${where} must not import the i18n runtime`).not.toMatch(IMPORTS_I18N);
      expect(src, `${where} must not call tr()/trFor()`).not.toMatch(CALLS_TR);
    }
  });

  it("keeps PANEL_SYSTEM_APPEND untranslated without freezing the file around it", () => {
    // src/orchestrator/index.ts cannot go in the list above: the panel persona lives there,
    // but so do human-facing startup banners that ARE in scope for translation. So the guard
    // is drawn around the symbol rather than the file.
    const src = readFileSync(join(SRC, "orchestrator", "index.ts"), "utf8");
    const start = src.indexOf("const PANEL_SYSTEM_APPEND");
    expect(start, "PANEL_SYSTEM_APPEND was renamed — re-aim this guard").toBeGreaterThan(-1);
    const persona = src.slice(start, src.indexOf("`;", start));
    // A rename or a refactor that shrank the literal to nothing would make this vacuous.
    expect(persona.length).toBeGreaterThan(500);
    expect(persona, "the panel persona must not be translated").not.toMatch(/\btr(?:For)?\(/);
  });
});
