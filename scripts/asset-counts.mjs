#!/usr/bin/env node
/**
 * Count the project's advertised assets from their SOURCE OF TRUTH, and
 * optionally assert the README matches.
 *
 * Why this exists: the README claimed "108 MCP tools" for nearly a month while
 * the real number climbed past 160, and the first hand-correction still landed
 * one short because it was derived by grepping `server.tool(` instead of asking
 * the registry. Numbers written by hand drift silently — nothing fails, the
 * claim just quietly stops being true. This makes the claim testable.
 *
 *   node scripts/asset-counts.mjs           # print the counts
 *   node scripts/asset-counts.mjs --json    # machine-readable
 *   node scripts/asset-counts.mjs --check   # exit 1 if README disagrees
 *
 * --check requires a build (it imports dist/), which CI already does.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Refuse to report counts from a stale build.
 *
 * This script asks the REGISTRY rather than grepping, which is right — but it asks
 * `dist/`, so what it actually reports is the surface as of the last `npm run
 * build`. A stale dist therefore produces a confidently wrong number, and then
 * that number gets written into prose as if it were verified.
 *
 * This is not hypothetical: docs/local-vs-comfy-cloud.mdx claimed "182 MCP tools"
 * against a real count of 181, and 182 is exactly what this machine's stale dist
 * reported. The guard closes the loop on the bug the count checks were added for.
 *
 * CI always builds first, so this only ever fires locally — where it converts a
 * silent wrong answer into an instruction.
 */
function newestMtime(dir, exts) {
  const p = join(root, dir);
  if (!existsSync(p)) return undefined;
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (exts.some((x) => e.name.endsWith(x))) {
        const m = statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(p);
  return newest || undefined;
}

/** The built modules this script actually imports. */
const IMPORTED = ["dist/tools/index.js", "dist/orchestrator/panel-tools.js"];

function assertFreshBuild() {
  const srcNewest = newestMtime("src", [".ts"]);

  // Compared against the modules this script IMPORTS, not against the newest file
  // anywhere in dist/. The latter let a stale dist/tools/index.js pass whenever any
  // unrelated output — dist/utils/image.js, say — happened to be written later, and
  // the script then imported the stale registry and reported the wrong count with
  // full confidence. That is the exact failure this guard exists to prevent.
  //
  // Still a heuristic, not a dependency graph: a stale transitive import behind a
  // fresh entry point is not detected. CI's full build is the real guarantee; this
  // only has to stop a developer reading numbers off a half-built tree.
  const missing = IMPORTED.filter((f) => !existsSync(join(root, f)));
  if (missing.length > 0) {
    console.error(
      `dist/ is missing ${missing.join(", ")} — run \`npm run build\` first ` +
        `(this script reads the built registry).`,
    );
    process.exit(2);
  }
  if (srcNewest === undefined) return;

  const stale = IMPORTED.filter((f) => statSync(join(root, f)).mtimeMs < srcNewest);
  if (stale.length > 0) {
    console.error(
      `dist/ is STALE — src/ is newer than ${stale.join(", ")}, so every count below ` +
        `would describe an older tool surface.\nRun \`npm run build\` and try again.`,
    );
    process.exit(2);
  }
}
const dirsContaining = (dir, file) => {
  const p = join(root, dir);
  if (!existsSync(p)) return 0;
  return readdirSync(p, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && existsSync(join(p, e.name, file)),
  ).length;
};
const filesMatching = (dir, ext) => {
  const p = join(root, dir);
  if (!existsSync(p)) return 0;
  return readdirSync(p).filter((f) => f.endsWith(ext)).length;
};

async function counts() {
  assertFreshBuild();
  // Tools come from the REGISTRY, not a grep — that is the whole point. A tool
  // registered conditionally, or in a file the pattern missed, still counts.
  // pathToFileURL: on Windows a bare absolute path ("C:\…") is rejected by the
  // ESM loader as an unknown URL scheme.
  const imp = (rel) => import(pathToFileURL(join(root, rel)).href);
  const { collectToolCatalog } = await imp("dist/tools/index.js");
  const { buildPanelToolDefs } = await imp("dist/orchestrator/panel-tools.js");
  const catalog = await collectToolCatalog();
  const mcpTools = catalog.tools instanceof Map ? catalog.tools.size : Object.keys(catalog.tools).length;
  const panelTools = buildPanelToolDefs().length;

  // Pack families: `packs/` holds one directory per VARIANT (anima-txt2img,
  // anima-inpaint…), which is why a raw directory count overstates what a user
  // would call a pack. Report both rather than pick one and be subtly wrong.
  const packDirs = dirsContaining("packs", "pack.yaml");
  const families = new Set();
  const packsRoot = join(root, "packs");
  if (existsSync(packsRoot)) {
    for (const e of readdirSync(packsRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const y = join(packsRoot, e.name, "pack.yaml");
      if (!existsSync(y)) continue;
      const m = readFileSync(y, "utf8").match(/^family:\s*(.+)$/m);
      if (m) families.add(m[1].trim());
    }
  }

  let hooks = 0;
  const hooksFile = join(root, "plugin/hooks/hooks.json");
  if (existsSync(hooksFile)) {
    const h = JSON.parse(readFileSync(hooksFile, "utf8"));
    const events = h.hooks ?? h;
    for (const arr of Object.values(events)) {
      if (!Array.isArray(arr)) continue;
      hooks += arr.reduce((s, x) => s + (Array.isArray(x.hooks) ? x.hooks.length : 1), 0);
    }
  }

  return {
    mcp_tools: mcpTools,
    panel_tools: panelTools,
    total_tool_surface: mcpTools + panelTools,
    skills: dirsContaining("plugin/skills", "SKILL.md"),
    packs: packDirs,
    pack_families: families.size,
    slash_commands: filesMatching("plugin/commands", ".md"),
    agents: filesMatching("plugin/agents", ".md"),
    hooks,
  };
}

/** Claims embedded in prose, and how to read each one back out. */
const CLAIMS = [
  { file: "README.md", key: "mcp_tools", re: /\*\*(\d+) MCP tools\*\*/ },
  { file: "README.md", key: "mcp_tools", re: /^(\d+) tools across/m },
  { file: "README.md", key: "skills", re: /\*\*(\d+) AI skills\*\*/ },
  { file: "README.md", key: "packs", re: /\*\*(\d+) installer packs\*\*/ },
  { file: "README.md", key: "slash_commands", re: /\*\*(\d+) slash commands\*\*/ },
  { file: "README.md", key: "agents", re: /\*\*(\d+) autonomous agents\*\*/ },
  { file: "README.md", key: "hooks", re: /\*\*(\d+) hooks\*\*/ },
  { file: "docs/plugin.mdx", key: "mcp_tools", re: /the (\d+) MCP tools/ },
  // Every claim below was UNGUARDED and two had already drifted: this file said
  // "182 MCP tools" (matching a stale local dist build, not the 181 in the
  // registry) and plugin.mdx said "4 hooks" while the README correctly said 3.
  // Phase 5 changes the tool count itself, so an unguarded count is a doc that
  // silently becomes wrong at exactly the moment accuracy matters most.
  { file: "docs/plugin.mdx", key: "skills", re: /(\d+) AI skills, \d+ slash commands/ },
  { file: "docs/plugin.mdx", key: "slash_commands", re: /\d+ AI skills, (\d+) slash commands/ },
  { file: "docs/plugin.mdx", key: "agents", re: /(\d+) autonomous agents, and \d+ hooks/ },
  { file: "docs/plugin.mdx", key: "hooks", re: /\d+ autonomous agents, and (\d+) hooks/ },
  { file: "docs/plugin.mdx", key: "skills", re: /^## (\d+) AI skills/m },
  { file: "docs/plugin.mdx", key: "slash_commands", re: /^## (\d+) slash commands/m },
  { file: "docs/plugin.mdx", key: "agents", re: /^## (\d+) autonomous agents/m },
  { file: "docs/local-vs-comfy-cloud.mdx", key: "mcp_tools", re: /(\d+) MCP tools/ },
  { file: "docs/local-vs-comfy-cloud.mdx", key: "skills", re: /(\d+) model-specific skills/ },
  { file: "docs/local-llms.mdx", key: "mcp_tools", re: /The full surface is (\d+) tools/ },
  // PROSE counts, not just badges. The badge patterns above were all correct while
  // "35 skills total" sat five lines under a correct "**38 AI skills**" badge in the same
  // file, and docs/index.mdx advertised "80+ tools" against a real 37 — both invisible to
  // this gate because it only matched the bolded forms. A count is a count wherever it is
  // written.
  { file: "README.md", key: "skills", re: /(\d+) skills total/ },
  { file: "docs/index.mdx", key: "mcp_tools", re: /(\d+)\+? tools, auto-documented/ },
  // The blog drifts the same way the README did. local-llms-comfyui said "roughly 200 tools"
  // — five times the real surface — because the consolidation landed and the post didn't move.
  // `\s+`, not literal spaces. A non-match is a FAILURE here ("could not find a claim
  // matching…"), so a routine re-wrap of this hard-wrapped prose — "MCP server exposes\n**37
  // tools**" — would reject factually correct text. The panel row below was already
  // wrap-tolerant; this one was not, which is the kind of inconsistency that only shows up
  // the day someone reflows a paragraph.
  { file: "docs/blog/local-llms-comfyui.mdx", key: "mcp_tools", re: /MCP\s+server\s+exposes\s+\*\*(\d+)\s+tools\*\*/ },
  // The SAME sentence also counts the panel surface, and guarding only its first half left
  // the second half free to drift — it had already been rewritten to "a comparable set",
  // which reads as ~37 against a real 92. Both numbers in a sentence need the same gate.
  // `\s+` on both sides, not a literal space: the sentence is hard-wrapped, and which words
  // land on which line shifts whenever the paragraph is re-flowed. A no-match is a loud
  // failure here, not a silent pass, but a gate that cries at a re-wrap still gets muted.
  { file: "docs/blog/local-llms-comfyui.mdx", key: "panel_tools", re: /the\s+panel\s+adds\s+\*\*(\d+)\*\*\s+`panel_\*`\s+live-canvas\s+tools/ },
];

const c = await counts();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(c, null, 2));
} else if (process.argv.includes("--check")) {
  const bad = [];
  for (const { file, key, re } of CLAIMS) {
    const p = join(root, file);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(re);
    if (!m) {
      bad.push(`${file}: could not find a claim matching ${re} (did the wording change?)`);
      continue;
    }
    if (Number(m[1]) !== c[key]) {
      bad.push(`${file}: claims ${m[1]} for ${key}, actual is ${c[key]}`);
    }
  }
  if (bad.length) {
    console.error("Asset counts in prose disagree with the source of truth:\n");
    for (const b of bad) console.error("  - " + b);
    console.error("\nRun `node scripts/asset-counts.mjs` and update the text.");
    process.exit(1);
  }
  console.log("asset counts match the source of truth");
} else {
  const w = Math.max(...Object.keys(c).map((k) => k.length));
  for (const [k, v] of Object.entries(c)) console.log(`${k.padEnd(w)}  ${v}`);
}
