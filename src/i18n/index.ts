/**
 * Translations for the HUMAN-facing text this process emits.
 *
 * SCOPE — read this before adding a key.
 *
 * Almost everything this repo emits is read by an LLM, not a person: the 89 panel tool
 * definitions, the ~610 `.describe()` parameter docs, `PANEL_SYSTEM_APPEND`, the per-backend
 * system prompts, `src/tools/vocabulary.ts`, `retired-redirect.ts`, and the refusal modules.
 * Those are prompt engineering — their exact English wording is what the model routes on, and
 * `check:vocabulary` gates it in CI. **None of it may be translated.** Doing so degrades
 * model behaviour silently, and no test in this repo would catch it.
 *
 * What belongs here is the ~150 strings a PERSON reads:
 *   - the CLI (`renderCliHelp`, the connect/tunnel banners, `setup` output)
 *   - the `say` bridge frames that render as chat bubbles in the panel
 *   - `ready-banner.ts`, `start-failure-notice.ts`
 *   - the two HTML pages in `panel-console-http.ts`
 *
 * TWO AUDIENCES, TWO LOCALES. The CLI writes to a terminal owned by whoever launched the
 * process, so it follows the environment. A `say` frame renders inside a specific panel tab,
 * whose language is that user's own setting — and those strings NAME PANEL CONTROLS
 * ("Settings → OpenRouter"), so they must be in the same language as the control they point
 * at, or the instruction is useless. Hence `tr()` (process locale) and `trFor()` (a given
 * panel's locale) are separate calls rather than one ambient default.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Same codes ComfyUI ships, so the panel's language list and ours cannot disagree. */
export const LOCALES = [
  "en", "zh", "zh-TW", "ru", "ja", "ko", "fr", "es", "pt-BR", "tr", "ar", "fa",
] as const;
export type Locale = (typeof LOCALES)[number];

const SUPPORTED = new Set<string>(LOCALES);

/** Resolve arbitrary input to a shipped locale, or null. Mirrors the panel's rules. */
export function resolveLocale(input: string | null | undefined): Locale | null {
  if (!input) return null;
  // Env values arrive as "ko_KR.UTF-8" / "pt_BR.utf8" — strip encoding and normalise.
  const raw = String(input).trim().split(".")[0].replace("_", "-");
  if (!raw) return null;
  if (SUPPORTED.has(raw)) return raw as Locale;

  // Script matters more than region for Chinese. We ship `zh` (Simplified) and `zh-TW`
  // (Traditional); Hong Kong and Macau write Traditional, so plain base-matching to `zh`
  // would hand those users the wrong script — legible-ish, but visibly wrong, and the kind
  // of thing that reads as "they didn't think about us".
  const TRADITIONAL = /^zh-(HK|MO|Hant)/i;
  if (TRADITIONAL.test(raw)) return "zh-TW";

  const base = raw.split("-")[0];
  if (SUPPORTED.has(base)) return base as Locale;
  const lower = raw.toLowerCase();
  for (const code of SUPPORTED) {
    if (code.toLowerCase() === lower || code.toLowerCase() === base.toLowerCase()) return code as Locale;
  }
  // Base not shipped standalone but a regional variant is: pt-PT -> pt-BR, zh-HK -> zh-TW.
  for (const code of LOCALES) {
    if (code.toLowerCase().startsWith(`${base.toLowerCase()}-`)) return code;
  }
  return null;
}

/**
 * The locale for terminal output. `--lang` beats the app-specific env var, which beats the
 * POSIX locale chain. Explicit intent wins over ambient configuration at every step.
 */
export function processLocale(argv: readonly string[] = process.argv): Locale {
  const flagIdx = argv.findIndex((a) => a === "--lang" || a.startsWith("--lang="));
  if (flagIdx !== -1) {
    const raw = argv[flagIdx].includes("=") ? argv[flagIdx].split("=")[1] : argv[flagIdx + 1];
    const hit = resolveLocale(raw);
    if (hit) return hit;
  }
  for (const env of ["COMFYUI_MCP_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const hit = resolveLocale(process.env[env]);
    if (hit) return hit;
  }
  return "en";
}

/** locale -> flat key map. Loaded lazily and cached; `en` is always empty (fallbacks inline). */
const catalogs = new Map<string, Record<string, string>>();

function localesDir(): string {
  // Resolves from dist/i18n/ at runtime and src/i18n/ under vitest — walk up to the package
  // root either way rather than assuming which one we are in.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "locales");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "locales");
}

function flatten(obj: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else if (typeof v === "string") out[key] = v;
  }
  return out;
}

function catalogFor(locale: string): Record<string, string> {
  const cached = catalogs.get(locale);
  if (cached) return cached;
  let loaded: Record<string, string> = {};
  // English needs no file: every call site carries its English text as the fallback.
  if (locale !== "en") {
    try {
      const p = join(localesDir(), locale, "main.json");
      if (existsSync(p)) loaded = flatten(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      // A malformed or unreadable catalog means English, never a crash. This text is printed
      // during startup and while reporting other failures — it must not be able to add one.
      loaded = {};
    }
  }
  catalogs.set(locale, loaded);
  return loaded;
}

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralCategory(locale: string, n: number): string {
  try {
    let r = pluralRules.get(locale);
    if (!r) {
      r = new Intl.PluralRules(locale);
      pluralRules.set(locale, r);
    }
    return r.select(n);
  } catch {
    return n === 1 ? "one" : "other";
  }
}

export type Fallback = string | Record<string, string>;
export type Vars = Record<string, string | number>;

function pickForm(fallback: Fallback, n: number): string {
  if (typeof fallback === "string") return fallback;
  if (!fallback || typeof fallback !== "object") return "";
  return fallback[pluralCategory("en", n)] ?? fallback.other ?? Object.values(fallback)[0] ?? "";
}

/**
 * Translate for a specific locale.
 *
 * `fallback` is the English source text and stays at the call site, so the code reads as prose
 * and a missing translation degrades to correct English rather than a raw key. Counted strings
 * pass `{ count }` and take an object fallback (`{ one: "…", other: "…" }`); the category comes
 * from `Intl.PluralRules`, which knows that Korean has one form and Russian four.
 */
export function trFor(locale: string, key: string, fallback: Fallback, vars?: Vars): string {
  const resolved = resolveLocale(locale) ?? "en";
  const cat = catalogFor(resolved);
  let out: string | undefined;

  if (vars && typeof vars.count === "number") {
    const c = pluralCategory(resolved, vars.count);
    out = cat[`${key}_${c}`] ?? cat[`${key}_other`] ?? cat[key];
    if (out === undefined) out = pickForm(fallback, vars.count);
  } else {
    out = cat[key] ?? (typeof fallback === "string" ? fallback : pickForm(fallback, 0));
  }
  out = out ?? "";

  // ONE pass. A loop of `split(...).join(...)` per variable expands placeholders that appear
  // INSIDE an already-substituted value — a pod named `{id}` would be rewritten by the next
  // variable's turn, destroying the user's own data. A single pass never revisits its output.
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name as keyof typeof vars]) : whole,
    );
  }
  return out;
}

let cachedProcessLocale: Locale | null = null;

/** Translate for the TERMINAL — CLI help, banners, startup errors. */
export function tr(key: string, fallback: Fallback, vars?: Vars): string {
  cachedProcessLocale ??= processLocale();
  return trFor(cachedProcessLocale, key, fallback, vars);
}

/** Test seam: forget the memoised process locale and every loaded catalog. */
export function __resetI18nForTest(): void {
  cachedProcessLocale = null;
  catalogs.clear();
}
