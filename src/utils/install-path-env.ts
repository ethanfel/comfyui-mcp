// #1512 — install-root path normalization, kept OUT of config.ts on purpose.
//
// config.ts builds its module-level `config` at IMPORT time (env reads, install
// detection), which is why so many suites mock it wholesale. Putting a pure
// string helper behind that module forced every one of those partial mocks to
// grow a new export — 46 tests went red on the first attempt for exactly that
// reason, none of them a product defect. A leaf module with one node:fs import
// has no such gravity.
import { existsSync } from "node:fs";
/**
 * #1512 — normalize an install-root path arriving from the ENVIRONMENT.
 *
 * `COMFYUI_PATH` was consumed exactly as given, so one trailing space made every
 * install-root check miss and the connected ComfyUI was reported as
 * undeterminable — 40 minutes after the bad value took effect, at the first
 * write, with a message that echoed the path but never pointed at the space.
 *
 * That value is trivially easy to produce on Windows. `cmd.exe` assigns
 * everything up to the `&&`, INCLUDING the space before it:
 *
 *     cmd /k "set COMFYUI_PATH=E:\...\ComfyUI && comfyui-mcp connect ..."
 *
 * so the launcher line people actually paste bakes in a trailing space. The
 * panel pack already strips this (`__init__.py`); the orchestrator did not, and
 * the two halves of one product disagreeing is the actual defect.
 *
 * Quote stripping is deliberately CONSERVATIVE: only a matched leading+trailing
 * pair of the SAME character is removed, because that is the paste artifact
 * (`set COMFYUI_PATH="C:\...\ComfyUI"`). A lone trailing quote is left alone —
 * `"` is an illegal filename character on Windows but LEGAL on POSIX, so
 * stripping one unconditionally would corrupt a real path to fix a typo.
 *
 * Returns `changed` so callers can SAY the value was malformed rather than
 * silently repairing it: a launcher that produces a bad value here will produce
 * one everywhere else too, and silent normalization hides that.
 */
export function normalizeInstallPathEnv(
  raw: string | undefined,
  opts: {
    varName?: string;
    /** Injected for tests; defaults to a throw-safe existsSync. */
    exists?: (p: string) => boolean;
    /** Set false to normalize without emitting the ingestion warning. */
    warn?: boolean;
  } = {},
): { path: string | undefined; changed: boolean } {
  if (typeof raw !== "string") return { path: undefined, changed: false };

  let v = raw.trim();
  const first = v[0];
  if ((first === '"' || first === "'") && v.length >= 2 && v[v.length - 1] === first) {
    v = v.slice(1, -1).trim();
  }

  // NOTHING TO REPAIR — return without touching the disk (codex P2). This is the
  // overwhelmingly common case: a well-formed value, on every call, at five
  // readers, some of them hot. Probing first would add synchronous I/O to what
  // used to be a plain environment read, and on a UNC/network root that stat can
  // block. The existence question only ever matters when the repair would
  // actually change something, so it is asked only then.
  if (v === raw) return { path: raw === "" ? undefined : raw, changed: false };

  // THE GUARD THAT MAKES THIS NON-DESTRUCTIVE (codex P1). Trailing whitespace and
  // quote characters are LEGAL in POSIX filenames, and a directory literally named
  // `ComfyUI ` is creatable on Windows too (measured on win32). So a blanket trim
  // can silently redirect a caller away from a real directory — a repair doing more
  // damage than the bug it fixes.
  //
  // If the value as GIVEN resolves, it is not malformed: keep it untouched. The
  // repair is therefore a strict FALLBACK, and can only ever act on a value that
  // does not name anything. This still fixes the report: measured on win32,
  // existsSync("<root> ") is false and join("<root> ", "main.py") does not resolve
  // either, which is precisely why every install-root check missed.
  //
  // The TOCTOU here is inherent to any existence-based fallback and is benign in
  // both directions: a path created after a failed probe gets normalized away (it
  // did not exist when we were asked), and one deleted after a successful probe is
  // returned as given and fails downstream exactly as it would have before.
  const exists =
    opts.exists ??
    ((p: string): boolean => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
  if (raw !== "" && exists(raw)) return { path: raw, changed: false };

  // An all-whitespace value normalizes to "" — treated as UNSET, matching the
  // existing `||` truthy checks at the call sites (a set-but-empty COMFYUI_PATH=
  // already means "unset" here).
  const path = v === "" ? undefined : v;
  // Warned HERE rather than by each caller, so a new ingestion point cannot get
  // the normalization while silently forgetting to report it — and so every call
  // site is the same single expression, which is what lets the source gate demand
  // the raw read be consumed inline.
  if (opts.warn !== false) warnInstallPathWasMalformed(raw, path, opts.varName);
  return { path, changed: true };
}

/** Warn ONCE per distinct malformed value — the retarget path re-resolves on
 *  every switch, and a warning that repeats on a timer is one people learn to
 *  scroll past. */
const warnedMalformedPaths = new Set<string>();

/**
 * #1512 — say that the value was malformed, at INGESTION, instead of letting it
 * surface much later as "the models directory could not be determined". The
 * reporter's own follow-up, and the half that turns a 40-minute-delayed mystery
 * into an immediate, actionable line.
 */
function warnInstallPathWasMalformed(
  raw: string,
  normalized: string | undefined,
  varName = "COMFYUI_PATH",
): void {
  // No `raw === normalized` guard here: the sole caller already fires this only
  // when it actually changed something. A second copy of that condition read as
  // defensive but was undetectable — mutation testing kills nothing when it is
  // removed, which is the signal that it decides nothing.
  if (warnedMalformedPaths.has(raw)) return;
  warnedMalformedPaths.add(raw);
  console.error(
    `[comfyui-mcp] WARNING: ${varName} had surrounding whitespace or quotes and was ` +
      `normalized.\n` +
      `  as given:   ${JSON.stringify(raw)}\n` +
      `  using:      ${JSON.stringify(normalized ?? null)}\n` +
      `  On Windows, \`set ${varName}=<path> && <cmd>\` captures the space BEFORE the \`&&\` — ` +
      `fix the launcher line, or the same malformed value will reach anything else it starts.`,
  );
}

/** Reset the warn-once ledger. Test-only — a module-level Set otherwise leaks
 *  across cases in the same worker and makes the second assertion vacuous. */
export function __resetMalformedPathWarnings(): void {
  warnedMalformedPaths.clear();
}
