#!/usr/bin/env node
/**
 * A blog post may not name a model file its pack does not ship.
 *
 *   node scripts/check-blog-packs.mjs
 *
 * ## Why
 *
 * `wan-2.2-comfyui` told readers the `wan-longer-videos` pack ships **Q4_K_S** GGUFs and fits
 * "under 12 GB". The pack pins **Q8_0**: manifest.yaml downloads the four `-Q8_0.gguf` experts,
 * both installer scripts fetch them, and workflow.json loads them by that exact filename. A
 * reader with a 12 GB card was told the pack fits. It OOMs.
 *
 * The post was right when it was written and the pack moved underneath it. Nothing could notice,
 * because the only copy of "what this pack ships" that a test can read lives in packs/, and the
 * blog restates it in prose.
 *
 * ## What this checks, and why only this
 *
 * Only filenames in MARKDOWN TABLE ROWS and inside FENCED CODE BLOCKS. Those are the two places
 * a post says "here is what you get" — a file table, an installer transcript. Prose is
 * deliberately out of scope, because prose is where the legitimate alternatives live:
 *
 *   "swap the four `Wan2.2-*-Q8_0.gguf` files for the `-Q4_K_S` builds"
 *
 * That sentence names a file the pack does not ship, and it is correct to do so. Gating prose
 * would flag it, the flag would be wrong, and the fix would be to delete true, useful advice. A
 * gate whose failure mode is "make the docs worse" is worse than no gate.
 *
 * Wildcards (`Wan2.2-*-Q8_0.gguf`) are skipped: they name a family, not a file.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOG = path.join(ROOT, 'docs', 'blog');
const PACKS = path.join(ROOT, 'packs');

const MODEL_EXT = /\.(gguf|safetensors|pth|ckpt|pt|onnx)$/i;
const FILENAME = /[A-Za-z0-9][A-Za-z0-9._-]*\.(?:gguf|safetensors|pth|ckpt|pt|onnx)/g;

/**
 * Installer scripts, checked the same way and for the same reason.
 *
 * `wan-2.2-comfyui` and `wan-transparent-comfyui` both told readers to run
 * `WAN2_2-ULTRA-MODELS-NODES_INSTALL.bat`. No such file has ever existed in this repo; the
 * packs ship `install-windows.bat` / `install-runpod.sh`. A reader following the quickstart
 * hit a filename that isn't there.
 *
 * Scoped to fenced code only — NOT tables, NOT prose. A fence is where a post says "type
 * this", so the file must exist. Prose is where a post can legitimately discuss a
 * third-party script it does not ship, which is exactly what the SageAttention helper in
 * `wan-animate-comfyui` turned out to be.
 */
const SCRIPT = /[A-Za-z0-9][A-Za-z0-9._-]*\.(?:bat|sh|ps1)/g;

/** Every pack a post could be talking about, by name -> the text that proves what it ships. */
function loadPacks() {
  const packs = new Map();
  if (!fs.existsSync(PACKS)) return packs;
  for (const dir of fs.readdirSync(PACKS)) {
    const full = path.join(PACKS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    let blob = '';
    for (const f of fs.readdirSync(full)) {
      // manifest = what gets downloaded; workflow = what gets loaded; install* = the script path.
      if (/^(pack\.yaml|manifest\.yaml|workflow\.json|install-.*)$/.test(f)) {
        blob += fs.readFileSync(path.join(full, f), 'utf8') + '\n';
      }
    }
    packs.set(dir, blob);
  }
  return packs;
}

/**
 * Table rows and fenced code — the "here is what you get" surfaces.
 * Fences are matched indent-tolerantly: a fence indented inside a list item is still a fence,
 * and anchoring to column 0 silently halves what a checker sees.
 */
function claimLines(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  // Markdown fence rules, not "any same-character marker". A fence closes only on a line of
  // the SAME character, at least as long as the opener, with nothing after it but whitespace.
  // The looser version let a ```bash opener inside a ```` block close it early, which ends
  // scanning and hides every filename claim after that point.
  let fence = null; // { char, len }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === '') {
        fence = null;
        continue;
      }
      out.push([i + 1, line, 'fence']);
      continue;
    }
    if (m) {
      fence = { char: m[1][0], len: m[1].length };
      continue;
    }
    if (/^\s*\|.*\|/.test(line) && !/^\s*\|[\s|:-]*\|?\s*$/.test(line))
      out.push([i + 1, line, 'table']);
  }
  return out;
}

const packs = loadPacks();
if (!packs.size) {
  console.error('no packs/ directory — cannot verify blog model claims');
  process.exit(1);
}

let failures = 0;
let checked = 0;
for (const file of fs.readdirSync(BLOG).filter((f) => f.endsWith('.mdx'))) {
  const src = fs.readFileSync(path.join(BLOG, file), 'utf8');

  // Which packs does this post document? Only these are consulted, so a post naming a file that
  // some OTHER pack happens to ship is still caught.
  const named = new Set();
  // A `packs/<name>` reference to a pack that does NOT exist is itself a defect, and the more
  // likely one over time: packs get renamed and deleted, and the post that documents one is
  // exactly what goes stale. Silently dropping unknown names (the original behaviour) meant a
  // post pointing at a deleted pack sailed through — and if any OTHER pack in the post still
  // resolved, its filename claims were checked against the wrong manifest.
  const missing = new Set();
  for (const m of src.matchAll(/packs\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
    if (packs.has(m[1])) named.add(m[1]);
    else missing.add(m[1]);
  }
  for (const m of src.matchAll(/`([a-z0-9][a-z0-9.-]*[a-z0-9])`\s+pack/gi)) {
    if (packs.has(m[1])) named.add(m[1]);
    // NOT collected as missing: `foo` pack is a loose prose pattern that matches things which
    // were never pack directories. Only the explicit packs/<name> path is treated as a promise.
  }
  for (const m of missing) {
    failures++;
    console.error(`  ✗ blog/${file}: references packs/${m}, which does not exist`);
  }
  if (!named.size) continue;

  const haystack = [...named].map((n) => packs.get(n)).join('\n');
  // Scripts must EXIST as files in a pack the post documents — the pack text is irrelevant.
  // EXACT filenames, not lowercased. Case-folding meant `INSTALL-RUNPOD.SH` matched
  // `install-runpod.sh` and passed — while the command as printed fails on any
  // case-sensitive filesystem, which is where RunPod and CI run.
  const shipped = new Set();
  for (const n of named) {
    for (const f of fs.readdirSync(path.join(PACKS, n))) shipped.add(f);
  }

  const seen = new Set();
  for (const [lineNo, line, kind] of claimLines(src)) {
    if (kind === 'fence') {
      // A line that FETCHES a script is not claiming the pack ships it —
      // `curl -fsSL https://vendor.example/install.sh | sh` downloads it, and demanding that
      // filename exist in packs/ would fail a correct command. Same for anything under a
      // non-pack directory. The rule only means "a file the reader is told to run FROM the
      // pack", so it applies to bare filenames and packs/… paths only.
      const fetchesRemotely = /\b(?:https?|ftp):\/\//i.test(line);
      for (const raw of fetchesRemotely ? [] : line.match(SCRIPT) ?? []) {
        const at = line.indexOf(raw);
        const prefix = line.slice(0, at);
        // `foo/bar/install.sh` where foo/bar is not a pack path — someone else's tree.
        //
        // `./` and `.\` are NOT that: they are how a quickstart invokes a script in the
        // current directory, which after a `cd packs/<pack>` is exactly the file this rule
        // should check. Treating them as a foreign directory skipped them — a false NEGATIVE,
        // the dangerous direction, introduced by the previous round's fix for remote URLs.
        const dir = prefix.match(/([A-Za-z0-9._-]*[\\/])$/)?.[1];
        const isCurrentDir = dir === './' || dir === '.\\';
        const isPackPath = /packs[\\/][A-Za-z0-9._-]+[\\/]$/.test(prefix);
        if (dir && !isCurrentDir && !isPackPath) continue;
        const key = `s:${raw}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checked++;
        if (!shipped.has(raw)) {
          failures++;
          console.error(
            `  ✗ blog/${file}:${lineNo}: tells the reader to run "${raw}", but no pack it ` +
              `documents (${[...named].join(', ')}) ships that file`,
          );
        }
      }
    }
    // Markdown EMPHASIS is stripped before extraction rather than treated as a wildcard.
    // Round 1 replaced a 40-char context window with an adjacency test, which fixed
    // `| **Download** | Missing.gguf |` but broke `**Missing.gguf**` — a literal claim wrapped
    // in bold, now read as a glob and skipped. Removing emphasis first means a `*` still
    // touching the name is a real wildcard.
    const bare = line.replace(/\*\*([^*]*)\*\*/g, '$1').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
    // matchAll + m.index, NOT line.indexOf(raw): indexOf always returns the FIRST occurrence,
    // so on `| -Q8_0.gguf | Q8_0.gguf |` the second, legitimate claim inherited the first
    // one's suffix-fragment classification and both were skipped.
    for (const m of bare.matchAll(FILENAME)) {
      const raw = m[0];
      if (!MODEL_EXT.test(raw)) continue;
      const at = m.index;
      const before = bare.slice(Math.max(0, at - 1), at);
      const after = bare.slice(at + raw.length, at + raw.length + 1);
      // A glob names a family, not a file — the post describes a set, not a promise.
      if (/[*{}]/.test(before) || /[*{}]/.test(after)) continue;
      // A leading filename char means we matched the TAIL of a longer name. The posts write
      // `-Q8_0.gguf` and `-LowNoise-Q8_0.gguf` as deliberate suffix shorthand ("the LowNoise
      // variant"), and the extractor drops the leading hyphen and yields a fragment. Checking
      // that fragment against the manifest is meaningless — under the old substring match it
      // passed by accident, and under whole-token matching it would fail by accident.
      if (/[A-Za-z0-9._-]/.test(before)) continue;
      const key = `${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      // Whole-token match, not `includes`. A substring test passes a filename the pack does
      // NOT ship whenever a longer one contains it: a manifest with `my-model.gguf` would
      // satisfy a post claiming `model.gguf`. BOTH boundaries are required — with only a left
      // boundary, `foo.gguf` was still satisfied by `foo.gguf.part` or `foo.gguf2`.
      const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const shipsFile = new RegExp(`(^|[^A-Za-z0-9._-])${esc}($|[^A-Za-z0-9._-])`).test(haystack);
      if (!shipsFile) {
        failures++;
        console.error(
          `  ✗ blog/${file}:${lineNo}: names "${raw}", but no pack it documents ` +
            `(${[...named].join(', ')}) ships that file`,
        );
      }
    }
  }
}

console.log(`checked ${checked} model/script filename claim(s) against packs/`);
if (failures) {
  console.error(
    `\n${failures} claim(s) do not match the pack. Either the post is stale — check what ` +
      `packs/<name>/manifest.yaml actually downloads — or the filename is a typo. If the post ` +
      `is deliberately naming an ALTERNATIVE file, say so in prose rather than in a table.`,
  );
  process.exit(1);
}
console.log('blog pack claims OK');
