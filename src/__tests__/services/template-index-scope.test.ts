// #1454 — an incomplete template list read as a complete one.
//
// `list_templates` consults exactly one source: the connected ComfyUI's
// `/api/workflow_templates`. That reports what packs REGISTER, and a pack can ship
// example workflows on disk without registering them — the reporter had
// `ComfyUI-LTXVideo/example_workflows/2.5/*.json` present while the pack did not
// appear at all, and fell back to searching the filesystem by hand.
//
// Nothing in the reply said that was possible. `source_count: 4` reads as "there are
// four", so a caller concludes the workflow does not exist rather than that this
// index cannot see it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMPLATE_INDEX_SCOPE_NOTE,
  templateIndexScopeNote,
} from "../../services/template-index-scope.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#1454 what the note says", () => {
  it("names the authority the index actually reflects", () => {
    // Without the mechanism this is just hedging, and a reader has no reason to
    // believe a 53-template answer could be missing their pack.
    // Case-insensitive: a control mutation lowercasing the word killed the strict
    // form, which punishes rewording rather than protecting the claim.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/registers/i);
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/\/api\/workflow_templates/);
  });

  it("refuses the 'absent means it has none' reading outright", () => {
    // The exact wrong conclusion the reporter was pushed toward.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/without registering them/i);
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/not evidence it has no templates/i);
  });

  it("names WHERE the invisible ones live, and how to use one", () => {
    // A caveat with no next step is just doubt. This is the search the reporter had
    // to work out unaided.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/custom_nodes\/<pack>\/example_workflows/);
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/by path/);
  });

  it("does NOT claim to have scanned the disk", () => {
    // It has not. Implying otherwise would be a worse defect than the one being
    // fixed — a caller would treat a still-incomplete list as exhaustive.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).not.toMatch(/scanned|searched the disk|includes on-disk/i);
  });

  it("stays short enough to be read", () => {
    // It rides on every successful listing; a paragraph is skipped, and a skipped
    // caveat protects nobody.
    expect(TEMPLATE_INDEX_SCOPE_NOTE.length).toBeLessThan(500);
  });
});

describe("#1454 when it attaches", () => {
  it("attaches to EVERY listing, not only an empty one", () => {
    // Gating on emptiness would hide it in exactly the reported case: 4 sources,
    // 53 templates, and the one they wanted absent. The gap is not "the list is
    // empty", it is "the list is one authority's view".
    expect(templateIndexScopeNote()).toBe(TEMPLATE_INDEX_SCOPE_NOTE);
    expect(templateIndexScopeNote().length).toBeGreaterThan(0);
  });
});

describe("#1454 WIRING: the reply carries it", () => {
  const src = readFileSync(join(HERE, "../../tools/skills-access.ts"), "utf8");

  it("list_templates emits index_scope alongside the counts", () => {
    // The behavioural tests cannot see the reply shape, and a note nothing attaches
    // is the defect this repo keeps paying for.
    expect(src).toMatch(
      /import \{ templateIndexScopeNote \} from "\.\.\/services\/template-index-scope\.js";/,
    );
    const at = src.indexOf("source_count: groups.length");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).toMatch(/index_scope: templateIndexScopeNote\(\)/);
  });

  it("the counts are still reported — the note adds, it does not replace", () => {
    const at = src.indexOf("source_count: groups.length");
    const block = src.slice(at, at + 600);
    expect(block).toMatch(/template_count: total/);
    expect(block).toMatch(/templates: index/);
  });
});
