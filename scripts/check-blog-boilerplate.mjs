#!/usr/bin/env node
/**
 * The shared install step must say the same thing in every blog post.
 *
 *   node scripts/check-blog-boilerplate.mjs
 *
 * ## Why
 *
 * One sentence — "the panel auto-starts a background agent on your Claude subscription" —
 * was copy-pasted into TEN posts. It was true when it was written. When the panel became a
 * pure-frontend pack that cannot spawn a process, it became false in ten places at the same
 * moment, and nothing noticed: no test covers prose, and each copy looked locally fine.
 *
 * `docs/snippets/panel-install.mdx` is now the single source of truth for that sentence. This
 * gate asserts every post that carries the step matches it exactly, so the copies cannot drift
 * apart again — and so fixing the snippet tells you, by name, which posts still need updating.
 *
 * ## Why not just import the snippet?
 *
 * That is the better end state and the snippet is written to support it: Mintlify renders
 * `/snippets/*.mdx` as importable components. The blocker is that the step lives inside a
 * NUMBERED LIST, and a block-level component inside a list item is exactly the kind of MDX
 * construct that renders differently than it reads. Converting ten live posts to it without a
 * local `mint dev` render check is a bet on the docs site, so the conversion is deliberately
 * left as a follow-up for whoever can preview it. Until then, this gate buys the same
 * anti-drift property at no rendering risk.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOG = path.join(ROOT, 'docs', 'blog');
const SNIPPET = path.join(ROOT, 'docs', 'snippets', 'panel-install.mdx');

const eol = (s) => s.replace(/\r\n/g, '\n');
/** Collapse wrapping so a line-broken copy compares equal to a single-line one. */
const flat = (s) => eol(s).replace(/\s+/g, ' ').trim();
/**
 * Join SOFT line breaks, keep paragraph breaks.
 *
 * These posts are hard-wrapped at ~80 columns, so a retired claim routinely straddles a
 * newline: "the panel auto-starts a\nbackground agent" renders identically to the banned
 * sentence. Round 1 tested `flat(src)` (immune to wrapping, but a pattern could then match
 * across a paragraph boundary); round 2 moved to raw source and reintroduced the wrap hole in
 * the process. Neither is right — unwrap within a paragraph, preserve the blank line between.
 */
const unwrap = (s) =>
  eol(s)
    .split(/\n{2,}/)
    .map((para) => para.replace(/\n[ \t]*/g, ' '))
    .join('\n\n');

if (!fs.existsSync(SNIPPET)) {
  console.error(`missing ${path.relative(ROOT, SNIPPET)} — it is the source of truth for this step`);
  process.exit(1);
}
const canonical = flat(fs.readFileSync(SNIPPET, 'utf8'));
// An empty source of truth silently disables the comparison: `"".includes("")` is true, so
// every post would "match" and the gate would report green while checking nothing. Existence
// is not enough — a truncated or cleared snippet is exactly how this dies quietly.
if (canonical.length < 40) {
  console.error(
    `${path.relative(ROOT, SNIPPET)} is empty or too short (${canonical.length} chars) — ` +
      `with no canonical text every post trivially matches and this gate checks nothing`,
  );
  process.exit(1);
}

/**
 * How we find posts carrying the SHARED step.
 *
 * Deliberately the sentence's distinctive tail, not its opening clause. Matching on
 * "Install comfyui-mcp and the Panel" caught two posts (train-lora-runpod,
 * video-extend-pusa-comfyui) that open the same way and then continue with their own
 * instructions — setting RUNPOD_API_KEY, applying a specific pack. Those carry a different
 * step, not a drifted copy of this one, and demanding they match would force unrelated
 * rewrites. The retired-claim check below still applies to every post regardless.
 */
const MARKER = /sign in with `claude` once/;
/**
 * The exact SET of posts that carry the shared step — identity, not a count.
 *
 * Three attempts, each killed by the next mutation:
 *   `>= 10` floor  — one post opted out, count hit exactly 10, passed. A margin hides the
 *                    first defection, which is the only one that matters.
 *   `=== 11` count — catches a lone departure, but a swap is invisible: one carrier edits its
 *                    marker and leaves while a new post adopts the step, and 11 still holds.
 *   this set       — names them. A departure, an arrival, or a swap all fail, by filename.
 *
 * The underlying weakness is that MARKER both selects and validates, so the marker text can
 * opt a post out. codex confirmed no content-only selector can infer intended membership; the
 * clean fix is importing a shared component, which is blocked on rendering a block component
 * inside a numbered list. Until then, membership is recorded here on purpose.
 */
const EXPECTED_CARRIERS = new Set([
  'anima-comfyui.mdx',
  'ernie-image-comfyui.mdx',
  'ideogram-4-comfyui.mdx',
  'lora-trainer-p1.mdx',
  'ltx-2.3-comfyui.mdx',
  'qwen-image-comfyui.mdx',
  'video-extend-pusa-comfyui.mdx',
  'wan-2.2-comfyui.mdx',
  'wan-animate-comfyui.mdx',
  'wan-transparent-comfyui.mdx',
  'z-image-comfyui.mdx',
]);
// Written from a MEASUREMENT, not from memory. The first version of this list was typed from
// recall and was wrong three ways in eleven entries — it invented two carriers
// (comfyui-agent-claude-or-chatgpt, krea2) and missed ltx-2.3. The gate caught all three on
// its first run, which is the argument for identity over a count: a count cannot tell you
// that the members are wrong, only that there are the right number of them.
/** Claims this step must never make again, with why. */
const RETIRED = [
  {
    pattern: /auto-starts a background agent/i,
    why: 'the panel is a pure-frontend pack and cannot spawn the orchestrator; the user runs `connect`',
  },
  {
    pattern: /external\/local orchestrator/i,
    why: 'that setting has no UI row and the mode is unconditionally on',
  },
  {
    // Caught in comfyui-agent-claude-or-chatgpt AFTER the first two patterns had already
    // cleaned ten posts: same false claim, different verb, so it sailed through. The panel
    // is a pure frontend extension and spawns nothing.
    // `[^.]` let the match run across a CLAUSE boundary, so correct prose like
    // "The panel starts disconnected; launch the orchestrator yourself" tripped it — a false
    // positive whose only fix is deleting accurate manual-launch guidance, which is the worst
    // way for a docs gate to be wrong. Bar `;`, `,`, `—` and newlines too: the false claim is
    // one clause ("the panel starts the orchestrator"), never a sentence spanning punctuation.
    // The object must be the orchestrator, not merely near it. A `[^.;,]{0,40}` allowance
    // still matched "The panel starts disconnected until you launch the orchestrator" —
    // correct guidance saying the OPPOSITE of the retired claim. Only determiners, possessives
    // and adjectives may sit between the verb and the noun.
    // Any adjective may sit between the verb and the noun, EXCEPT words that open a new
    // clause. The previous version whitelisted only "background" and possessives while its
    // comment claimed it allowed adjectives, so "the panel starts a local orchestrator" — a
    // genuinely false claim — passed. Whitelists of adjectives are unwinnable; the short
    // stoplist below is what actually separates the two meanings, because in the CORRECT
    // sentences a verb like "launch" or a conjunction always intervenes.
    pattern:
      /panel\s+(?:starts|spawns|launches|boots)\s+(?:(?!(?:until|unless|before|after|when|then|so|because|and|but|if|once|launch|run|start|connect|yourself|without|no|nothing|neither|instead)\b)[A-Za-z][A-Za-z’'-]*\s+){0,3}orchestrator/i,
    why: 'the panel is a pure frontend extension and cannot spawn a process; the user runs `connect`',
  },
  {
    // Same post claimed a bridge port per backend. src/orchestrator/index.ts:1450 is explicit:
    // "Single-port multi-provider: ONE orchestrator on ONE bridge port (default 9180) serves
    // ALL providers" — the provider is chosen per TAB over the hello/set_backend handshake.
    pattern: /each backend runs its\s+\*{0,2}own\*{0,2}\s+orchestrator/i,
    why: 'one orchestrator on one bridge port serves every provider; the panel selects per tab',
  },
];

let failures = 0;
const carrying = new Set();
for (const file of fs.readdirSync(BLOG).filter((f) => f.endsWith('.mdx'))) {
  const src = fs.readFileSync(path.join(BLOG, file), 'utf8');
  const f = flat(src);

  // Against the NORMALIZED-but-unflattened source. `flat()` collapses every newline to a
  // space, so excluding the newline character inside these patterns was a no-op — a retired
  // claim could still match across a paragraph break. Line structure is signal here, not noise.
  const prose = unwrap(src);
  for (const { pattern, why } of RETIRED) {
    // Look BACKWARDS from each match instead of blanket-stripping negated spans. The strip
    // approach deleted any 60 characters after a negation cue, so an unrelated correct
    // negation earlier in the sentence swallowed a real claim: "The user does not connect
    // because the panel auto-starts a background agent" erased the very phrase being checked.
    // Now the cue only excuses a claim it is actually attached to.
    const NEGATION = /\b(?:no longer|not|doesn['’]t|does not|cannot|can['’]t|never|used to)\s*$/i;
    // 'gi' outright — the source patterns already carry `i`, and appending produced 'igi',
    // which throws. matchAll requires the global flag.
    const hits = [...prose.matchAll(new RegExp(pattern.source, 'gi'))];
    const affirmative = hits.filter((h) => !NEGATION.test(prose.slice(Math.max(0, h.index - 24), h.index)));
    if (affirmative.length) {
      failures++;
      console.error(`  ✗ blog/${file}: retired claim "${pattern.source}" — ${why}`);
    }
  }

  if (!MARKER.test(f)) continue;
  carrying.add(file);
  if (!f.includes(canonical)) {
    failures++;
    console.error(
      `  ✗ blog/${file}: the install step has drifted from docs/snippets/panel-install.mdx`,
    );
  }
}

// A FLOOR on carriers. The marker both selects and validates, so editing the marker text
// opts a post out of coverage entirely — and if every post drifted, `carrying` would be 0 and
// this gate would report success having compared nothing. codex called this fail-open twice;
// a floor does not fix the selector, but it does make total collapse loud instead of green.
const missingCarriers = [...EXPECTED_CARRIERS].filter((f) => !carrying.has(f));
const extraCarriers = [...carrying].filter((f) => !EXPECTED_CARRIERS.has(f));
for (const f of missingCarriers) {
  failures++;
  console.error(
    `  ✗ blog/${f}: expected to carry the shared install step but does not — its marker ` +
      `text was probably edited, which silently removes it from this gate`,
  );
}
for (const f of extraCarriers) {
  failures++;
  console.error(
    `  ✗ blog/${f}: carries the shared install step but is not in EXPECTED_CARRIERS — ` +
      `add it once you have confirmed the step is right for this post`,
  );
}

console.log(`${carrying.size} post(s) carry the shared install step`);
if (failures) {
  console.error(
    `\n${failures} problem(s). Edit docs/snippets/panel-install.mdx, then make every post match ` +
      `it — that file is the source of truth precisely so this sentence cannot be wrong in ten ` +
      `places at once again.`,
  );
  process.exit(1);
}
console.log('blog boilerplate OK');
