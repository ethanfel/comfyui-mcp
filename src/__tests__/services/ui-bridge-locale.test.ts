/**
 * PER-TAB panel language for the bridge's HUMAN-facing `say` frames.
 *
 * A `say` renders as a chat bubble inside ONE panel tab, and those strings name panel
 * controls ("Settings → OpenRouter → 'Set API key…'"). Rendered in the process locale — the
 * language of whoever launched the orchestrator — the instruction would point at a label the
 * user cannot find on their own screen. So the language has to come from the destination tab,
 * which is what `hello.locale` + `tabLocale()` provide.
 *
 * The behaviour actually worth guarding is what happens when it CANNOT work. These frames are
 * emitted while reporting OTHER failures — an agent that would not start, render results that
 * were lost, a panel sync that did not happen — so a locale lookup that threw would turn one
 * failure report into two. Every unknown here must produce English, never an exception.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import { trFor, __resetI18nForTest } from "../../i18n/index.js";
import {
  buildStartFailureNotice,
  startFailureHint,
  startFailureSay,
} from "../../orchestrator/start-failure-notice.js";
import { openAiKeyProvider } from "../../services/openai-provider-registry.js";

let bridge: UiBridge;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

/** Open a socket without registering, so a test can drive the hello frames itself. */
function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => resolve(sock));
    sock.on("error", reject);
  });
}

/** Register `tabId` on `sock`, resolving once the bridge has processed the hello. */
async function hello(
  sock: WebSocket,
  tabId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const before = bridge.tabConnectionGeneration(tabId);
  sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: "wf", ...extra }));
  // Every hello bumps the tab's generation, so this waits for THIS hello rather than for a
  // fixed sleep — a re-hello that changes nothing observable would otherwise race.
  for (let i = 0; i < 100; i++) {
    if (bridge.tabConnectionGeneration(tabId) !== before) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`hello for ${tabId} was never processed`);
}

beforeEach(async () => {
  port = await freePort();
  bridge = new UiBridge(port);
  bridge.start();
  expect(await bridge.whenReady()).toBe(true);
});

afterEach(async () => {
  await bridge.stop();
  __resetI18nForTest();
});

describe("tabLocale — where a say frame's language comes from", () => {
  it("takes the language the panel advertised in its hello", async () => {
    const sock = await open();
    await hello(sock, "tab-ko", { locale: "ko" });
    expect(bridge.tabLocale("tab-ko")).toBe("ko");
    sock.close();
  });

  it("normalises what the panel actually sends (regional + script variants)", async () => {
    // ComfyUI's own language list is the source, so the panel can hand us pt-PT or zh-HK;
    // both must land on a locale we ship rather than silently degrading to English.
    const a = await open();
    await hello(a, "tab-pt", { locale: "pt-PT" });
    expect(bridge.tabLocale("tab-pt")).toBe("pt-BR");
    const b = await open();
    await hello(b, "tab-hk", { locale: "zh-HK" });
    expect(bridge.tabLocale("tab-hk")).toBe("zh-TW");
    a.close();
    b.close();
  });

  it("falls back to English for a tab that never advertised a language", async () => {
    // The panel builds that predate `hello.locale` are the common case, not an error.
    const sock = await open();
    await hello(sock, "tab-old");
    expect(bridge.tabLocale("tab-old")).toBe("en");
    sock.close();
  });

  it("falls back to English for a language we do not ship, rather than guessing a neighbour", async () => {
    const sock = await open();
    await hello(sock, "tab-kl", { locale: "kl-GL" });
    expect(bridge.tabLocale("tab-kl")).toBe("en");
    sock.close();
  });

  it("falls back to English for junk instead of throwing", async () => {
    // Not a security boundary — the panel is trusted — but this value is read while
    // REPORTING a failure, so a bad one must not be able to add a second failure.
    const sock = await open();
    await hello(sock, "tab-junk", { locale: { nope: true } });
    expect(bridge.tabLocale("tab-junk")).toBe("en");
    sock.close();
  });

  it("answers English for an unknown tab instead of throwing, even with others connected", async () => {
    // With NOTHING connected this passes for an uninteresting reason, so a real tab is
    // connected first: the question is whether an unknown id borrows a stranger's language.
    // resolveTarget throws for it, and every caller here is mid-failure-report — so the
    // lookup absorbs it. A frame in the wrong language is a blemish; an exception is a bug.
    expect(() => bridge.tabLocale("never-existed")).not.toThrow();
    expect(bridge.tabLocale("never-existed")).toBe("en");
    const sock = await open();
    await hello(sock, "tab-only", { locale: "ko" });
    expect(() => bridge.tabLocale("never-existed")).not.toThrow();
    expect(bridge.tabLocale("never-existed")).toBe("en");
    sock.close();
  });

  it("answers ambiguous prefixes in English rather than picking one of the matches", async () => {
    const a = await open();
    const b = await open();
    await hello(a, "tab-amb-1", { locale: "ko" });
    await hello(b, "tab-amb-2", { locale: "fr" });
    // "tab-amb" prefixes both, which resolveTarget refuses — a push would refuse too.
    expect(() => bridge.tabLocale("tab-amb")).not.toThrow();
    expect(bridge.tabLocale("tab-amb")).toBe("en");
    a.close();
    b.close();
  });

  it("keeps the language across a same-socket re-hello that omits it", async () => {
    // The workflow-switch re-hello does not restate every field; the panel's language did
    // not change just because this frame was shorter.
    const sock = await open();
    await hello(sock, "tab-keep", { locale: "ja" });
    expect(bridge.tabLocale("tab-keep")).toBe("ja");
    await hello(sock, "tab-keep");
    expect(bridge.tabLocale("tab-keep")).toBe("ja");
    sock.close();
  });

  it("lets a same-socket re-hello CHANGE the language", async () => {
    const sock = await open();
    await hello(sock, "tab-switch", { locale: "ja" });
    await hello(sock, "tab-switch", { locale: "fr" });
    expect(bridge.tabLocale("tab-switch")).toBe("fr");
    sock.close();
  });

  it("resets to English when a re-hello asks for a language we do not ship", async () => {
    // PRESENCE is authoritative, not resolvability. Someone who just switched the panel to
    // German needs English here — keeping their previous Japanese would name controls in a
    // language that is no longer anywhere on their screen, which is worse than not trying.
    const sock = await open();
    await hello(sock, "tab-de", { locale: "ja" });
    await hello(sock, "tab-de", { locale: "de" });
    expect(bridge.tabLocale("tab-de")).toBe("en");
    // …and the same for a value that is not even a string.
    await hello(sock, "tab-de", { locale: "ja" });
    await hello(sock, "tab-de", { locale: 42 });
    expect(bridge.tabLocale("tab-de")).toBe("en");
    sock.close();
  });

  it("carries the language across a workflow switch, which re-hellos under a NEW tab id", async () => {
    // The per-workflow re-hello is a same-SOCKET, different-ID event, so plain same-socket
    // inheritance cannot see the retiring conn — it has already been deleted and re-keyed.
    // Switching workflows must not silently drop a user back into English mid-session.
    const sock = await open();
    await hello(sock, "wf:route1:/a.json", { locale: "ko" });
    expect(bridge.tabLocale("wf:route1:/a.json")).toBe("ko");
    await hello(sock, "wf:route1:/b.json");
    expect(bridge.tabLocale("wf:route1:/b.json")).toBe("ko");
    sock.close();
  });

  it("does not let a DIFFERENT socket TAKING OVER a live tab id inherit the old one's language", async () => {
    // `wf:` tab ids recur, and a second browser tab can take over a live one. The takeover
    // is a different browser tab whose language we have not been told — English, not the
    // previous tenant's. The first socket stays OPEN on purpose: only then is the outgoing
    // conn still in `conns` and the inherit-vs-discard branch actually reached (with it
    // closed the record is already gone and the test would pass without proving anything).
    const first = await open();
    await hello(first, "wf:recycled", { locale: "ru" });
    expect(bridge.tabLocale("wf:recycled")).toBe("ru");
    const second = await open();
    await hello(second, "wf:recycled");
    expect(bridge.tabLocale("wf:recycled")).toBe("en");
    first.close();
    second.close();
  });

  it("resolves through the same prefix path a push takes, so the language matches the recipient", async () => {
    // Frames route by exact id OR unambiguous prefix; the locale must follow the SAME
    // resolution or a bubble can arrive in a language its tab never asked for.
    const sock = await open();
    await hello(sock, "tab-prefix-9999", { locale: "es" });
    expect(bridge.tabLocale("tab-prefix")).toBe("es");
    sock.close();
  });
});

describe("say frames degrade to English rather than failing", () => {
  it("renders the start-failure notice in English when the tab's language is unknown", () => {
    // No catalogs are installed in this repo, so every locale renders its English fallback —
    // the assertion that matters is that the TEXT IS INTACT, never a raw key.
    const { frames } = buildStartFailureNotice("tab-1::custom", "ECONNREFUSED", "claude");
    const say = frames[0] as { type: string; text: string };
    expect(say.type).toBe("say");
    expect(say.text).toBe(
      "⚠️ The custom agent could not start: ECONNREFUSED — " +
        "Check the base URL and API key in Settings → Custom endpoint, then Disconnect → Connect to retry.",
    );
  });

  it("renders intact text for a locale with no catalog, and never a key or an empty bubble", () => {
    // Exercises `startFailureSay` — the function the orchestrator ACTUALLY calls per tab —
    // rather than buildStartFailureNotice, which has no locale of its own precisely so that a
    // test cannot pin a path production never takes.
    for (const locale of ["ko", "ar", "zh-TW", "kl-GL", "", "not-a-locale"]) {
      const text = startFailureSay("openrouter", "401", locale);
      expect(text).toContain("OPENROUTER_API_KEY");
      expect(text).not.toContain("say.");
      expect(text).not.toContain("{");
    }
  });

  it("keeps the ⚠️ status marker outside the translatable span", () => {
    // The emoji is what the eye and the panel's bubble styling key on; it means the same
    // thing in every language and must survive a catalog that translates the prose.
    expect(startFailureSay("claude", "boom", "ja").startsWith("⚠️ ")).toBe(true);
  });

  it("delivers the SAME sentence the frame builder holds, so the two cannot drift", () => {
    // The orchestrator re-renders per recipient instead of pushing frames[0]. If those two
    // ever stopped sharing one function, the tested text and the delivered text would differ
    // with everything still green.
    const { frames } = buildStartFailureNotice("t::custom", "ECONNREFUSED", "claude");
    expect((frames[0] as { text: string }).text).toBe(
      startFailureSay("custom", "ECONNREFUSED"),
    );
  });

  it("leaves the ack and turn frames alone — they are machine state, not prose", () => {
    // `kind` is string-matched by the panel and these read as machine errors; translating
    // them would break the parse while looking like a courtesy.
    const { frames } = buildStartFailureNotice("t::claude", "boom", "claude");
    expect(frames[1]).toEqual({ type: "ack", ok: false, kind: "degraded" });
    expect(frames[2]).toEqual({ type: "turn", state: "done" });
  });

  it("passes the provider label and env var through untranslated — they are typed, not read", () => {
    const hint = startFailureHint("moonshot", "ru");
    expect(hint).toContain("MOONSHOT_API_KEY");
  });

  it("keeps every registry degraded message shaped like the ones beside it", () => {
    // The glm/kimi/moonshot/minimax bubbles live in a data table and carry their own leading
    // ⚠️; the call site strips it so all 15 say.degraded.* fallbacks have one shape and a
    // catalog never has to guess which include the marker. If the table stopped leading with
    // ⚠️, that strip would silently become a no-op and the key would gain a second one.
    for (const backend of ["glm", "kimi", "moonshot", "minimax"]) {
      const reg = openAiKeyProvider(backend);
      expect(reg, `${backend} is no longer a registered key provider`).toBeTruthy();
      expect(reg!.degradedMessage.startsWith("⚠️ "), `${backend} degradedMessage`).toBe(true);
    }
  });

  it("renders a counted string from a plain-string fallback, so English keeps its '(s)' hedge", () => {
    // The lost-completion notice passes `{ count }` with a STRING fallback. The count path
    // looks for `key_one`/`key_few`/`key_other` FIRST and only then the bare key, so a
    // catalog that carries just the bare key — which is every one we ship, English having no
    // plural forms to model — has to resolve through that last step. If it ever stopped, the
    // notice would render EMPTY, in the middle of reporting a data loss.
    //
    // Asserted against a key no catalog carries, so it measures the fallback rather than the
    // Russian text; the shipped catalogs' own counted strings are covered beside them.
    expect(
      trFor("ru", "say.restart_lost.not_a_real_key", "{count} further answer(s) on this tab", {
        count: 3,
      }),
    ).toBe("3 further answer(s) on this tab");
    // ...and the same shape resolving THROUGH a catalog still substitutes and is never empty.
    for (const locale of ["ru", "ko"]) {
      const out = trFor(locale, "say.restart_lost.withheld", "{count} further answer(s) on this tab", {
        count: 3,
      });
      expect(out).toContain("3");
      expect(out).not.toBe("");
      expect(out).not.toContain("{count}");
    }
    expect(
      trFor("ko", "say.restart_lost.no_such_key", "{count} result(s) ({runs})", {
        count: 1,
        runs: "a; b",
      }),
    ).toBe("1 result(s) (a; b)");
  });
});

/**
 * THE ROT GUARD. The mechanism above is only worth having if the CALL SITES use it, and
 * nothing else in the suite would notice if one stopped: a deleted `trFor(` wrapper leaves
 * correct English, a passing type-check and a green run — the string is simply never
 * translatable again. The same hole swallows a NEW `say` site added later by someone who has
 * not read this file.
 *
 * Two things make this guard honest rather than decorative, and both were added only after a
 * mutation proved the earlier version wrong:
 *
 *   - It reads THE FRAME'S OWN `text:` VALUE, not a character window around the marker. Any
 *     window wide enough to hold a multi-line frame also holds the NEXT frame's translator
 *     call, and an untranslated `say` inserted just before a translated one sailed through.
 *     The value is bounded by indentation: prettier puts every continuation line deeper than
 *     the `text:` line, and the next thing at that indent or shallower ends the expression.
 *   - Each exemption is bound to ONE SITE, by position, not to a neighbourhood. The collar
 *     that let both `pushSayToConversation` fragments count as "used" was equally happy to
 *     excuse an untranslated frame dropped between them.
 *
 * Exemptions are ENUMERATED rather than pattern-matched: a keyword rule ("text:", "message")
 * would quietly excuse a genuinely untranslated site, which is the exact failure this exists
 * to catch. Every entry must still MATCH live code, so a stale one is a failure rather than a
 * standing amnesty for whatever moved into its place.
 */
const SRC_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const srcOf = (rel: string): string => readFileSync(join(SRC_ROOT, rel), "utf8");

/** Every non-test source file, so a new module that emits `say` frames cannot slip past an
 *  allowlist — start-failure-notice.ts already emits one and an earlier allowlist missed it. */
function sourceFiles(dir = SRC_ROOT, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "node_modules") sourceFiles(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(relative(SRC_ROOT, full).split("\\").join("/"));
    }
  }
  return out;
}

const SAY_MARKER = `type: "say"`;

/** Byte offsets of every `say` frame in `src`. */
function saySites(src: string): number[] {
  const out: number[] = [];
  for (
    let at = src.indexOf(SAY_MARKER);
    at !== -1;
    at = src.indexOf(SAY_MARKER, at + SAY_MARKER.length)
  ) {
    out.push(at);
  }
  return out;
}

/**
 * The `text:` value expression of the frame at `at` — nothing before it, and nothing from the
 * frame after it.
 *
 * Bounded by INDENTATION rather than brace matching: braces appear inside these strings
 * (`{count}`, `${trFor(`), so a depth counter would need a full string/template scanner to be
 * trustworthy, whereas prettier's layout is already unambiguous. A one-line frame yields the
 * rest of its line, which is exactly the right answer for `text: degradedText }, panelTab);`.
 */
function sayTextExpression(src: string, at: number): string {
  const lines = src.split("\n");
  const lineOf = (off: number) => src.slice(0, off).split("\n").length - 1;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const markerLine = lineOf(at);
  // `text` may be on the marker's own line or a few lines below it (a comment can sit
  // between). Stop at the first line that dedents out of the frame literal.
  const frameIndent = indentOf(lines[markerLine]);
  let textLine = -1;
  let col = -1;
  for (let i = markerLine; i < lines.length && i < markerLine + 12; i++) {
    if (i > markerLine && lines[i].trim() && indentOf(lines[i]) < frameIndent) break;
    const m = /\btext\b\s*[:,}]/.exec(lines[i]);
    if (m && (i > markerLine || m.index > at - src.slice(0, at).lastIndexOf("\n") - 1)) {
      textLine = i;
      col = m.index;
      break;
    }
  }
  if (textLine === -1) return "";
  const baseIndent = indentOf(lines[textLine]);
  const parts = [lines[textLine].slice(col)];
  for (let i = textLine + 1; i < lines.length; i++) {
    if (lines[i].trim() && indentOf(lines[i]) <= baseIndent) break;
    parts.push(lines[i]);
  }
  return parts.join("\n");
}

/** A `say` site whose text is composed elsewhere, with the reason it carries no `trFor`. */
const SAY_EXEMPTIONS: Array<{ file: string; fragment: string; why: string }> = [
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: build("en") }`,
    why: "pushSayToConversation's own park path — `build` IS the translator",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: build(bridge.tabLocale(t)) }`,
    why: "pushSayToConversation's own fan-out — `build` IS the translator",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text, id: meta?.id`,
    why: "the AGENT's own reply — a model wrote it, in whatever language it was asked in",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: corrected }`,
    why: "TRANSLATED ELSEWHERE (pending): bannerCorrection() in ready-banner.ts owns it; that file has no i18n yet",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: parts.join(" ") }`,
    why: "each part is trFor'd a few lines above, where it is built",
  },
  {
    file: "orchestrator/index.ts",
    fragment: "${sync.message}",
    why: "TRANSLATED ELSEWHERE (pending): panel-sync owns the message; only the ⚠️ marker is added here",
  },
  {
    file: "orchestrator/index.ts",
    fragment: "readyBannerText(backend, bannerLabel, customBaseUrl)",
    why: "TRANSLATED ELSEWHERE (pending): ready-banner.ts owns the greeting; that file has no i18n yet",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: degradedText }`,
    why: "every branch of the ternary above goes through dtr() — including the registry one",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `announce: (text) => void bridge.push({ type: "say", text })`,
    why: "TRANSLATED ELSEWHERE (pending): self-restarter owns it, and it broadcasts to every tab at once",
  },
  {
    file: "orchestrator/start-failure-notice.ts",
    fragment: "text: startFailureSay(backend, message) }",
    why: "startFailureSay, defined just above in this same file, IS the trFor call",
  },
];

describe("every say frame is wired to the per-tab translator", () => {
  const filesWithSay = sourceFiles().filter((f) => srcOf(f).includes(SAY_MARKER));

  it("scans every source file that emits a say frame, not an allowlist", () => {
    // An allowlist of two files missed start-failure-notice.ts, which emits one. A new module
    // that composes frames would be invisible the same way.
    expect(filesWithSay.length).toBeGreaterThanOrEqual(3);
    for (const f of ["orchestrator/index.ts", "services/ui-bridge.ts", "orchestrator/start-failure-notice.ts"]) {
      expect(filesWithSay, `${f} emits say frames and must be scanned`).toContain(f);
    }
  });

  for (const file of filesWithSay) {
    it(`${file}: no untranslated say site`, () => {
      const src = srcOf(file);
      const sites = saySites(src);
      const exemptions = SAY_EXEMPTIONS.filter((e) => e.file === file);

      // Bind each exemption OCCURRENCE to exactly one site: the last marker at or before the
      // fragment's end. A fragment that starts before its marker (`announce: (text) => …`) and
      // one that trails it (`${sync.message}`) both land on their own frame, and neither can
      // reach the frame next door.
      const excused = new Map<number, string>();
      const unmatched = new Set(exemptions.map((e) => e.fragment));
      for (const e of exemptions) {
        for (let f = src.indexOf(e.fragment); f !== -1; f = src.indexOf(e.fragment, f + 1)) {
          const end = f + e.fragment.length;
          const site = [...sites].reverse().find((at) => at <= end && at >= f - 200);
          if (site !== undefined) {
            excused.set(site, e.why);
            unmatched.delete(e.fragment);
          }
        }
      }

      for (const at of sites) {
        if (excused.has(at)) continue;
        const line = src.slice(0, at).split("\n").length;
        expect(
          sayTextExpression(src, at),
          `an untranslated say frame at ${file}:${line} — wrap it in ` +
            "trFor(bridge.tabLocale(<tab>), …), or add it to SAY_EXEMPTIONS with a reason",
        ).toContain("trFor(");
      }

      expect(sites.length, `no say frames in ${file} — the marker must have changed`).toBeGreaterThan(0);
      expect(
        [...unmatched],
        "stale SAY_EXEMPTIONS entries: they match no code, so they excuse whatever moved in",
      ).toEqual([]);
    });
  }

  it("bounds a frame's text at its own expression, not at a character window", () => {
    // The property this guard depends on, asserted directly rather than trusted: the extracted
    // value must stop before the NEXT say frame's translator call, or a neighbour vouches for
    // an untranslated site (which is exactly how the previous version passed a mutation).
    const src = srcOf("orchestrator/index.ts");
    const sites = saySites(src);
    for (const [n, at] of sites.entries()) {
      const next = sites[n + 1];
      if (next === undefined) continue;
      const expr = sayTextExpression(src, at);
      expect(expr, `no text expression found for the say frame at index ${n}`).not.toBe("");
      // Where the extracted expression actually ENDS in the file — not `at + length`, which
      // would understate it, since the expression begins at `text:`, some way past the marker.
      const end = src.indexOf(expr, at) + expr.length;
      expect(
        end,
        `the text expression at index ${n} (line ${src.slice(0, at).split("\n").length}) ` +
          "runs into the next say frame, so that frame's translator would vouch for this one",
      ).toBeLessThanOrEqual(next);
    }
  });

  it("uses trFor (the destination tab's language), never tr (the terminal's)", () => {
    // `tr()` follows LANG/--lang on the machine running the orchestrator. A say frame naming
    // "Settings → OpenRouter" in the server operator's language points at a control the
    // panel's user cannot find — the whole reason those two calls are separate.
    for (const file of filesWithSay) {
      expect(srcOf(file), `${file} must not use the process-locale tr()`).not.toMatch(
        /[^A-Za-z0-9_.$]tr\(/,
      );
    }
  });

  it("fans the start-failure say out PER TAB instead of pre-rendering one language", () => {
    // #884's conversation spans every tab on the failed backend, and the composite key is
    // usually the SCOPE address `orchestrator::<backend>` — so there is no single "owning
    // tab" whose locale would be right. Deleting this one line leaves the notice correct in
    // English, the type-check clean and the suite green; nothing else would notice.
    expect(srcOf("orchestrator/index.ts")).toMatch(
      /pushSayToConversation\(key, \(locale\) => startFailureSay\(/,
    );
  });

  it("keys every say string under the say. prefix, once", () => {
    const src =
      srcOf("orchestrator/index.ts") +
      srcOf("services/ui-bridge.ts") +
      srcOf("orchestrator/start-failure-notice.ts");
    // Backtick keys count too: `say.degraded.${backend}` builds 15 keys from one call site,
    // and a quote-only regex would leave all 15 unguarded.
    const keys = [...src.matchAll(/trFor\([\s\S]{0,80}?["`]([a-z][\w.]*)/g)].map((m) => m[1]);
    expect(keys.length, "no trFor keys found — the say frames lost their wrappers").toBeGreaterThan(20);
    for (const k of keys) {
      expect(k, `${k} is not under the say. prefix this unit owns`).toMatch(/^say\./);
    }
    // Two sentences sharing one key would give them one translation and lose a meaning.
    expect(new Set(keys).size, `duplicate say keys: ${keys.join(", ")}`).toBe(keys.length);
  });
});
