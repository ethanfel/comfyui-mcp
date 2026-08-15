// #1529 — the orchestrator half: wait out a reconnect refusal instead of handing it back.
//
// `panel_set_widget` is refused while ComfyUI's backend reconnects. The refusal is
// correct — a mutation dispatched then lands on a canvas the reconnect is about to
// rebuild — and it is SAFE TO RETRY, because the panel's gate runs before its
// executor so nothing was applied.
//
// THE FIRST ATTEMPT AT THIS READ THAT FROM THE WORDING AND WAS REVERTED AS A P0.
// Acknowledged panel errors travel as arbitrary `msg.error` text, so any sentence the
// gate writes is one a genuine MID-WRITE failure can also contain — and being wrong
// here does not print a bad message, it RE-ISSUES A MUTATION that already landed.
//
// The panel states it structurally now (panel 0.14.35 / comfyui-mcp-panel#1216), and
// this reads that field and nothing else.
import { describe, expect, it } from "vitest";

import {
  PANEL_REFUSAL_PROP,
  attachPanelRefusal,
  hasOwnField,
  isPreExecutorRefusal,
  readPanelRefusal,
} from "../../services/panel-refusal.js";

const GOOD = {
  code: "backend-reconnecting",
  applied: false,
  stage: "pre-executor",
  retryable: true,
};

describe("readPanelRefusal — every claim is required (#1529)", () => {
  it("accepts a complete pre-executor refusal, for both codes", () => {
    for (const code of ["backend-reconnecting", "post-reconnect-settling"]) {
      expect(readPanelRefusal({ ...GOOD, code })).toEqual({
        code,
        applied: false,
        stage: "pre-executor",
        retryable: true,
      });
    }
  });

  it("REJECTS a refusal missing or contradicting any single claim", () => {
    // This authorises re-issuing a MUTATION. A partial claim is not a claim.
    const mutations: Array<Record<string, unknown>> = [
      { ...GOOD, applied: true },
      { ...GOOD, applied: undefined },
      { ...GOOD, stage: "post-executor" },
      { ...GOOD, stage: undefined },
      { ...GOOD, retryable: false },
      { ...GOOD, retryable: undefined },
      { ...GOOD, code: "something-else" },
      { ...GOOD, code: undefined },
    ];
    for (const m of mutations) {
      expect(readPanelRefusal(m), JSON.stringify(m)).toBeNull();
    }
  });

  it("REJECTS junk instead of coercing it", () => {
    for (const junk of [null, undefined, 0, "", "backend-reconnecting", [], true]) {
      expect(readPanelRefusal(junk), String(junk)).toBeNull();
    }
  });

  it("returns a FRESH object — nothing else on the wire value travels", () => {
    const wire = { ...GOOD, smuggled: { token: "sensitive" }, applied: false };
    const out = readPanelRefusal(wire);
    expect(Object.keys(out ?? {}).sort()).toEqual(["applied", "code", "retryable", "stage"]);
    expect(out).not.toBe(wire);
  });
});

describe("isPreExecutorRefusal — only the panel's own claim (#1529)", () => {
  it("reads a refusal the bridge attached", () => {
    const err = attachPanelRefusal(new Error("[backend-reconnecting] …"), {
      code: "backend-reconnecting",
      applied: false,
      stage: "pre-executor",
      retryable: true,
    });
    expect(isPreExecutorRefusal(err)?.code).toBe("backend-reconnecting");
  });

  it("an ordinary error authorises nothing", () => {
    expect(isPreExecutorRefusal(new Error("node exploded mid-write"))).toBeNull();
    for (const junk of [null, undefined, "x", 42, {}]) {
      expect(isPreExecutorRefusal(junk), String(junk)).toBeNull();
    }
  });

  it("an INHERITED property is refused — own property only", () => {
    // A polluted Error.prototype, or a library that decorates Error, would
    // otherwise let an unrelated mid-write failure authorise a mutation retry.
    Object.defineProperty(Error.prototype, PANEL_REFUSAL_PROP, {
      value: { ...GOOD },
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      const midWrite = new Error("the node was added, then the socket died");
      expect((midWrite as unknown as Record<string, unknown>)[PANEL_REFUSAL_PROP]).toBeTruthy();
      expect(isPreExecutorRefusal(midWrite), "inherited must not authorise a retry").toBeNull();
    } finally {
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_REFUSAL_PROP];
    }
    expect(PANEL_REFUSAL_PROP in Error.prototype).toBe(false);
  });

  it("a TAMPERED attachment is refused — validated on read, not only on attach", () => {
    const err = attachPanelRefusal(new Error("x"), { ...GOOD } as never);
    (err as unknown as Record<string, Record<string, unknown>>)[PANEL_REFUSAL_PROP].applied = true;
    expect(isPreExecutorRefusal(err)).toBeNull();
  });

  it("attaching never collides with Error's own fields", () => {
    const err = attachPanelRefusal(new Error("x"), { ...GOOD } as never);
    expect((err as unknown as { code?: unknown }).code).toBeUndefined();
    expect(err.message).toBe("x");
  });

  it("attaching survives a non-writable prototype property", () => {
    // Assignment would THROW in strict mode here, turning a clear refusal into an
    // unrelated TypeError — the trap the panel side hit (comfyui-mcp-panel#1216).
    Object.defineProperty(Error.prototype, PANEL_REFUSAL_PROP, {
      value: { ...GOOD },
      configurable: true,
      writable: false,
      enumerable: false,
    });
    try {
      const err = attachPanelRefusal(new Error("x"), { ...GOOD } as never);
      expect(isPreExecutorRefusal(err)?.code).toBe("backend-reconnecting");
    } finally {
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_REFUSAL_PROP];
    }
  });
});

// ── WIRING. The lib is useless if the bridge never attaches it or the retry gate
//    never reads it, and both are single lines in large files.

describe("the channel is actually connected (#1529)", () => {
  it("the bridge attaches a validated refusal to the rejected error", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../services/ui-bridge.ts", import.meta.url), "utf-8");
    const at = src.indexOf('new Error(String(msg.error ?? "panel reported an error"))');
    expect(at, "the reply-to-error conversion must still be recognisable").toBeGreaterThan(-1);
    const block = src.slice(at, at + 700);
    expect(block).toMatch(/readPanelRefusal\(/);
    expect(block).toMatch(/refusal \? attachPanelRefusal\(err, refusal\) : err/);
  });

  it("the retry gate keys on the FIELD, and lets a MUTATION through on it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8");
    // The gate must consult the refusal INDEPENDENTLY of isRetrySafeCmd — that is
    // the entire change. `isRetrySafeCmd && …` alone would leave mutations, which
    // are exactly what #1529 is about, still un-retried.
    expect(src).toMatch(/const preExecutorRefusal = isPreExecutorRefusal\(err\);/);
    expect(src).toMatch(
      /preExecutorRefusal \|\|\s*\n\s*\(isRetrySafeCmd\(cmd\) &&/,
      "the refusal must be an OR beside the retry-safe gate, not an AND inside it",
    );
  });

  it("nothing in the orchestrator decides this from the message TEXT", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../orchestrator/panel-tools.ts", import.meta.url), "utf-8");
    const codeOnly = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // The reverted P0 MATCHED these sentences. What must not exist is a matching
    // construct over the refusal's wording — the orchestrator composing that phrase
    // in a message of its own is fine and does happen (the #1027 switch refusal
    // says "was NOT applied — nothing changed" itself), which is why this asserts
    // on regex/includes/test rather than on the words appearing at all. The first
    // version of this test forbade the words outright and failed against correct
    // code.
    const matchers = codeOnly.match(/\/[^/\n]*(backend-reconnecting|post-reconnect-settling)[^/\n]*\//g);
    expect(matchers, "no REGEX may key on the refusal wording").toBeNull();
    for (const phrase of ["backend-reconnecting", "post-reconnect-settling", "NOT applied"]) {
      const tested = new RegExp(
        `(includes|startsWith|indexOf|test)\\([^)\\n]*${phrase.replace(/[-—]/g, "[-—]")}`,
      );
      expect(codeOnly, `no string test may key on "${phrase}"`).not.toMatch(tested);
    }
  });
});

// ── PROTOTYPE POLLUTION, at every hop (review, P0) ──────────────────────────
//
// The own-property rule was applied to the Error only. The wire message and the
// claim's own fields were read with plain lookups, so a polluted Object.prototype
// could supply the parts a real refusal omits — and an ordinary mid-write failure
// would gain the authority to have its mutation re-issued.

describe("a polluted prototype cannot manufacture retry authority (#1529)", () => {
  it("inherited CLAIM FIELDS do not complete a partial refusal", () => {
    Object.defineProperty(Object.prototype, "applied", {
      value: false,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    Object.defineProperty(Object.prototype, "stage", {
      value: "pre-executor",
      configurable: true,
      writable: true,
      enumerable: false,
    });
    Object.defineProperty(Object.prototype, "retryable", {
      value: true,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      // A refusal naming only a code: everything else would be inherited.
      const partial = { code: "backend-reconnecting" };
      expect((partial as Record<string, unknown>).applied, "the pollution is live").toBe(false);
      expect(readPanelRefusal(partial), "an inherited claim is not a claim").toBeNull();
      // …and a complete OWN refusal still works while the prototype is polluted.
      expect(readPanelRefusal({ ...GOOD })?.code).toBe("backend-reconnecting");
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>).applied;
      delete (Object.prototype as unknown as Record<string, unknown>).stage;
      delete (Object.prototype as unknown as Record<string, unknown>).retryable;
    }
  });

  it("the BRIDGE requires an own `refusal` on the reply", async () => {
    // Source-asserted: the conversion lives inside the socket handler and is not
    // reachable without a live bridge. The property is one line and deleting it is
    // the whole defect, so it is pinned where it lives.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../services/ui-bridge.ts", import.meta.url), "utf-8");
    const at = src.indexOf('new Error(String(msg.error ?? "panel reported an error"))');
    const block = src.slice(at, at + 600);
    expect(block).toMatch(/hasOwnField\(msg, "refusal"\)/);
  });

  it("the own-property TEST itself is not reachable through the prototype", () => {
    // Review, round 3. `Object.prototype.hasOwnProperty.call(x, k)` reads the method
    // off the very prototype the check exists to distrust. Swapping it for one that
    // answers `true` does not break through on its own — a claim with no values is
    // still rejected on its values. It breaks through COMBINED with pollution that
    // supplies them, which is what this reproduces. The module binds the intrinsic at
    // load, so neither half reaches it.
    //
    // Under this project's threat model this guards a MISTAKE, not an attacker: a
    // process that can rewrite Object.prototype can call the retry path directly.
    const realHasOwn = Object.prototype.hasOwnProperty;
    const define = (target: object, key: string, value: unknown): void => {
      Object.defineProperty(target, key, {
        value,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    };
    // Assertions run AFTER the window closes — `expect` itself uses hasOwnProperty.
    let partial: unknown;
    let inherited: unknown;
    let genuine: unknown;
    let swapWasLive = false;
    define(Object.prototype, "applied", false);
    define(Object.prototype, "stage", "pre-executor");
    define(Object.prototype, "retryable", true);
    define(Error.prototype, PANEL_REFUSAL_PROP, { ...GOOD });
    define(Object.prototype, "hasOwnProperty", () => true);
    try {
      swapWasLive = realHasOwn.call({}, "nothing") === false && ({}).hasOwnProperty("nothing") === true;
      // A claim naming only its code, with the rest inherited.
      partial = readPanelRefusal({ code: "backend-reconnecting" });
      // An unrelated mid-write failure, with the attachment inherited.
      inherited = isPreExecutorRefusal(new Error("the node was added, then the socket died"));
      // A real refusal must still work under both.
      genuine = isPreExecutorRefusal(attachPanelRefusal(new Error("x"), { ...GOOD } as never));
    } finally {
      define(Object.prototype, "hasOwnProperty", realHasOwn);
      delete (Object.prototype as unknown as Record<string, unknown>).applied;
      delete (Object.prototype as unknown as Record<string, unknown>).stage;
      delete (Object.prototype as unknown as Record<string, unknown>).retryable;
      delete (Error.prototype as unknown as Record<string, unknown>)[PANEL_REFUSAL_PROP];
    }
    expect(swapWasLive, "both halves of the attack were in place").toBe(true);
    expect(partial, "an inherited claim is not a claim, whoever answers hasOwnProperty").toBeNull();
    expect(inherited, "an inherited attachment must not authorise a mutation retry").toBeNull();
    expect((genuine as { code?: string } | null)?.code).toBe("backend-reconnecting");
    expect(({}).hasOwnProperty("x")).toBe(false);
  });

  it("a refusal that crossed JSON still passes — the rule costs a real panel nothing", () => {
    // The own-property rule must not reject the shape an actual panel produces. Every
    // reply arrives through JSON.parse, whose objects own all their fields.
    const overTheWire = JSON.parse(JSON.stringify({ refusal: GOOD })) as { refusal: unknown };
    expect(readPanelRefusal(overTheWire.refusal)?.code).toBe("backend-reconnecting");
    expect(hasOwnField(overTheWire, "refusal")).toBe(true);
  });
});
