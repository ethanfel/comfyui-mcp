#!/usr/bin/env node
/**
 * Docs integrity: navigation ↔ files ↔ links.
 *
 *   node scripts/check-docs-links.mjs
 *
 * Three questions no existing gate answers:
 *
 *   1. Does every page listed in docs.json navigation actually exist on disk? A missing one
 *      is a 404 from the sidebar — the most visible kind of broken doc.
 *   2. Does every .mdx on disk appear in the navigation? An orphan is a page nobody can reach
 *      by browsing. `seo.indexing: "all"` means search engines still index it, so an orphan is
 *      a page that only strangers find.
 *   3. Does every relative link resolve to a real page? These rot silently: the target gets
 *      renamed, the link still renders, and only a reader discovers it.
 *
 * External links and anchors are reported separately and never fail the run — a network flake
 * or a heading rename should not turn CI red on a docs edit.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const cfg = JSON.parse(fs.readFileSync(path.join(DOCS, 'docs.json'), 'utf8'));

/** Every page path the navigation references, wherever it is nested. */
function navPages(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) navPages(n, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'pages' && Array.isArray(v)) {
      for (const p of v) {
        if (typeof p === 'string') out.push(p);
        else navPages(p, out);
      }
    } else if (typeof v === 'object') {
      navPages(v, out);
    }
  }
  return out;
}

const listed = [...new Set(navPages(cfg.navigation))];

/** Every .mdx/.md page on disk, as a navigation-style path. */
const onDisk = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(node_modules|_snippets|snippets|images|logo|\.)/.test(e.name)) walk(full);
      continue;
    }
    // BOTH .md and .mdx are published — measured, not assumed: /docs/quickstart (.mdx) and
    // /docs/design/agent-backend-injection (.md) both returned 200 on the live site. An
    // earlier version globbed .mdx only, on the strength of /docs/README returning 404; that
    // was the wrong inference from a single sample. README is excluded by name below, which
    // is what that 404 actually shows.
    if (!/\.mdx?$/.test(e.name)) continue;
    if (/^README\.mdx?$/i.test(e.name)) continue;
    onDisk.push(path.relative(DOCS, full).replace(/\\/g, '/').replace(/\.mdx?$/, ''));
  }
})(DOCS);

const diskSet = new Set(onDisk);
const listedSet = new Set(listed);

const missing = listed.filter((p) => !diskSet.has(p));
const orphans = onDisk.filter((p) => !listedSet.has(p));

// Relative links inside page bodies.
const RELATIVE = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
const brokenLinks = [];
const anchorOnly = [];
for (const page of onDisk) {
  const file = fs.existsSync(path.join(DOCS, page + '.mdx'))
    ? path.join(DOCS, page + '.mdx')
    : path.join(DOCS, page + '.md');
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(RELATIVE)) {
    const raw = m[1];
    const [target] = raw.split('#');
    if (!target) { anchorOnly.push(`${page} → ${raw}`); continue; }
    // Resolve relative to the page's own directory, like a browser would.
    const base = path.posix.dirname(page);
    let resolved = target.startsWith('/')
      ? target.replace(/^\//, '')
      : path.posix.normalize(path.posix.join(base === '.' ? '' : base, target));
    resolved = resolved.replace(/\.mdx?$/, '').replace(/\/$/, '');
    // A link to a DIRECTORY means that directory's index page — `[blog index](./)` from
    // inside blog/ is `blog/index`, and `[home](../)` from a post is the root `index`.
    // Without this, every legitimate "back to the section" link reads as broken; it produced
    // 6 false positives out of 11 the first time this ran.
    if (resolved === '' || resolved === '.') resolved = 'index';
    const candidates = [
      resolved,
      `${resolved}/index`,
      resolved.replace(/^docs\//, ''),
      `${resolved.replace(/^docs\//, '')}/index`,
    ];
    if (!candidates.some((c) => diskSet.has(c))) brokenLinks.push(`${page} → ${raw}`);
  }
}

console.log(`docs pages on disk: ${onDisk.length}`);
console.log(`pages in navigation: ${listed.length}`);
console.log(`anchor-only links (not checked): ${anchorOnly.length}`);

let failures = 0;
if (missing.length) {
  failures += missing.length;
  console.error(`\n✗ ${missing.length} navigation entr(ies) with no file — these 404 from the sidebar:`);
  for (const p of missing) console.error(`    ${p}`);
}
if (brokenLinks.length) {
  failures += brokenLinks.length;
  console.error(`\n✗ ${brokenLinks.length} relative link(s) that do not resolve:`);
  for (const l of brokenLinks.slice(0, 40)) console.error(`    ${l}`);
  if (brokenLinks.length > 40) console.error(`    … ${brokenLinks.length - 40} more`);
}
if (orphans.length) {
  // Reported, not failed: a deliberately unlisted page is a legitimate choice, and
  // `seo.indexing: "all"` means it is still reachable from search.
  console.log(`\n· ${orphans.length} page(s) on disk but not in navigation (reachable only by URL/search):`);
  for (const p of orphans.slice(0, 25)) console.log(`    ${p}`);
  if (orphans.length > 25) console.log(`    … ${orphans.length - 25} more`);
}

if (failures) {
  console.error(`\n${failures} broken reference(s).`);
  process.exit(1);
}
console.log('\ndocs links OK');
