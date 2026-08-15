#!/usr/bin/env node
/**
 * Every model post must state its license in a section of its own.
 *
 *   node scripts/check-blog-structure.mjs
 *
 * ## Why this section and not a whole skeleton
 *
 * The model posts already share a spine — measured across the eleven of them, VRAM appeared
 * in 11, install in 10, troubleshooting in 10, FAQ in 10. That structure is real and emerged
 * without a gate, so gating it would be ceremony.
 *
 * Licensing was the exception, and not by a little:
 *
 *   a heading of its own ....  1 / 11   (krea2, and only an H3)
 *   buried in prose or FAQ ..  8 / 11   (between 1 and 8 passing mentions)
 *   absent entirely ......... 2 / 11   (wan-transparent, video-extend-pusa)
 *
 * It is also the highest-stakes fact on the page and where both money-costing errors in this
 * audit were: krea2 invented a 50-seat allowance for a license with a $1M REVENUE gate, and
 * ltx-2.3 called the LTX-2 Community License "Apache 2.0" three times. Both errors are the
 * kind a reader acts on commercially.
 *
 * A fact that important should not be discoverable only by reading the whole post, and "we
 * forgot to mention the license" should not be silent. So: one required section, in the page
 * TOC, checked.
 *
 * ## Scope
 *
 * A post is model-shaped if it documents a pack. Engineering posts are exempt — they discuss
 * the software, not a model whose weights carry terms.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOG = path.join(ROOT, 'docs', 'blog');
const PACKS = path.join(ROOT, 'packs');

const packNames = fs.existsSync(PACKS)
  ? new Set(fs.readdirSync(PACKS).filter((d) => fs.statSync(path.join(PACKS, d)).isDirectory()))
  : new Set();

/** Posts that document packs but are about the tooling, not a model's weights. */
const EXEMPT = new Set(['installer-packs-that-cant-rot.mdx']);

/**
 * Strip fenced code, following Markdown's actual fence rules.
 *
 * A regex backreference demands the closing fence be the SAME LENGTH as the opener, so a
 * three-backtick block closed with four backticks was never stripped — and a fake
 * `## Licensing` inside it satisfied this gate. Markdown closes on a fence of the same
 * character, at least as long as the opener, with nothing after it but whitespace.
 */
function stripFences(src) {
  const out = [];
  let fence = null; // { char, len }
  for (const line of src.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === '') {
        fence = null;
      }
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

let failures = 0;
let checked = 0;
for (const file of fs.readdirSync(BLOG).filter((f) => f.endsWith('.mdx'))) {
  if (file === 'index.mdx' || EXEMPT.has(file)) continue;
  const src = fs.readFileSync(path.join(BLOG, file), 'utf8');

  const documentsAPack =
    // Dots are legal in pack names (ltx-2.3-txt2vid) — see check-blog-staleness for the same fix.
    [...src.matchAll(/packs\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)].some((m) => packNames.has(m[1])) ||
    [...src.matchAll(/`([a-z0-9][a-z0-9.-]*[a-z0-9])`\s+pack/gi)].some((m) => packNames.has(m[1]));
  if (!documentsAPack) continue;

  checked++;
  // Strip fenced code first: a `## Licensing` line inside an example block is not a section,
  // and matching raw text would let a post satisfy this rule with a code sample.
  // Comments are stripped BEFORE the heading search, not after. Stripping later found a
  // `## Licensing` that lived inside `<!-- ... -->` — the heading matched, the opening `<!--`
  // sat above it and so was never in the measured span, and the trailing `-->` plus the hidden
  // prose counted as content. A fully commented-out section passed while rendering nothing.
  // BOTH comment syntaxes. These are .mdx files, where `{/* ... */}` is the native comment and
  // renders as nothing — stripping only HTML comments left a commented-out `## Licensing`
  // plus its prose searchable, so the heading and its 30+ characters satisfied the gate while
  // the reader saw an empty section.
  const body = stripFences(src)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  const m = body.match(/^##\s+Licensing\s*$/m);
  if (!m) {
    failures++;
    console.error(`  ✗ blog/${file}: no "## Licensing" section`);
    continue;
  }
  // ...and the section must SAY something. An empty heading followed straight by the next
  // one passes a presence check while telling the reader nothing, which is the failure this
  // gate exists to prevent — the posts that got licensing wrong were wrong in prose, not in
  // their table of contents.
  const after = body.slice(m.index + m[0].length);
  // HTML comments are not content — they render as nothing. A long
  // `<!-- TODO: add licensing details -->` would otherwise satisfy the length check while the
  // reader sees an empty section, which is the exact state this rule exists to catch.
  const sectionText = after.split(/^##\s+/m)[0].trim();
  // 30, not 80. The point is to catch an EMPTY section, and 80 rejected concise correct prose
  // — "MIT License. Commercial use is permitted without restriction." says everything required
  // in 61 characters. Length cannot establish semantics either way, so it is set where it
  // separates "nothing" from "something" and no higher.
  if (sectionText.length < 30) {
    failures++;
    console.error(
      `  ✗ blog/${file}: "## Licensing" is empty or near-empty (${sectionText.length} chars) — ` +
        `name the license and say whether commercial use is gated`,
    );
  }
}

console.log(`${checked} model post(s) checked for a Licensing section`);
if (failures) {
  console.error(
    `\n${failures} model post(s) do not state their license in a section of their own. Read the ` +
      `license off the model card — not from another post, and not from memory — then add a ` +
      `"## Licensing" H2 before the VRAM section. Name the license exactly, and say whether ` +
      `commercial use is gated and on what (revenue, not seats).`,
  );
  process.exit(1);
}
console.log('blog structure OK');
