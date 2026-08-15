// panel#890 — a POPULATED ComfyUI-Manager catalogue proves nothing about its age.
//
// Measured on a network that genuinely blocks the registry: Manager raises
// InvalidChannel, logs "Cannot connect to comfyregistry", and then answers with
// HTTP 200, 1,570,773 bytes, 5583 packs — out of the extension-node-map.json
// bundled in its own package. A full list of unknown age, indistinguishable from
// a current one.
//
// #1136's two caveats both key on an OBSERVED failure (empty list, caught
// exception), so neither fires on a bundled fallback and `unresolved` went out
// bare — reading as "these packs do not exist" in the very case Manager works
// hardest to produce.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGER_CATALOGUE_CURRENCY_CAVEAT,
  managerCatalogueCurrencyUnverified,
} from "../../services/manager-catalogue-currency.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Blank out string/template/comment CONTENT, preserving length and therefore offsets,
 *  so a brace scan sees only syntax. Deliberately small: it is a test fixture, not a
 *  parser, and it only has to be right about braces in this one file. */
function maskLiterals(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      blank(i, nl === -1 ? src.length : nl);
      i = nl === -1 ? src.length : nl;
    } else if (c === "/" && next === "*") {
      const endC = src.indexOf("*/", i + 2);
      const stop = endC === -1 ? src.length : endC + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === c) break;
        else j++;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}


describe("#890 when the caveat attaches", () => {
  it("attaches when packs are unresolved and nothing stronger applies", () => {
    // The reported case: a healthy-LOOKING catalogue answered, and some class_types
    // did not resolve. Nothing observed a failure, which is exactly the problem.
    expect(managerCatalogueCurrencyUnverified({ unresolvedCount: 3 })).toBe(true);
  });

  it("does NOT attach when nothing is unresolved", () => {
    // Gated on there being something to mislead about — the same rule the
    // catalogue_unavailable gate follows, and the contract its docblock states.
    expect(managerCatalogueCurrencyUnverified({ unresolvedCount: 0 })).toBe(false);
  });

  it("yields to the STRONGER caveats rather than doubling up", () => {
    // catalogue_unavailable and mappings_unavailable report an OBSERVED failure;
    // this reports the absence of evidence either way. Emitting both buries the
    // observed fact under the generic one and reads as two separate problems.
    expect(
      managerCatalogueCurrencyUnverified({ unresolvedCount: 3, catalogueUnavailable: "empty" }),
    ).toBe(false);
    expect(
      managerCatalogueCurrencyUnverified({ unresolvedCount: 3, mappingsUnavailable: "threw" }),
    ).toBe(false);
  });
});

describe("#890 what the caveat says", () => {
  it("does NOT claim the catalogue is stale", () => {
    // The reporter named this trap explicitly: a staleness claim inferred from
    // something the panel cannot observe would repeat the fault the issue is about.
    // Manager does not report which source answered, so this may only say that the
    // age is unknown — never that it is old.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).not.toMatch(/\bis (stale|out of date|old)\b/i);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).not.toMatch(/months out of date/i);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/nothing here can date it/i);
  });

  it("refuses the 'does not exist' reading outright", () => {
    // Case-insensitive: a control mutation lowercasing "NOT" killed the strict form,
    // which punishes rewording rather than protecting the claim. The property is that
    // the "does not exist" reading is refused, not how it is capitalised.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/not proof these do not exist/i);
  });

  it("names WHY a populated list is not evidence of currency", () => {
    // The mechanism is the whole point — without it this reads as generic hedging,
    // and a reader has no reason to believe a 5583-entry answer could be wrong.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/bundled in its own package/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/does not report which source/);
  });

  it("names an independent check WITHOUT overclaiming what it proves", () => {
    // A caveat with no next step is just doubt, so it names one: search_custom_nodes
    // queries api.comfy.org directly rather than through Manager.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/search_custom_nodes action:"search"/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/query:"/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/api\.comfy\.org directly/);

    // codex round 7, P1 — and the subtler version of the trap the reporter named.
    // `unresolved` holds node CLASS TYPES, not pack ids, and the registry indexes
    // PACKS. An earlier version told the reader to look the entries up and treat a hit
    // as proof the catalogue was behind; neither half held. So the caveat says what the
    // entries ARE, and offers the hit as a reason to update rather than a verdict.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/CLASS TYPES, not[\s\S]*pack ids/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/SUGGESTS the catalogue is behind/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/does not prove it/);
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/missing for indexing reasons/);
    // The other direction is not evidence either, and saying it was would be the same
    // overclaim pointed backwards.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/finding nothing settles nothing/);
    // Still actionable: the one thing worth doing is named.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT).toMatch(/updating\s+ComfyUI-Manager/);
  });

  it("stays short enough to be read", () => {
    // It attaches to every miss, including the many that are ordinary, so a paragraph
    // here becomes noise that gets skipped and then it protects nobody.
    //
    // Raised from 700 after codex round 7: saying what the entries ARE (class types,
    // not pack ids) and that a registry hit SUGGESTS rather than proves cost about 150
    // characters. A shorter caveat that overclaims is worse than a longer one that
    // does not — brevity is a means here, not the point.
    expect(MANAGER_CATALOGUE_CURRENCY_CAVEAT.length).toBeLessThan(950);
  });
});

describe("#890 WIRING: it reaches both results and both renderers", () => {
  const deps = readFileSync(join(HERE, "../../services/workflow-deps.ts"), "utf8");
  const skills = readFileSync(join(HERE, "../../tools/skills-access.ts"), "utf8");

  it("both result shapes can carry it", () => {
    // WorkflowDepsAnalysis (the mappings path) and InstallDepsResult (the getlist
    // path) are separate shapes and both render `unresolved`.
    expect((deps.match(/catalogue_currency_unverified\?: string;/g) ?? []).length).toBe(2);
  });

  it("EVERY return that emits `unresolved` also carries a caveat", () => {
    // Counting setters was not enough, and codex round 2 proved it: an EARLY RETURN in
    // installWorkflowDependencies (taken when nothing is missing) emitted `unresolved`
    // bare. The caveat existed, was set in two places, and still never reached that
    // path — and nothing is installed on that branch, which makes it read as the MOST
    // settled answer of the three.
    //
    // The window is bounded to the ENCLOSING OBJECT by brace depth, not by a character
    // count (round 3): a fixed forward window was correct only at today's distances, so
    // an edit moving two returns closer would let one return's caveat satisfy another's
    // check and this test would pass while `unresolved` went out bare.
    //
    // Braces inside STRINGS, TEMPLATE LITERALS and COMMENTS are masked first (round 5).
    // The messages in this file are long and full of prose; a future property like
    // `note: "{"` would otherwise stop the walk from closing and let it run on into a
    // later return that does carry a caveat — the same vacuous pass, reintroduced by
    // the fix for it. Indices are preserved so offsets still line up with the source.
    const masked = maskLiterals(deps);

    const FIELD = new RegExp(String.raw`\n\s+unresolved: `, "g");
    const sites = [...masked.matchAll(FIELD)]
      .map((m) => m.index ?? 0)
      .filter((i) => !/const\s+$/.test(masked.slice(Math.max(0, i - 24), i + 1)));
    expect(sites.length).toBeGreaterThanOrEqual(3); // analysis + install + early return

    for (const i of sites) {
      let depth = 1; // already inside the object holding this field
      let close = -1;
      for (let j = i; j < masked.length; j++) {
        const c = masked[j];
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          close = j;
          break;
        }
      }
      // A walk that never closed is not a bound, and would silently widen the window.
      expect(close, `unterminated object at ${deps.slice(i, i + 60)}`).toBeGreaterThan(i);
      // Matched on the MASKED slice too (codex round 6). Searching the raw source let a
      // COMMENT mentioning one of these names satisfy the check — and this file is full
      // of comments that name them, so a bare return sitting under one would have passed.
      // Masking leaves only code, so the match proves a field, not a mention.
      const object = masked.slice(i, close);
      expect(object, deps.slice(i, i + 60)).toMatch(
        /catalogue_currency_unverified|mappings_unavailable|catalogue_unavailable/,
      );
    }
  });

  it("BOTH result renderers surface the currency caveat", () => {
    // This used to assert parity with the stronger caveats — one currency render per
    // stronger render. That premise died the moment `mappings_unavailable` gained a
    // second render site (codex round 4), and the assertion started failing for a
    // reason that was not a defect. The property that actually matters is coverage:
    // there are two result shapes, each with a renderer, and BOTH must surface it —
    // a renderer that forgets it leaves `unresolved` reading as "does not exist" on
    // whichever path it serves.
    expect((skills.match(/result\.catalogue_currency_unverified\)/g) ?? []).length).toBe(2);
    // And the stronger caveats must still be rendered wherever they can be set, or
    // this one silently becomes the only disclosure a reader ever sees.
    expect(skills).toMatch(/result\.mappings_unavailable\)/);
    expect(skills).toMatch(/result\.catalogue_unavailable\)/);
  });
});

describe("#890 yielding to a caveat that never arrives", () => {
  const deps = readFileSync(join(HERE, "../../services/workflow-deps.ts"), "utf8");
  const skills = readFileSync(join(HERE, "../../tools/skills-access.ts"), "utf8");

  it("the install result can CARRY the stronger mappings caveat", () => {
    // codex round 4, P1. `mappings_unavailable` had nowhere to live on
    // InstallDepsResult, so an install whose MAPPINGS lookup threw emitted `unresolved`
    // with NO caveat at all: the strong one could not be represented, and the currency
    // caveat correctly yields to it. Yielding to something that never arrives is the
    // worst of both — it suppresses the weaker disclosure and loses the stronger one,
    // leaving a bare list in the case we know the MOST about.
    const install = deps.slice(deps.indexOf("export interface InstallDepsResult"));
    const shape = install.slice(0, install.indexOf("\n}"));
    expect(shape).toMatch(/mappings_unavailable\?: string;/);
  });

  it("both install returns propagate it from the analysis", () => {
    // The analysis is where the mappings lookup actually happened, so it is carried
    // over rather than recomputed — and BOTH returns need it: the early
    // no-missing-packs one and the full install one.
    expect(
      (deps.match(/mappings_unavailable: analysis\.mappings_unavailable/g) ?? []).length,
    ).toBe(2);
  });

  it("the currency caveat yields only when the stronger one will REACH the reader", () => {
    // The gate is passed `analysis.mappings_unavailable` on the install path now. If it
    // were not, the currency caveat would fire alongside a stronger caveat that is also
    // present — two disclosures for one fact.
    expect(deps).toMatch(/mappingsUnavailable: analysis\.mappings_unavailable/);
  });

  it("the install renderer surfaces it", () => {
    // A field that is set and never rendered is the same hole one layer down.
    expect((skills.match(/result\.mappings_unavailable\)/g) ?? []).length).toBe(2);
  });
});
