#!/usr/bin/env node
/**
 * Structural comparison of a localized docs page against its English source.
 *
 *   node scripts/check-docs-locale.mjs ko
 *   node scripts/check-docs-locale.mjs            # every locale directory under docs/
 *
 * Why this exists alongside the reviewing agent: an agent judges MEANING, which is the part
 * a script cannot do — and it is also the part that fails softly. What fails HARD is
 * structure. A translated shell command, a dropped code fence, a relative link that no longer
 * resolves from inside `ko/` — those break for every reader, and they are exactly what a
 * deterministic check catches every time and a reviewer catches most of the time.
 *
 * The rules below are ordered by how badly they hurt a reader who hits them:
 *
 *   1. a code block whose contents changed — they will run it and it will fail
 *   2. a link that cannot resolve — a dead end mid-task
 *   3. missing or untranslated frontmatter — the search snippet, and the page title
 *   4. a lost or added heading — the page no longer matches its English counterpart
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = path.join(ROOT, 'docs');

/**
 * Fenced code blocks, contents only.
 *
 * The leading `[ \t]*` is load-bearing. Most fences in these docs are INDENTED inside an MDX
 * component (`<Step>`, `<Tab>`, `<Card>`), and anchoring the fence to column 0 saw 0 of 1
 * blocks in quickstart, 3 of 6 in installation and 1 of 4 in panel — the rule that matters
 * most, silently checking about half of what it claimed to. A mutation inside a component's
 * code block sailed straight through.
 */
const fences = (src) => {
  const out = [];
  const re = /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
};

const headings = (src) => (src.match(/^#{1,6} /gm) || []).map((h) => h.trim());

/** MDX component opens, e.g. <Steps>, <Step title="…">, <Note> — names only. */
const components = (src) =>
  (src.match(/<([A-Z][A-Za-z0-9]*)\b/g) || []).map((c) => c.slice(1)).sort();

const frontmatter = (src) => {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
};

const links = (src) =>
  [...src.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((h) => !/^https?:|^mailto:/.test(h));

/**
 * The anchor a heading generates. Mintlify lowercases, strips punctuation, and joins words
 * with hyphens; non-Latin scripts pass through unchanged.
 *
 * This exists because translating a heading SILENTLY changes its anchor. `## Setup` is
 * `#setup`; translate it to `## 설정` and every `#setup` link — in this page and in every
 * other page that deep-links to it — resolves to nothing. The reviewing agents found two
 * instances of this in five pages, which is a high enough rate that it needs a machine check
 * before eleven more locales are generated.
 */
const slugify = (heading) =>
  heading
    .replace(/^#{1,6}\s+/, '')
    .trim()
    .toLowerCase()
    // \p{M} — COMBINING MARKS — are kept. They are not decoration: in Arabic, Hebrew, and the
    // Indic scripts a mark is part of the word. Dropping them is a Latin-centric assumption,
    // and it fired the moment a non-Latin locale arrived: the Arabic heading
    // "3. تشغيل منسّق اللوحة" contains a shadda (U+0651, category Mn), so this slugified to
    // ...منسق while the link written beside it kept the mark, and the gate reported a correct
    // cross-page anchor as broken. Excluding marks here would have pushed a translator to
    // "fix" the prose instead.
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')
    // Each space becomes its own hyphen — runs are NOT collapsed. "readiness & onboarding"
    // loses the ampersand and keeps both surrounding spaces, so Mintlify emits
    // `readiness--onboarding` with two hyphens. Collapsing here reported two correct,
    // English-inherited links as broken.
    .replace(/\s/g, '-');

const anchors = (src) => new Set((src.match(/^#{1,6} .+$/gm) || []).map(slugify));


const localeDirs = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const locales = localeDirs.length
  ? localeDirs
  : fs
      .readdirSync(DOCS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[a-z]{2}(-[A-Za-z]+)?$/.test(e.name))
      .map((e) => e.name);

let failures = 0;
const fail = (loc, page, msg) => {
  failures++;
  console.error(`  ✗ ${loc}/${page}: ${msg}`);
};

for (const loc of locales) {
  const dir = path.join(DOCS, loc);
  if (!fs.existsSync(dir)) {
    console.log(`  · ${loc} absent`);
    continue;
  }
  const pages = fs.readdirSync(dir).filter((f) => /\.mdx?$/.test(f));
  const localized = new Set(pages.map((f) => f.replace(/\.mdx?$/, '')));
  let checked = 0;

  for (const file of pages) {
    const slug = file.replace(/\.mdx?$/, '');
    const srcPath = fs.existsSync(path.join(DOCS, `${slug}.mdx`))
      ? path.join(DOCS, `${slug}.mdx`)
      : path.join(DOCS, `${slug}.md`);
    if (!fs.existsSync(srcPath)) {
      fail(loc, slug, `no English source at docs/${slug}.mdx — an orphan translation`);
      continue;
    }
    checked++;
    // Normalise line endings before ANY comparison. On Windows the English pages come out of
    // git as CRLF while a freshly written translation is LF, so a byte comparison reports
    // every single code block as "modified" — which is exactly what this check did on its
    // first run, against three files whose code was in fact identical. Git normalises on
    // commit; the difference is never real content.
    const eol = (s) => s.replace(/\r\n/g, '\n');
    const en = eol(fs.readFileSync(srcPath, 'utf8'));
    const tr = eol(fs.readFileSync(path.join(dir, file), 'utf8'));

    // 1. Code blocks: same count, byte-identical contents.
    const ef = fences(en);
    const tf = fences(tr);
    if (ef.length !== tf.length) {
      fail(loc, slug, `${ef.length} code block(s) in English, ${tf.length} here`);
    } else {
      for (let i = 0; i < ef.length; i++) {
        if (ef[i] !== tf[i]) {
          fail(loc, slug, `code block #${i + 1} was modified — a reader runs this verbatim`);
          break;
        }
      }
    }

    // 2. Links resolve, none are relative (they break from inside the locale directory), and
    //    every anchor exists in the page it points at.
    const ownAnchors = anchors(tr);
    for (const href of links(tr)) {
      const [rawTarget, frag] = href.split('#');

      // Same-page anchor: must match a heading in THIS file, post-translation.
      if (!rawTarget) {
        if (frag && !ownAnchors.has(frag.toLowerCase())) {
          fail(loc, slug, `anchor "#${frag}" matches no heading here — a translated heading changes its slug`);
        }
        continue;
      }
      if (/^\.\.?\//.test(href)) {
        fail(loc, slug, `relative link "${href}" — use an absolute /docs/... path from a locale directory`);
        continue;
      }
      // A DOUBLED prefix is the one link form that genuinely 404s, and the normalization below
// would hide it: `/docs/docs/backends` strips to `docs/backends`, which resolves on disk.
      // Measured on the live site: /docs/backends and /backends both render the real page;
      // /docs/docs/backends returns the same shell as a nonsense URL. Two review agents reached
      // OPPOSITE conclusions about the prefix by reasoning from repo conventions, which is why
      // this is pinned to an observation rather than an argument.
      // `(\/|$)` — the trailing-slash-only form let the bare `/docs/docs` through, which is
      // the same 404 without a suffix.
      if (/^\/docs\/docs(\/|$)/.test(rawTarget)) {
        fail(loc, slug, `link "${href}" doubles the /docs prefix — it 404s; use "/docs/..." once`);
        continue;
      }
      // ONE form, enforced. Both `/docs/backends` and `/backends` render the real page, so
      // this is not correctness — it is anti-churn. With ko/fr at 36 prefixed links and
      // ja/zh/es at 30 prefixed + 6 bare, a review agent inside any single file could justify
      // "fixing" it either direction, and one did: it stripped the prefix from zh/installation
      // to match ja, arguing from repo conventions that the prefix was invented. It is not.
      // Pinning the form removes the ambiguity that made the rewrite look correct.
      // Only DOC PAGES. A root-absolute path with a file extension is a site asset or a
      // well-known file — /robots.txt, /sitemap.xml, /favicon.svg — and prefixing those with
      // /docs turns a working link into a 404. Rewriting a correct link to satisfy a gate is
      // the worst outcome available here, so the rule is scoped to extensionless paths.
      // Any extension length (`/site.webmanifest` is 12), and any underscore-prefixed route
      // (`/_next/...`) — the earlier `/_/` alternative only matched a literal single underscore
      // segment, which is not a thing. Getting this wrong tells an author to rewrite a working
      // asset link into a 404, so it errs toward exempting.
      const looksLikeAsset =
        /\.[a-z0-9]+$/i.test(rawTarget) || /^\/(api|assets|static|_[a-z0-9-]*)\//i.test(rawTarget);
      // `(?!docs\/)` alone rejected the bare `/docs` link — the lookahead wants a slash after
      // "docs", which the docs root does not have — so a correct link to the docs home was
      // reported as missing the prefix it already is.
      const alreadyPrefixed = /^\/docs(\/|$)/.test(rawTarget);
      const isSiteAsset = /^\/(images|logo)\//.test(rawTarget);
      if (!looksLikeAsset && !alreadyPrefixed && !isSiteAsset && /^\/[a-z]/.test(rawTarget)) {
        fail(
          loc,
          slug,
          `link "${href}" is missing the /docs prefix — localized pages use "/docs/..." ` +
            `everywhere (both forms resolve; we pin one so agents stop rewriting each other)`,
        );
        continue;
      }
      // `/docs` (no trailing slash) is the docs ROOT, not a page called "docs". Stripping only
      // `/docs/` left the bare form as the slug "docs", which resolves to no file and was
      // reported as a broken link — a correct docs-home link failing the gate.
      const target = rawTarget
        .replace(/^\/docs(\/|$)/, '')
        .replace(/^\//, '')
        .replace(/\/$/, '');
      if (!target) continue;
      const isLocal = target.startsWith(`${loc}/`);
      const bare = isLocal ? target.slice(loc.length + 1) : target;
      const exists = isLocal
        ? localized.has(bare)
        : fs.existsSync(path.join(DOCS, `${bare}.mdx`)) ||
          fs.existsSync(path.join(DOCS, `${bare}.md`)) ||
          fs.existsSync(path.join(DOCS, bare));
      if (!exists) {
        fail(loc, slug, `link "${href}" resolves to nothing`);
        continue;
      }
      // Cross-page anchor: check it against the headings of the page actually linked to,
      // which for a localized target means the TRANSLATED headings.
      if (frag) {
        const targetFile = isLocal
          ? path.join(dir, `${bare}.mdx`)
          : fs.existsSync(path.join(DOCS, `${bare}.mdx`))
            ? path.join(DOCS, `${bare}.mdx`)
            : path.join(DOCS, `${bare}.md`);
        if (fs.existsSync(targetFile)) {
          const targetAnchors = anchors(eol(fs.readFileSync(targetFile, 'utf8')));
          if (!targetAnchors.has(frag.toLowerCase())) {
            fail(loc, slug, `anchor "#${frag}" does not exist in ${isLocal ? `${loc}/` : ''}${bare}`);
          }
        }
      }
    }

    // 3. Frontmatter present, and actually translated.
    const ef2 = frontmatter(en);
    const tf2 = frontmatter(tr);
    if (!tf2) {
      fail(loc, slug, 'no frontmatter');
    } else {
      // "Present, and not byte-identical to English" is the rule that works for EVERY locale.
      // An earlier version also demanded non-Latin characters, which is correct for ko/ja/ru/ar
      // and simply wrong for fr/es/pt-BR/tr — a French title is Latin script and still
      // translated. A rule that fires on four of eleven correct locales is worse than no rule.
      // `description` is always prose, so an identical one means it was never translated —
      // and it is the search snippet, which is the whole SEO point. `title` is often a bare
      // product name ("ComfyUI MCP", "Docker", "RunPod") where leaving it identical is
      // correct, so it only has to be PRESENT.
      if (ef2?.title && !tf2.title) fail(loc, slug, 'frontmatter title missing');
      if (ef2?.description) {
        if (!tf2.description) fail(loc, slug, 'frontmatter description missing');
        else if (tf2.description === ef2.description)
          fail(loc, slug, 'frontmatter description is still English — this is the search snippet');
      }
      if (ef2?.icon && tf2.icon !== ef2.icon) fail(loc, slug, `icon changed (${ef2.icon} → ${tf2.icon})`);
    }

    // 4. Shape: heading count and component set.
    const eh = headings(en).length;
    const th = headings(tr).length;
    if (eh !== th) fail(loc, slug, `${eh} heading(s) in English, ${th} here`);
    const ec = components(en).join(',');
    const tc = components(tr).join(',');
    if (ec !== tc) fail(loc, slug, `MDX components differ — English [${ec}] vs [${tc}]`);
  }
  console.log(`  ${failures ? '·' : '✓'} ${loc} — ${checked} page(s) compared`);
}

if (failures) {
  console.error(`\n${failures} structural problem(s).`);
  process.exit(1);
}
console.log('\nlocalized docs OK');
