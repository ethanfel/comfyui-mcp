/**
 * Laying out terminal text whose width you no longer control.
 *
 * THE PROBLEM. Every aligned thing this process prints was padded with `String.length`: the two-column
 * `--help` screen, the colon-aligned label blocks in the connect and tunnel banners, the
 * `════` rules that fence them. That was correct for exactly as long as every string was
 * ASCII, because for ASCII the two numbers are equal.
 *
 * They stop being equal the moment the same line is Korean, Japanese or Chinese. Those
 * characters are East Asian Wide: one code unit, TWO cells. Padding a 6-character Korean
 * label to column 15 with `15 - s.length` therefore leaves it 6 cells too wide, and every
 * line under it steps to the right — the exact "the box visibly broke" failure, and one
 * that is invisible on a developer machine reading English.
 *
 * Combining marks go the other way. Arabic and Persian diacritics render INTO the preceding
 * cell and occupy none of their own, so counting them pads too little.
 *
 * This is a deliberately narrow subset of UAX #11 — the Wide/Fullwidth blocks that can
 * actually appear in the twelve locales we ship, plus zero for the marks and format
 * characters. It is not a general `wcwidth` and does not need to be. Ambiguous-width
 * characters (`—`, `•`, and the `═` box rule itself) are treated as ONE cell, which is what
 * every terminal outside a CJK legacy locale does — and what the current banners already
 * assume, since they draw their rules by repeating `═` a fixed number of times.
 */

/**
 * East Asian Wide + Fullwidth. Ranges, not a property escape: ECMAScript exposes
 * `\p{Script=Hangul}` but NOT `\p{East_Asian_Width=Wide}`, so there is nothing to ask.
 */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo (initial consonants)
  [0x2e80, 0x303e], // CJK Radicals … CJK Symbols. Stops before U+303F, which is narrow.
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compat Jamo, CJK compat
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables — the bulk of Korean text
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, small form variants
  [0xff00, 0xff60], // Fullwidth ASCII forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x20000, 0x3fffd], // CJK Extension B and beyond
];

/** Marks that render into the previous cell, plus format characters (ZWJ, bidi marks). */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Emoji that default to the two-cell colour form, asked as a PROPERTY rather than as ranges.
 *
 * Ranges are the wrong tool here and were wrong when first written: the emoji blocks are
 * interleaved with narrow symbols, so a hand-picked span like `1F300–1F64F` silently makes
 * 🚀 (U+1F680) one cell and ✅ (U+2705, which is not in any emoji block at all) one cell,
 * while the property gets both right. It also draws the line in exactly the place the
 * banners need it: `✓`, `—`, `•` and `═` are text-presentation symbols, stay one cell, and
 * so keep drawing the rules at the width this module promises.
 */
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u;

/** Terminal cells a string occupies. */
export function displayWidth(text: string): number {
  let width = 0;
  // Iterating the string (not indexing it) yields whole code points, so an astral
  // character counts once rather than twice for its surrogate halves.
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (ZERO_WIDTH.test(ch)) continue;
    let wide = EMOJI_WIDE.test(ch);
    if (!wide) {
      for (const [lo, hi] of WIDE) {
        if (cp >= lo && cp <= hi) {
          wide = true;
          break;
        }
      }
    }
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * Pad `text` so the next column starts at `width` cells, never closer than `min`.
 *
 * `min` is what keeps an over-long entry readable instead of glued to its neighbour, and it
 * is the reason this reproduces the hand-written help layout byte for byte: the existing
 * screen already leaves three spaces after a description that overruns its column.
 */
export function padTo(text: string, width: number, min = 1): string {
  return text + " ".repeat(Math.max(min, width - displayWidth(text)));
}

/** Widest line in a block, measured in cells. Embedded newlines are split first. */
export function widestLine(lines: readonly string[]): number {
  let widest = 0;
  for (const line of lines) {
    for (const part of line.split("\n")) widest = Math.max(widest, displayWidth(part));
  }
  return widest;
}

/**
 * The `════` boxes the CLI prints, drawn from their CONTENT rather than from a rule length
 * typed in once and hoped to still fit.
 *
 * These blocks used to be literal arrays with a 68-character rule above and below. That was
 * a guess even in English — the connect banner's longest line is 71 cells, so its rule has
 * been three short of its own content for as long as it has existed — and a guess is not
 * something translation survives: the same sentence in Japanese is a different number of
 * cells, in either direction. Deriving the rule from the widest line means the box fits
 * whatever language is inside it.
 *
 * The floor keeps every box at least as wide as it renders today, so no box gets NARROWER
 * because a language is terser.
 *
 * The ceiling is 80 because that is the width a terminal box can actually assume, and the
 * two failure modes are not symmetric. A line that overhangs its rule looks untidy; a RULE
 * that overhangs the terminal wraps onto a second line and stops being a frame at all. The
 * tunnel banner is the case that settles it: one of its lines is a URL plus a 48-character
 * token plus the same token again, which no rule was ever going to contain.
 */
export const RULE_MIN = 68;
export const RULE_MAX = 80;

export function banner(title: string, body: ReadonlyArray<string | null>): string {
  const lines = body.filter((l): l is string => l !== null);
  const width = Math.min(RULE_MAX, Math.max(RULE_MIN, widestLine([` ${title}`, ...lines])));
  const rule = "═".repeat(width);
  return ["", rule, ` ${title}`, rule, ...lines, rule, ""].join("\n");
}

/**
 * A colon-aligned label block (` Driving      : http://…`).
 *
 * The column comes from the widest label PRESENT, in cells, so a translated label lands
 * where its own text ends rather than where the English text used to. A value may contain
 * newlines; continuation lines are indented to the value column by this helper, because
 * that indent is a function of the translated label width and therefore cannot be baked
 * into the string a translator writes.
 */
export function labelRows(
  indent: string,
  rows: ReadonlyArray<readonly [string, string]>,
): string[] {
  // Callers build these lists conditionally (the connect banner's `Secure` row is only there
  // for a remote pod), so an empty list is reachable. `Math.max()` of nothing is -Infinity
  // and `" ".repeat(-Infinity)` throws — which would turn an empty section into a crash on
  // the startup path, in the one module that must never be able to add a failure.
  if (rows.length === 0) return [];
  const column = Math.max(...rows.map(([label]) => displayWidth(label))) + 1;
  const hanging = " ".repeat(displayWidth(indent) + column + 2);
  return rows.flatMap(([label, value]) => {
    const [first, ...rest] = value.split("\n");
    return [`${indent}${padTo(label, column, 1)}: ${first}`, ...rest.map((r) => hanging + r)];
  });
}

/** `   1. …` steps. Continuation lines hang under the text, not under the number. */
export function numberedSteps(steps: readonly string[]): string[] {
  return steps.flatMap((step, i) => {
    const [first, ...rest] = step.split("\n");
    return [`   ${i + 1}. ${first}`, ...rest.map((r) => `      ${r}`)];
  });
}
