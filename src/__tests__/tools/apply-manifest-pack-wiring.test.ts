// #1568 — the service accepting `pack` is useless if the TOOL never offers it.
//
// The schema is a separate file from the resolver, and adding an input there is the kind of
// one-liner that can be dropped in a refactor with every service test still green: an agent
// simply never learns the durable form exists and keeps passing the path that expires.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../tools/manifest.ts", import.meta.url), "utf-8");

describe("apply_manifest offers `pack` (#1568)", () => {
  it("declares the input", () => {
    expect(SRC).toMatch(/\bpack:\s*z\s*\n?\s*\.string\(\)/);
    expect(SRC).toMatch(/\.optional\(\)/);
  });

  it("its description tells the agent WHY to prefer it", () => {
    // The whole failure is an agent reusing a captured manifest_path. A description that
    // merely says "a pack name" gives it no reason to change, so the reason is the payload.
    const at = SRC.indexOf("pack: z");
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 900);
    expect(block).toMatch(/list_packs/);
    expect(block).toMatch(/npx/i);
    expect(block).toMatch(/prefer/i);
  });

  it("the exactly-one-of rule names all three inputs", () => {
    // `path`'s own description still said "one of `manifest` or `path`", which contradicts
    // the runtime rule and would read as `pack` being additive rather than exclusive.
    const at = SRC.indexOf("path: z");
    const block = SRC.slice(at, at + 600);
    expect(block).toMatch(/`manifest`, `path`, or `pack`/);
  });
});
