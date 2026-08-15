#!/usr/bin/env node
/**
 * Every page in navigation must actually SERVE on the deployed site.
 *
 *   node scripts/check-docs-deployed.mjs                  # all locales
 *   node scripts/check-docs-deployed.mjs ko ja            # just these
 *   node scripts/check-docs-deployed.mjs --base https://…
 *
 * Run it AFTER a deploy. It is deliberately not part of `npm test` — it needs the network and
 * a published site, and a gate that fails on someone's flaky wifi gets ignored.
 *
 * ## Why this exists
 *
 * `docs/ko/panel.mdx` has never served. The file is on main, the nav entry is on main, both
 * landed in the same commit as its four siblings — and those four render while
 * /docs/ko/panel returns the 404 shell. Nothing in the repo could see it: the file is present
 * and structurally valid, so check-docs-links and check-docs-locale both pass it. The failure
 * is in the build, and the only place it is observable is the deployed URL.
 *
 * That is the general shape: a page can be correct in git, correct in navigation, pass every
 * static check, and still not exist for a reader. With 12 locales × 5 pages, one silently
 * missing page is easy to never notice — it was, for the entire Korean pilot.
 *
 * ## What actually discriminates
 *
 * Measured, after first getting this wrong. The table:
 *
 *   /docs/backends        200  308213 bytes  has <title>   real
 *   /backends             200  308213 bytes  has <title>   real
 *   /docs/ko/quickstart   200  218541 bytes  has <title>   real
 *   /docs/ko/panel        404   91213 bytes  no <title>    MISSING
 *   /docs/docs/backends   404   91228 bytes  no <title>    404
 *   /totally-made-up-xyz  404   91242 bytes  no <title>    404
 *
 * The HTTP status is a clean signal and agrees with the title check on every row. An earlier
 * version of this comment asserted the opposite — that Mintlify answers 200 for unknown paths
 * so the status is useless. That was generalized from three URLs which all happened to be REAL
 * pages; no known-bad URL had been probed. Stating it confidently in a header comment is how a
 * wrong belief outlives the five minutes it takes to check.
 *
 * All three signals are kept because they fail differently: status catches the ordinary case,
 * `<title>` catches an SPA shell served with 200 (the shape this was built for), and comparing
 * the final URL catches a missing page quietly redirected to a real, titled one — which neither
 * of the other two can see.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS_JSON = path.join(ROOT, 'docs', 'docs.json');
const argv = process.argv.slice(2);
const baseIdx = argv.indexOf('--base');
const BASE = baseIdx >= 0 ? argv[baseIdx + 1] : 'https://comfyui-mcp.artokun.io/docs';
const only = argv.filter((a) => !a.startsWith('--') && a !== BASE);

const cfg = JSON.parse(fs.readFileSync(DOCS_JSON, 'utf8'));
const languages = cfg.navigation?.languages ?? [];

/** Every page slug declared in navigation, per language. */
const pagesFor = (lang) => {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.pages)) {
      for (const p of node.pages) (typeof p === 'string' ? out.push(p) : walk(p));
    }
    if (Array.isArray(node.tabs)) walk(node.tabs);
    if (Array.isArray(node.groups)) walk(node.groups);
  };
  walk(lang.tabs ?? lang.groups ?? []);
  return out;
};

async function serves(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const body = await res.text();
    // A real page has a <title>. The SPA 404 shell does not — and both are HTTP 200.
    const m = body.match(/<title>([^<]*)<\/title>/i);
    const titled = Boolean(m && m[1].trim());
    // A <title> alone is not proof THIS page exists: a missing page that redirects to the
    // docs home returns the home page's perfectly good title. Require the response to still
    // be at the URL we asked for, and the status to be a success.
    const landed = res.url ? res.url.replace(/\/$/, '') === url.replace(/\/$/, '') : true;
    return {
      ok: titled && res.ok && landed,
      title: m?.[1]?.trim() ?? null,
      bytes: body.length,
      status: res.status,
      landedAt: landed ? null : res.url,
    };
  } catch (err) {
    return { ok: false, title: null, bytes: 0, error: String(err.message ?? err) };
  }
}

// An unrecognized locale argument used to select nothing, probe nothing, and exit 0 with a
// cheerful "0 navigation page(s) probed" — a typo'd locale in a deploy script would have read
// as a clean run forever.
const known = new Set(languages.map((l) => l.language));
const unknown = only.filter((c) => !known.has(c));
if (unknown.length) {
  console.error(
    `unknown locale(s): ${unknown.join(', ')} — navigation declares ${[...known].join(', ')}`,
  );
  process.exit(1);
}

let checked = 0;
let broken = 0;
for (const lang of languages) {
  const code = lang.language;
  if (only.length && !only.includes(code)) continue;
  for (const page of pagesFor(lang)) {
    const url = `${BASE}/${page}`.replace(/\/index$/, '');
    const r = await serves(url);
    checked++;
    if (!r.ok) {
      broken++;
      const why = r.error
        ? r.error
        : r.landedAt
          ? `redirected to ${r.landedAt}`
          : !r.status || r.status >= 400
            ? `HTTP ${r.status}`
            : `${r.bytes} bytes, the 404 shell (no <title>)`;
      console.error(`  ✗ ${url} — did not serve this page: ${why}`);
    }
  }
}

console.log(`${checked} navigation page(s) probed on ${BASE} · ${broken} not serving`);
if (checked === 0) {
  console.error('probed nothing — navigation declared no pages for the selected locale(s)');
  process.exit(1);
}
if (broken) {
  console.error(
    `\nThese pages exist in git and in navigation but do not exist for a reader. That is a ` +
      `BUILD failure, not a content one — re-check the deploy log for the named files. Do not ` +
      `"fix" the source: it already passed every static check.`,
  );
  process.exit(1);
}
