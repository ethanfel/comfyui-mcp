#!/usr/bin/env node
/**
 * A post that describes a pack must be re-checked when that pack changes.
 *
 *   node scripts/check-blog-staleness.mjs          # report
 *   node scripts/check-blog-staleness.mjs --check  # exit 1 if anything is stale
 *
 * ## Why not a version stamp
 *
 * The obvious design is `verified: 0.51.49` in frontmatter plus "fail if the current release
 * is more than N ahead". That gate fires on every release, for every post, whether or not
 * anything the post describes actually moved. A gate that cries every week is a gate people
 * turn off, and a gate people turn off is worse than none — it also *looks* like coverage.
 *
 * So this keys on the thing that actually goes wrong. Every finding in this audit that came
 * from staleness had the same shape: the post described a pack, the pack moved, the post
 * didn't. wan-2.2 said Q4_K_S after the pack repinned to Q8_0. video-extend-pusa said "no
 * dedicated pack yet" after wan-pusa-extend shipped. ernie said the pack excludes Z-Image
 * after combo groups were added.
 *
 * A post is stale here when git says a pack it documents was modified AFTER the post was last
 * verified. Nothing else. Releases alone never trip it.
 *
 * ## The stamp
 *
 * Frontmatter `verified: YYYY-MM-DD` — the day someone last read the post against source.
 * Bump it when you re-verify, not when you fix a typo. Posts with no stamp are reported as
 * unverified rather than assumed fine, because "nobody has ever checked this" and "this was
 * checked and is current" must not look identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOG = path.join(ROOT, 'docs', 'blog');
const PACKS = path.join(ROOT, 'packs');
const CHECK = process.argv.includes('--check');

const packNames = fs.existsSync(PACKS)
  ? new Set(fs.readdirSync(PACKS).filter((d) => fs.statSync(path.join(PACKS, d)).isDirectory()))
  : new Set();

/**
 * A shallow clone cannot answer the only question this gate asks.
 *
 * `actions/checkout` defaults to `fetch-depth: 1`. In that repo there is exactly ONE commit, so
 * `git log -1 -- packs/<name>` returns the tip for EVERY path — every pack looks like it changed
 * today. The comparison below then reports every stamped post as stale, for a reason that has
 * nothing to do with the packs.
 *
 * This is not hypothetical: it is how this gate first ran red. Its runs on this branch split on
 * UTC midnight to the minute — 23:35 and 23:58 green, 00:09 and 00:15 red, with nothing touching
 * packs/ in between (the 23:58 and 00:09 heads are eleven minutes and two blog paragraphs apart).
 * Before midnight the tip commit's date still equalled the `verified: 2026-08-14` stamp; after it,
 * the tip read 2026-08-15 and beat every stamp. With real history those packs last moved
 * 2026-07-30.
 *
 * So: refuse to answer rather than answer wrong. A false stale is worse than no reading — it
 * trains people to bump stamps they did not earn, which is the exact failure the stamp exists to
 * prevent. CI fetches full history (see .github/workflows/ci.yml) so the gate stays live there.
 */
function isShallowClone() {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

/** Last commit date touching a path, as YYYY-MM-DD. Null when git can't say. */
function lastChanged(rel) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', rel], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

if (isShallowClone()) {
  const msg =
    'shallow clone — git cannot say when a pack last changed, and guessing here reports ' +
    'every stamped post as stale.';
  // Report mode skips. GATE mode FAILS: exiting 0 here means a checkout-depth regression
  // silently disables the gate while still printing a reassuring line, which is the exact
  // shape of "looks like coverage, checks nothing".
  if (CHECK) {
    console.error(
      `cannot run: ${msg} Fetch full history in CI (actions/checkout fetch-depth: 0) or run ` +
        'without --check for a report.',
    );
    process.exit(1);
  }
  console.log(`skipped: ${msg} Re-run with full history (\`git fetch --unshallow\`).`);
  process.exit(0);
}

/**
 * Posts known to carry a `verified:` stamp.
 *
 * Recorded because `--check` deliberately fails on STALE and not on UNSTAMPED, which leaves an
 * escape hatch: delete the stamp from a stale post and the blocking failure becomes a passing
 * backlog line. Naming the members closes it — removal fails, and adding a stamp to a post not
 * listed here is fine (it just shrinks the backlog, so a new entry is a one-line follow-up).
 *
 * Measured from the tree, not typed from memory — the same list written by hand for
 * check-blog-boilerplate was wrong three ways in eleven entries.
 */
const STAMPED = new Set([
  'ernie-image-comfyui.mdx',
  'video-extend-pusa-comfyui.mdx',
  'wan-2.2-comfyui.mdx',
  'wan-animate-comfyui.mdx',
  'wan-transparent-comfyui.mdx',
]);

const stale = [];
const unverified = [];
const unreadable = [];
const invalid = [];
let ok = 0;

for (const file of fs.readdirSync(BLOG).filter((f) => f.endsWith('.mdx'))) {
  if (file === 'index.mdx') continue;
  const src = fs.readFileSync(path.join(BLOG, file), 'utf8');

  const named = new Set();
  // Dots are legal in pack names (ltx-2.3-txt2vid). A dot-blind class captured "ltx-2", which
  // matches no pack, so every ltx post looked like it documented nothing and was skipped
  // entirely — by this gate AND by check-blog-structure, which carried the same regex.
  for (const m of src.matchAll(/packs\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
    if (packNames.has(m[1])) named.add(m[1]);
  }
  for (const m of src.matchAll(/`([a-z0-9][a-z0-9.-]*[a-z0-9])`\s+pack/gi)) {
    if (packNames.has(m[1])) named.add(m[1]);
  }
  if (!named.size) continue; // nothing pack-shaped to go stale against

  // FRONTMATTER ONLY. Scanning the whole file let any body line — including one inside a
  // fenced example — act as a stamp, so a post could claim `verified: 9999-99-99` in prose and
  // sort ahead of every real git date forever. The stamp is metadata; read it as metadata.
  const fm = src.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const stamp = fm?.[1].match(/^verified:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
  if (!stamp) {
    // A post that WAS stamped and lost its stamp is a regression, not a backlog item —
    // otherwise the cheapest way to silence a stale failure is to delete the stamp, which
    // converts a blocking error into a passing "unverified". Membership is recorded so
    // removal is loud; arrival still just shrinks the backlog.
    if (STAMPED.has(file)) {
      invalid.push([file, '(none)', 'previously stamped — the stamp was REMOVED, which would silently downgrade a stale post to an unverified one']);
    } else {
      unverified.push([file, [...named]]);
    }
    continue;
  }
  // The shape check alone is not enough: `9999-99-99` matches it, is not a date, and sorts
  // after every real git date — so it would suppress this gate on that post permanently. A
  // FUTURE date does the same thing more plausibly. Both are rejected as invalid rather than
  // trusted, because the whole mechanism rests on the stamp meaning "somebody looked, then".
  const asDate = new Date(`${stamp}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);
  if (Number.isNaN(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== stamp) {
    invalid.push([file, stamp, 'not a real calendar date']);
    continue;
  }
  if (stamp > today) {
    invalid.push([file, stamp, `in the future (today is ${today})`]);
    continue;
  }
  // Symmetric with the removal check. A post stamped WITHOUT being added to STAMPED gets no
  // protection: delete its stamp later and it silently reverts to a passing "unverified"
  // entry, which is the escape hatch STAMPED exists to close. Registering is one line and is
  // the same deliberate act as earning the stamp.
  if (!STAMPED.has(file)) {
    invalid.push([file, stamp, 'stamped but not listed in STAMPED — add it there so removing the stamp cannot silently downgrade this post']);
    continue;
  }

  const moved = [];
  for (const p of named) {
    const when = lastChanged(`packs/${p}`);
    // A null here means git could not answer — a broken invocation, not "the pack never
    // changed". Treating the two alike made an unusable git report every stamped post as
    // current and exit 0, which is the failure mode this gate is supposed to be immune to.
    if (when === null) {
      unreadable.push(`${file} → packs/${p}`);
      continue;
    }
    if (when > stamp) moved.push(`${p} (${when})`);
  }
  if (moved.length) stale.push([file, stamp, moved]);
  else ok++;
}

for (const [file, stamp, moved] of stale) {
  console.error(`  ✗ blog/${file}: verified ${stamp}, but since then: ${moved.join(', ')}`);
}
for (const [file, named] of unverified) {
  console.error(`  ? blog/${file}: no \`verified:\` stamp (documents ${named.join(', ')})`);
}

for (const [file, stamp, why] of invalid) {
  console.error(`  ✗ blog/${file}: \`verified: ${stamp}\` is ${why} — a stamp that cannot be earned suppresses this gate forever`);
}
for (const u of unreadable) {
  console.error(`  ! ${u}: git could not report when this pack last changed`);
}

console.log(
  `${ok} post(s) current · ${stale.length} stale · ${unverified.length} unstamped ` +
    `(of ${ok + stale.length + unverified.length} pack-documenting posts)`,
);

/**
 * --check fails on STALE only, never on unstamped.
 *
 * Stale is a regression: someone earned a stamp, then the pack moved out from under it. That
 * should stop a build.
 *
 * Unstamped is a backlog. Failing on it would mean either blocking every build until all
 * eleven posts are re-read, or — far more likely — stamping them in bulk to get green, which
 * manufactures exactly the false assurance the stamp exists to prevent. So it stays loud and
 * non-blocking, and shrinks as posts are genuinely verified.
 */
if (CHECK && (stale.length || unreadable.length || invalid.length)) {
  console.error(
    `\nRe-read the post against the pack, fix what moved, then bump \`verified:\` to today. ` +
      `Bump it only after actually checking — a stamp nobody earned is worse than no stamp.`,
  );
  process.exit(1);
}
