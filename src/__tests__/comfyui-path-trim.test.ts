// #1512 — COMFYUI_PATH was consumed exactly as given, so ONE trailing space made
// every install-root check miss and the connected ComfyUI was reported as
// undeterminable — 40 minutes after the bad value took effect, at the first write,
// with a message that echoed the path back but never pointed at the space.
//
// The value is trivially easy to produce. cmd.exe assigns everything up to the
// `&&`, INCLUDING the space before it:
//
//     cmd /k "set COMFYUI_PATH=E:\...\ComfyUI && comfyui-mcp connect ..."
//
// so the launcher line people actually paste bakes one in. The panel pack already
// stripped it (`__init__.py`); the orchestrator did not — the two halves of one
// product disagreeing is the defect.
//
// THE TRAP THIS FILE GUARDS. The report calls `resolveComfyUIPath` "the single
// ingestion point". There are FIVE non-test readers, and a fix confined to the
// first is not just incomplete — it makes one case WORSE: extra-paths.ts compares
// the raw env against `config.comfyuiPath`, so normalizing only the latter turns
// an accidental match into a mismatch and silently reclassifies an explicitly
// named root as "inferred". The source rule below exists because four of the five
// sit where a unit test cannot cheaply reach, and every failure mode is silence.
//
// THE REPAIR IS A FALLBACK, NOT A CLEANUP. Trailing whitespace and quotes are
// legal POSIX filename characters, and a directory literally named `ComfyUI ` is
// creatable on Windows too (measured). So a value that RESOLVES as given is never
// touched. That still fixes the report: measured on win32, `existsSync("<root> ")`
// is false and `join("<root> ", "main.py")` does not resolve either — which is
// exactly why every install-root check missed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeInstallPathEnv, __resetMalformedPathWarnings } from "../utils/install-path-env.js";

/** Normalize with the on-disk check stubbed OUT — the value names nothing, which
 *  is the only state the repair is allowed to act on. */
const norm = (raw: string | undefined, warn = false) =>
  normalizeInstallPathEnv(raw, { exists: () => false, warn });

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

beforeEach(() => {
  __resetMalformedPathWarnings();
});

describe("normalizeInstallPathEnv (#1512)", () => {
  it("strips the trailing space cmd.exe bakes into `set VAR=v && cmd`", () => {
    const out = norm("E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI ");
    expect(out.path).toBe("E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI");
    expect(out.changed).toBe(true);
  });

  it("strips a MATCHED surrounding quote pair, the other paste artifact", () => {
    expect(norm('"C:\\ComfyUI"').path).toBe("C:\\ComfyUI");
    expect(norm("'C:\\ComfyUI'").path).toBe("C:\\ComfyUI");
    // Quote OUTSIDE the space and space INSIDE the quote both normalize.
    expect(norm('  "C:\\ComfyUI "  ').path).toBe("C:\\ComfyUI");
  });

  it("leaves a LONE trailing quote alone", () => {
    // `"` is illegal in a Windows filename but LEGAL on POSIX. Stripping one
    // unconditionally would corrupt a real path in order to fix a typo — the
    // repair must not be able to do more damage than the bug.
    expect(norm('/srv/weird"').path).toBe('/srv/weird"');
    expect(norm('/srv/weird"').changed).toBe(false);
    expect(norm("'/srv/half").path).toBe("'/srv/half");
  });

  it("treats a whitespace-only value as UNSET so detection still runs", () => {
    // Adopting "   " as a path would be worse than the bug: it defeats
    // auto-detection AND cannot work. Both call sites truthy-check the result.
    expect(norm("   ").path).toBeUndefined();
    expect(norm('" "').path).toBeUndefined();
    expect(norm("").path).toBeUndefined();
    expect(norm(undefined).path).toBeUndefined();
  });

  it("reports changed:false for an already-clean value", () => {
    const out = norm("/opt/ComfyUI");
    expect(out.path).toBe("/opt/ComfyUI");
    expect(out.changed).toBe(false);
  });

  it("does NO filesystem probe for a value it cannot change (codex P2)", () => {
    // Five readers call this, some of them hot, and it replaced a plain env read.
    // A stat per call would be new synchronous I/O on every one — and on a UNC or
    // network root that call can block. The existence question only matters when
    // the repair would change something, so it must not be asked otherwise.
    // Counted, because "we only probe when needed" is the kind of claim that
    // silently stops being true.
    const probed: string[] = [];
    const spy = (p: string) => {
      probed.push(p);
      return false;
    };

    normalizeInstallPathEnv("/opt/ComfyUI", { exists: spy, warn: false });
    normalizeInstallPathEnv("", { exists: spy, warn: false });
    normalizeInstallPathEnv(undefined, { exists: spy, warn: false });
    expect(probed).toEqual([]);

    // ...and exactly one probe when it WOULD change the value, since that is the
    // only case where the answer decides anything.
    normalizeInstallPathEnv("/opt/ComfyUI ", { exists: spy, warn: false });
    expect(probed).toEqual(["/opt/ComfyUI "]);
  });
});

describe("the malformed value is REPORTED, not silently repaired (#1512)", () => {
  let errs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errs = [];
    spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
  });
  afterEach(() => spy.mockRestore());

  it("names the variable, both values, and the launcher line that produced it", () => {
    norm("C:\\ComfyUI ", true);
    const msg = errs.join("\n");

    expect(msg).toMatch(/COMFYUI_PATH/);
    // JSON-quoted so the offending space is VISIBLE — the original error echoed
    // the path bare, which is precisely why the space went unnoticed.
    expect(msg).toMatch(/"C:\\\\ComfyUI "/);
    expect(msg).toMatch(/&&/);
    expect(msg).toMatch(/fix the launcher line/i);
  });

  it("warns ONCE per distinct value — retarget re-resolves on every switch", () => {
    norm("C:\\ComfyUI ", true);
    norm("C:\\ComfyUI ", true);
    norm("D:\\Other ", true);
    expect(errs.length).toBe(2);
  });

  it("says nothing when the value was already clean", () => {
    norm("/opt/ComfyUI", true);
    expect(errs).toHaveLength(0);
  });

  it("says nothing when the value RESOLVES as given — nothing was repaired", () => {
    // The non-destructive guard's own half: a directory literally named with a
    // trailing space is left untouched, so there is no repair to report either.
    normalizeInstallPathEnv("/srv/ComfyUI ", { exists: () => true, warn: true });
    expect(errs).toHaveLength(0);
  });
});

/** Rebuild the config module against a specific COMFYUI_PATH. `config` is a
 *  module-level const evaluated at import time, so the env must be set BEFORE
 *  the import — which is exactly how the real process sees it. */
async function comfyuiPathFor(raw: string | undefined): Promise<string | undefined> {
  const prev = process.env.COMFYUI_PATH;
  const prevUrl = process.env.COMFYUI_URL;
  vi.resetModules();
  if (raw === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = raw;
  // Keep detection out of it: an unset URL is fine, but a stray remote URL from
  // another test would send resolveComfyUIPath down its remote branch.
  delete process.env.COMFYUI_URL;
  try {
    const mod = (await import("../config.js")) as { config: { comfyuiPath?: string } };
    return mod.config.comfyuiPath;
  } finally {
    if (prev === undefined) delete process.env.COMFYUI_PATH;
    else process.env.COMFYUI_PATH = prev;
    if (prevUrl === undefined) delete process.env.COMFYUI_URL;
    else process.env.COMFYUI_URL = prevUrl;
    vi.resetModules();
  }
}

describe("the WIRING — a real config build normalizes the env (#1512)", () => {
  it("the reporter's exact value no longer reaches config.comfyuiPath", async () => {
    // Not the helper in isolation: this is the module-level `config` the whole
    // server reads, built from process.env the way the real process builds it.
    const dirty = "E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI ";
    expect(await comfyuiPathFor(dirty)).toBe("E:\\Ai_server\\ComfyUI_windows_portable\\ComfyUI");
  });

  it("a quoted value is unwrapped", async () => {
    expect(await comfyuiPathFor('"C:\\ComfyUI"')).toBe("C:\\ComfyUI");
  });
});

describe("NO reader of COMFYUI_PATH consumes it raw (#1512)", () => {
  // The report calls resolveComfyUIPath "the single ingestion point". It is not.
  // There are FIVE non-test readers, and the three past the obvious two are the
  // reason this is a source-level rule rather than a couple of unit tests:
  //
  //   - orchestrator/index.ts     → feeds the spawn env builders, so a bad value
  //                                 reaches every agent this orchestrator starts
  //   - panel-tools.ts            → joins it into the workflows dir, which then
  //                                 silently does not exist (library reads empty)
  //   - extra-paths.ts            → compares it against config.comfyuiPath, which
  //                                 IS normalized; leaving this side raw makes a
  //                                 named root reclassify as "inferred"
  //   - workspace-env.ts          → labels the workspace source
  //
  // Each sits somewhere a unit test cannot cheaply reach, and the failure mode is
  // silence in every case. So the invariant is enforced where it can be seen.
  const FILES = [
    ["orchestrator", "index.ts"],
    ["orchestrator", "panel-tools.ts"],
    ["services", "extra-paths.ts"],
    ["services", "workspace-env.ts"],
    ["config.ts"],
  ].map((p) => join(SRC, ...p));

  it("every raw read is normalized within 3 lines", () => {
    let totalReads = 0;
    const offenders: string[] = [];

    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        // Skip COMMENTS: several of these files mention the variable by name in
        // prose without reading it, and counting those makes the rule fire on
        // documentation. Both forms matter — `//` line comments and the ` * `
        // continuation lines of a JSDoc block, which is what a first version of
        // this scan missed (extra-paths.ts:279 explains the discriminator in
        // exactly those words).
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) return;
        const code = line.replace(/\/\/.*$/, "");
        if (!/process\.env\.COMFYUI_PATH/.test(code)) return;
        // EVERY occurrence on the line must be an argument — counted, not merely
        // "the line contains a safe-looking call" (codex P2, twice).
        //
        // A proximity rule passes when the normalized result is discarded and the
        // raw variable is forwarded anyway. A line-level rule passes on
        //
        //     const p = normalizeInstallPathEnv(process.env.COMFYUI_PATH).path; f(process.env.COMFYUI_PATH);
        //
        // because the first occurrence exempts the second. Comparing counts is
        // what actually encodes "no raw read survives": the guarded tally has to
        // account for all of them.
        const occurrences = (code.match(/process\.env\.COMFYUI_PATH/g) ?? []).length;
        const guarded = (
          code.match(/(?:normalizeInstallPathEnv|resolveComfyUIPath)\(\s*process\.env\.COMFYUI_PATH/g) ??
          []
        ).length;
        totalReads += occurrences;
        if (guarded === occurrences) return;
        offenders.push(
          `${file.replace(SRC, "src")}:${i + 1}  (${guarded}/${occurrences} consumed)  ${line.trim()}`,
        );
      });
    }

    // The premise. If the scan finds nothing the rule is vacuous and this test is
    // a rubber stamp that would keep passing after someone renames the variable.
    expect(totalReads).toBeGreaterThanOrEqual(5);

    expect(
      offenders,
      `These read process.env.COMFYUI_PATH without normalizing it. A trailing space ` +
        `(Windows \`set VAR=v && cmd\`) then fails silently at each one (#1512):\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
