#!/usr/bin/env node
/**
 * Generate `locales/en/main.json` from the `tr()` / `trFor()` call sites in src/.
 *
 * English is the SOURCE catalog: generated from the code, never hand-edited, so the key set
 * cannot drift from what this process actually prints. Every other language is then validated
 * against it (scripts/i18n-check.mjs).
 *
 * SCOPE — read the header of src/i18n/index.ts first. Almost everything this repo emits is read
 * by an LLM, not a person: the panel tool definitions, the `.describe()` parameter docs, the
 * system prompts, `src/tools/vocabulary.ts`. None of that may be translated, and none of it is
 * in here. A key exists in this catalog if and only if a call site already declared it; this
 * script never PROPOSES one. Deciding that a string is human-facing is a human decision made in
 * the source, by wrapping it — not a guess made here.
 *
 * That distinction is why the scan resolves aliases instead of matching on shape. The first
 * draft accepted any `f("dotted.key", "English…")`, and the very first thing it swept up was
 * `resolvePrompt("panel.persona", PANEL_SYSTEM_APPEND)` — the agent's entire system prompt,
 * handed to eleven translators. A catalog builder that cannot tell a translation call from a
 * prompt lookup is worse than no builder.
 *
 *   node scripts/i18n-build-en.mjs           # write locales/en/main.json
 *   node scripts/i18n-build-en.mjs --print   # write nothing; emit the catalog on stdout
 *   node scripts/i18n-build-en.mjs --json    # dump the parsed call sites instead
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

/** The two real entry points. Everything else is reached from them, per file. */
const SEED = [
  ["tr", 0],
  ["trFor", 1],
];

/** A catalog key: a dotted, lower-first identifier path. Checked, not used to find sites. */
const KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+$/;

/** Plural categories `Intl.PluralRules` can return; the only object-fallback members read. */
const PLURAL_CATS = ["zero", "one", "two", "few", "many", "other"];

/** Sources whose human-facing strings are ours. Tests declare throwaway keys; the runtime
 *  itself declares none (its doc comment discusses `tr()` but calls it nowhere). */
function sources() {
  const out = [];
  const walk = (dir) => {
    // Code-unit order, for the same reason the key sort below uses it: nothing about this
    // build may depend on the machine's collation.
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "i18n") continue;
        walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts")) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * Blank comments and template-literal PROSE, preserving every byte offset so positions still
 * point at the real source line.
 *
 * Comments are blanked because a `tr("x", "y")` inside a doc comment is not a call site, and
 * emitting its key would add an entry no code looks up — which the parity gate then demands
 * from all eleven translations.
 *
 * Template literals are blanked but their `${…}` holes are NOT: a hole is code, and most of
 * the `say` frames are written as `` `⚠️ ${trFor(locale, "say.x", "…")}` ``. An earlier draft
 * had this exactly backwards — it blanked the holes to stop `` `say.degraded.${key}` `` from
 * reading as a key — and silently lost a third of the catalog, including every warning frame
 * the panel shows. The template-keyed wrappers are read from the raw source instead, which
 * costs one lookup and does not hide anything.
 */
function maskNonCode(src) {
  const out = src.split("");
  const modes = [{ kind: "code", depth: 0 }];
  let i = 0;
  while (i < src.length) {
    const top = modes[modes.length - 1];
    const c = src[i];
    if (top.kind === "str") {
      if (c === "\\") i += 2;
      else {
        if (c === top.quote) modes.pop();
        i++;
      }
      continue;
    }
    if (top.kind === "tpl") {
      if (c === "\\") {
        for (const k of [i, i + 1]) if (src[k] !== "\n") out[k] = " ";
        i += 2;
        continue;
      }
      if (c === "`") {
        modes.pop();
        i++;
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        modes.push({ kind: "code", depth: 1 });
        i += 2;
        continue;
      }
      if (c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " ";
      continue;
    }
    if (c === '"' || c === "'") {
      modes.push({ kind: "str", quote: c });
      i++;
      continue;
    }
    if (c === "`") {
      modes.push({ kind: "tpl" });
      i++;
      continue;
    }
    // Only a hole's own code frame closes on `}`; the file-level frame never pops.
    if (top.depth > 0) {
      if (c === "{") top.depth++;
      else if (c === "}" && --top.depth === 0) {
        modes.pop();
        i++;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/**
 * Blank COMMENTS ONLY, leaving every string and template exactly as written.
 *
 * This exists to give the blind-spot counter below a view of the file that `maskNonCode` has
 * not touched. Counting on the masked copy is what made the counter useless: anything masking
 * erased vanished from both sides of the comparison, so reinstating the template-hole bug hid
 * 58 keys and the counter said nothing — the build only failed by luck, through an unrelated
 * "unreadable fallback" error from two constants that happen to be shared. A check computed
 * from the parser's own view of the world cannot detect a fault in that view.
 *
 * Comments still have to go, because a `tr("x", "y")` written inside one is not a call site.
 */
function stripComments(src) {
  const out = src.split("");
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 2;
      else {
        if (c === quote) quote = null;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " ";
      continue;
    }
    // Backticks are treated as an ordinary delimiter here: a `${…}` hole stays visible, which
    // is the whole point — that is where the say frames' translator calls live.
    if (c === '"' || c === "'" || c === "`") quote = c;
    i++;
  }
  return out.join("");
}

/**
 * Split a bracketed group's comma-separated parts. `open` indexes the `(`, `[` or `{`.
 * Returns the parts as raw source slices plus their absolute start offsets, so a caller can
 * read an argument back out of the UNMASKED source.
 */
function splitGroup(src, open) {
  const parts = [];
  const starts = [];
  let depth = 0;
  let quote = null;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        parts.push(src.slice(start, i));
        starts.push(start);
        return { parts, starts, end: i };
      }
    } else if (c === "," && depth === 1) {
      parts.push(src.slice(start, i));
      starts.push(start);
      start = i + 1;
    }
  }
  return null;
}

function unescape(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const c = raw[++i];
    if (c === "n") out += "\n";
    else if (c === "t") out += "\t";
    else if (c === "r") out += "\r";
    else if (c === "u") {
      if (raw[i + 1] === "{") {
        const close = raw.indexOf("}", i);
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, close), 16));
        i = close;
      } else {
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (c === "\n") {
      // A backslash-newline continuation contributes nothing.
    } else out += c;
  }
  return out;
}

/** Read a quoted literal, following `+` concatenation and named English constants. */
function readString(expr, consts) {
  let rest = expr.trim();
  let text = "";
  let any = false;
  for (;;) {
    const m = rest.match(/^(["'`])((?:\\.|(?!\1)[^\\])*)\1/);
    if (m) {
      // A template literal with a HOLE is not a fallback, it is a computed string, and this is
      // the one place the reader would otherwise guess where it refuses everywhere else.
      // Captured verbatim, `` `Hello ${NAME}, welcome back.` `` lands in the catalog with the
      // `${NAME}` still in it. English looks perfect — the template evaluates at runtime — while
      // every translation renders a literal `${NAME}`, because `trFor` substitutes `{name}` and
      // has never heard of `${…}`. Refusing sends the author to a real `{placeholder}` instead.
      if (m[1] === "`" && m[2].includes("${")) return null;
      // A fallback split across lines as `"first " + "second"` is ONE sentence. Reading only
      // the first literal would put half of it in the catalog: English still renders whole
      // (the expression evaluates at runtime), so every translation would silently lose the
      // rest and nothing in English could reveal it.
      text += unescape(m[2]);
      rest = rest.slice(m[0].length).trim();
      any = true;
    } else {
      const id = rest.match(/^[A-Za-z_$][\w$]*/);
      // `t("console.credentials.privacy", CREDENTIALS_PRIVACY_EN)` — the English lives in a
      // module constant because two call sites share it. Resolving it keeps the catalog
      // complete; refusing would drop a key the page renders.
      if (id && consts.has(id[0])) {
        text += consts.get(id[0]);
        rest = rest.slice(id[0].length).trim();
        any = true;
      } else return null;
    }
    if (rest.startsWith("+")) {
      rest = rest.slice(1).trim();
      continue;
    }
    return rest === "" && any ? text : null;
  }
}

/** `{ one: "…", other: "…" }` — a counted fallback. Returns [cat, text][] or null. */
function readPluralObject(expr, consts) {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("{")) return null;
  const inner = splitGroup(trimmed, 0);
  if (!inner) return null;
  const forms = [];
  for (const part of inner.parts) {
    const m = part.match(/^\s*(\w+)\s*:\s*/);
    if (!m || !PLURAL_CATS.includes(m[1])) continue;
    const text = readString(part.slice(m[0].length), consts);
    if (text === null) return null;
    forms.push([m[1], text]);
  }
  return forms.length ? forms : null;
}

/** Module constants holding English prose (`const UNAUTHORIZED_EN = "…"`). */
function readConsts(masked, raw) {
  const consts = new Map();
  const re = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*([^;]*);/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    // Slice the initialiser out of the RAW source — the masked copy has the same offsets but
    // the literal's own bytes are what we want.
    const initStart = m.index + m[0].length - 1 - m[2].length;
    const text = readString(raw.slice(initStart, initStart + m[2].length), consts);
    if (text !== null) consts.set(m[1], text);
  }
  return consts;
}

/**
 * A callee is a bare identifier, not a property access — but `...tr(…)` IS one.
 *
 * The first version rejected anything preceded by a dot, which quietly dropped the only
 * spread call site in the repo (`...tr("cli.connect_quiet_note", …)` in boot.ts, whose value
 * is three concatenated lines split back apart). The blind-spot counter below missed it too,
 * because it was written with the same lookbehind: a check that shares the parser's blind spot
 * is not a check. The counter now uses a LOOSER rule on purpose, so it over-counts rather than
 * agreeing.
 */
const CALLEE_START = String.raw`(?:(?<=\.\.\.)|(?<![\w$.]))`;

/**
 * Every call expression in a file: `{ name, open, parts, starts, index }`.
 *
 * `function trSlots(locale, key, …)` is excluded: it is the DECLARATION of a translator, not a
 * call to one, and reading it as a call reports the parameter `key` as an unreadable key.
 */
function callSites(masked) {
  const out = [];
  const re = new RegExp(`${CALLEE_START}(?:(function|class)\\s*\\*?\\s*)?([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
  let m;
  while ((m = re.exec(masked)) !== null) {
    // A declaration consumes its own name, so the scan cannot re-match it as a call.
    if (m[1]) continue;
    const open = m.index + m[0].length - 1;
    const group = splitGroup(masked, open);
    if (!group) continue;
    out.push({ name: m[2], index: m.index, open, parts: group.parts, starts: group.starts });
  }
  return out;
}

/** Index of the `(` that opens the group containing `at`, walking back over balanced pairs. */
function openParenBefore(masked, at) {
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = masked[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * Resolve the local wrappers that end up calling `tr`/`trFor`.
 *
 * A wrapper is found by DATA FLOW, not by name: at a call to an already-known translator, the
 * key slot holds a bare identifier rather than a literal, so that identifier is a parameter of
 * whatever encloses the call, and its position in that parameter list is the wrapper's own key
 * index. Iterating to a fixpoint walks the chain the console page actually builds — trFor →
 * trSlots → trHtml → the arrow `pageT` returns → the `t` each page binds — without this script
 * knowing any of those names, so renaming one cannot silently empty a namespace.
 *
 * Returns `Map<name, { keyIndex, prefix }>`; `prefix` is set for the wrappers that build their
 * key as `` `say.degraded.${key}` `` from a short argument.
 */
function discoverTranslators(masked, raw, calls) {
  const known = new Map(SEED.map(([name, keyIndex]) => [name, { keyIndex, prefix: "" }]));
  const factories = new Map(); // name -> keyIndex of the translator it RETURNS

  for (let round = 0; round < 6; round++) {
    let grew = false;
    const register = (name, keyIndex, prefix) => {
      if (!name || known.has(name)) return;
      known.set(name, { keyIndex, prefix });
      grew = true;
    };

    for (const call of calls) {
      const spec = known.get(call.name);
      if (!spec || call.parts.length <= spec.keyIndex) continue;
      const passed = passthroughKey(call, spec.keyIndex, raw);
      if (!passed) continue;

      // The key slot holds a parameter name. Find the parameter list that declares it and the
      // declaration that owns that list.
      const decl = paramOwner(masked, passed.ident, call.index);
      if (!decl) continue;

      if (decl.name) register(decl.name, decl.paramIndex, passed.prefix + spec.prefix);
      else if (decl.returnedBy && !factories.has(decl.returnedBy)) {
        factories.set(decl.returnedBy, { keyIndex: decl.paramIndex, prefix: passed.prefix + spec.prefix });
        grew = true;
      }
    }

    // `const t = pageT(locale)` — binding a factory's product to a name.
    for (const call of calls) {
      const made = factories.get(call.name);
      if (!made) continue;
      const before = masked.slice(Math.max(0, call.index - 120), call.index);
      const m = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:await\s+)?$/);
      if (m) register(m[1], made.keyIndex, made.prefix);
    }

    if (!grew) break;
  }
  return known;
}

/**
 * A translator call whose key comes from an enclosing parameter rather than a literal —
 * `trFor(loc, key, …)` or `` trFor(loc, `say.degraded.${key}`, …) ``. Returns the parameter
 * name and any constant prefix the wrapper prepends, or null when the key is a literal.
 *
 * The template form is read from the RAW source: masking blanks template prose, so the prefix
 * only survives there.
 */
function passthroughKey(call, keyIndex, raw) {
  const rawArg = raw.slice(call.starts[keyIndex], call.starts[keyIndex] + call.parts[keyIndex].length).trim();
  if (/^[A-Za-z_$][\w$]*$/.test(rawArg)) return { ident: rawArg, prefix: "" };
  const tpl = rawArg.match(/^`([a-z][a-zA-Z0-9_.]*\.)\$\{\s*([A-Za-z_$][\w$]*)\s*\}`$/);
  return tpl ? { ident: tpl[2], prefix: tpl[1] } : null;
}

/**
 * Where a callable's body ends, given the index just past its parameter list.
 * Returns -1 when what follows is not a body — which is how a call that merely PASSES an
 * argument list is told apart from a declaration.
 */
function bodyEnd(masked, closeParen) {
  const after = masked.slice(closeParen + 1);
  const lead = after.match(/^\s*(?::[^=>{;]*)?(?:(=>)\s*)?/);
  if (!lead) return -1;
  let at = closeParen + 1 + lead[0].length;
  if (masked[at] === "{") {
    const g = splitGroup(masked, at);
    return g ? g.end : -1;
  }
  if (!lead[1]) return -1; // a `(…)` with no `=>` and no `{` is a call, not a declaration
  // Arrow with an expression body: run to the first `,`, `;` or closing bracket at depth 0.
  let depth = 0;
  let quote = null;
  for (let i = at; i < masked.length; i++) {
    const c = masked[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return i - 1;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return i - 1;
  }
  return masked.length - 1;
}

/**
 * The declaration whose parameter list declares `ident` AND whose body contains `before`.
 * Returns `{ name, paramIndex }`, or `{ returnedBy, paramIndex }` for an anonymous arrow that
 * a named function returns.
 *
 * The containment check is what makes this safe rather than merely plausible. Without it, the
 * nearest preceding `(backend: string, …)` in a 5000-line file gets claimed as the owner of a
 * `backend` that is a local const eighty functions later, and an unrelated helper is registered
 * as a translator. Candidates are therefore walked nearest-first and the first one that really
 * encloses the call wins.
 */
function paramOwner(masked, ident, before) {
  const re = new RegExp(`[(,]\\s*${ident}\\s*[?:,)]`, "g");
  const hits = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (m.index >= before) break;
    hits.push(m.index);
  }

  for (const hit of hits.reverse()) {
    const open = masked[hit] === "(" ? hit : openParenBefore(masked, hit);
    if (open < 0) continue;
    const group = splitGroup(masked, open);
    if (!group || group.end > before) continue;

    const paramIndex = group.parts.findIndex((p) => p.trim().replace(/[?:=].*$/s, "").trim() === ident);
    if (paramIndex < 0) continue;

    const end = bodyEnd(masked, group.end);
    if (end < before) continue;

    const head = masked.slice(Math.max(0, open - 160), open);
    const fn = head.match(/(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*$/);
    if (fn) return { name: fn[1], paramIndex };
    const assigned = head.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?$/);
    if (assigned) return { name: assigned[1], paramIndex };

    // An anonymous arrow. If a named function returns it, that function is a translator FACTORY.
    if (/\breturn\s*(?:async\s*)?$/.test(head)) {
      // NEAREST enclosing declaration, so take the LAST match before `open` — a leftmost regex
      // match names the first function in the file, which is a different function entirely.
      const fnRe = /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
      const region = masked.slice(0, open);
      let last = null;
      let f;
      while ((f = fnRe.exec(region)) !== null) last = f[1];
      if (last) return { returnedBy: last, paramIndex };
    }
  }
  return null;
}

/**
 * Read a table of object literals — `const NAME: T[] = [{ … }, …]` — pulling the requested
 * string fields out of each entry. Values may be literals, concatenations or English constants.
 */
function dataTable(rel, tableName, fields) {
  const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const masked = maskNonCode(raw);
  const consts = readConsts(masked, raw);
  // The type annotation is allowed to contain `[]`, so the pre-`=` run may not exclude brackets.
  const decl = new RegExp(`\\bconst\\s+${tableName}\\b[^=;]*=\\s*\\[`).exec(masked);
  if (!decl) return null;
  const arr = splitGroup(masked, decl.index + decl[0].length - 1);
  if (!arr) return null;

  const rows = [];
  for (let i = 0; i < arr.parts.length; i++) {
    const braceOffset = arr.parts[i].indexOf("{");
    if (braceOffset < 0) continue;
    const obj = splitGroup(masked, arr.starts[i] + braceOffset);
    if (!obj) continue;
    const row = {};
    for (let j = 0; j < obj.parts.length; j++) {
      const m = obj.parts[j].match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*/);
      if (!m || !fields.includes(m[1])) continue;
      const start = obj.starts[j] + m[0].length;
      const text = readString(raw.slice(start, obj.starts[j] + obj.parts[j].length), consts);
      if (text !== null) row[m[1]] = text;
    }
    if (fields.every((f) => f in row)) rows.push(row);
  }
  return rows;
}

/**
 * Call sites whose key's LAST segment is a runtime value, with the table that enumerates it.
 *
 * `dtr(backend, reg.degradedMessage…)` in the orchestrator fans the degraded frame out over the
 * OpenAI-key provider registry, so the keys are `say.degraded.glm`, `…kimi`, `…moonshot`,
 * `…minimax` — real, live keys that no static read of that one line can produce. Enumerating
 * them from the registry means adding a provider adds its key here automatically, which is the
 * property that matters; the alternative is four keys that are missing from English and
 * therefore untranslatable in every language, with nothing to say so.
 *
 * The marker strip mirrors the leading-warning-sign replace the call site performs: the table's
 * copy carries a leading ⚠️ and the frame re-adds one, so a catalog that kept it renders two.
 */
const DYNAMIC_SITES = [
  {
    file: "src/orchestrator/index.ts",
    prefix: "say.degraded.",
    ident: "backend",
    fallback: /\breg\.degradedMessage\b/,
    expand() {
      const rows = dataTable("src/services/openai-provider-registry.ts", "OPENAI_KEY_PROVIDERS", [
        "id",
        "degradedMessage",
      ]);
      if (!rows || !rows.length) return null;
      return rows.map((r) => [`say.degraded.${r.id}`, r.degradedMessage.replace(/^⚠️\s*/u, "")]);
    },
  },
];

const candidates = [];
const unparsed = [];
const wrappersByFile = new Map();
/** Every `"a.b.c"`-shaped literal in the scanned sources — the second, independent detector. */
const keyShapedLiterals = [];

for (const file of sources()) {
  const raw = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const code = stripComments(raw);
  const lineAt = (idx) => raw.slice(0, idx).split("\n").length;

  // SECOND DETECTOR, collected for EVERY source file — deliberately in front of the `tr(`
  // pre-filter below, because a file that never names `tr` is precisely the case the primary
  // counter cannot see. A wrapper defined in another module (`panelT(locale, key, fallback)`
  // exported from a helper) leaves its consumer with no `tr(` at all: the file is skipped
  // wholesale, the counter is satisfied at 0 === 0, and the key is dropped in silence. Measured
  // before this moved: exit 0, no diagnostic, and `i18n-check` then certifies the catalog 100%
  // translated while the string renders English in all eleven languages forever.
  //
  // This detector knows nothing about call syntax — only that a literal shaped like a key, in a
  // namespace the catalog owns, had better be in the catalog. That is why it survives a wrapper
  // nobody anticipated. (Placing it behind the filter was my first attempt, and it reproduced
  // the bug it was written to catch.)
  for (const m of code.matchAll(/["']([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+)["']/g)) {
    keyShapedLiterals.push({ key: m[1], file: rel, line: lineAt(m.index) });
  }

  if (!/(?<![\w$])tr(?:For)?\s*\(/.test(code)) continue;
  const masked = maskNonCode(raw);
  const consts = readConsts(masked, raw);
  const calls = callSites(masked);
  const known = discoverTranslators(masked, raw, calls);
  wrappersByFile.set(
    rel,
    [...known.keys()].filter((n) => !SEED.some(([s]) => s === n)),
  );

  // BLIND SPOT. Everything below can only police call sites the scanner produced; one it never
  // produced — an unbalanced group, a shape the regex misses — is absent from both sides of
  // every comparison, so a check written against the candidates would stay green while the key
  // silently vanished. Counting the raw occurrences is the only thing that notices, and it has
  // now found two: masking used to blank template holes (hiding every `${trFor(…)}` say frame),
  // and the callee rule used to reject `...tr(` as a property access.
  //
  // Two things keep this independent of the parser, and both were added only after a
  // measurement showed the previous version silent on the exact fault it names:
  //   - it counts on `stripComments(raw)`, NOT on `masked`. Masking is the parser's view; a
  //     bug in it erases the evidence from both sides.
  //   - the pattern is deliberately LOOSER than `CALLEE_START` — it would also count a genuine
  //     `obj.tr(` property access. Over-counting produces a failure a human resolves; matching
  //     the parser's own rule produces silence, which is how the `...tr(` bug survived the
  //     template-hole fix.
  const seen = calls.filter((c) => SEED.some(([name]) => name === c.name)).length;
  const present = (code.match(/(?<![\w$])tr(?:For)?\s*\(/g) ?? []).length;
  if (seen !== present) {
    unparsed.push({ file: rel, line: 0, why: `${present} tr/trFor call(s) in the source, ${seen} readable` });
  }

  for (const call of calls) {
    const spec = known.get(call.name);
    if (!spec || call.parts.length <= spec.keyIndex) continue;
    const line = lineAt(call.index);

    const keyLit = call.parts[spec.keyIndex].trim().match(/^(["'])((?:\\.|(?!\1)[^\\])*)\1$/);
    if (!keyLit) {
      const passed = passthroughKey(call, spec.keyIndex, raw);
      const fbIdx = spec.keyIndex + 1;
      const fbSrc = fbIdx < call.parts.length ? call.parts[fbIdx] : "";

      // DYNAMIC SITES FIRST, and the order is load-bearing rather than stylistic.
      //
      // The passthrough test below asks "is this key an enclosing PARAMETER?", and it used to
      // run first. `dtr(backend, …)` is matched here because `backend` is a local const today —
      // but the natural refactor of that 4000-line handler makes it a parameter, at which point
      // `paramOwner` starts matching, the `continue` fires, and the registry fan-out is skipped.
      // Measured by forcing that condition: exit 0, no stderr, and `say.degraded.glm/kimi/
      // minimax/moonshot` simply gone — four live keys, untranslatable, with nothing to say so.
      // An enumerated site (file + prefix + identifier + fallback shape) is far more specific
      // than a structural guess, so it gets to answer first.
      const dyn = DYNAMIC_SITES.find(
        (d) => d.file === rel && d.prefix === spec.prefix && passed?.ident === d.ident && d.fallback.test(fbSrc),
      );
      if (dyn) {
        const rows = dyn.expand();
        if (!rows) {
          unparsed.push({ file: rel, line, why: `${dyn.prefix}* is chosen at runtime and its table could not be read` });
          continue;
        }
        for (const [key, text] of rows) candidates.push({ key, text, file: rel, line });
        continue;
      }

      // Otherwise: a non-literal key at a translator call is a WRAPPER body (`trFor(loc, key,
      // …)`), which discovery above has already turned into its own translator — the real keys
      // arrive at the wrapper's own call sites. If it is NOT that, the keys behind it are
      // invisible to this build and would be missing from English, so say so.
      if (passed && paramOwner(masked, passed.ident, call.index)) continue;

      unparsed.push({ file: rel, line, why: `key is not a literal: ${call.parts[spec.keyIndex].trim().slice(0, 60)}` });
      continue;
    }
    const key = spec.prefix + keyLit[2];
    if (!KEY_SHAPE.test(key)) {
      unparsed.push({ file: rel, line, why: `key "${key}" is not a dotted catalog key` });
      continue;
    }
    if (call.parts.length <= spec.keyIndex + 1) {
      unparsed.push({ file: rel, line, why: `${key} has no English fallback argument` });
      continue;
    }

    const fbIdx = spec.keyIndex + 1;
    const fallbackSrc = raw.slice(call.starts[fbIdx], call.starts[fbIdx] + call.parts[fbIdx].length);

    const forms = readPluralObject(fallbackSrc, consts);
    if (forms) {
      for (const [cat, text] of forms) candidates.push({ key: `${key}_${cat}`, text, file: rel, line });
      continue;
    }
    const text = readString(fallbackSrc, consts);
    if (text === null) {
      // A key we can see with a fallback we cannot read is the dangerous case: the key is live
      // at runtime and would be ABSENT from English, so every translation of it fails parity.
      // Refuse rather than guess.
      unparsed.push({ file: rel, line, why: `${key}: unreadable fallback ${fallbackSrc.trim().slice(0, 60)}` });
      continue;
    }
    candidates.push({ key, text, file: rel, line });
  }
}

if (unparsed.length) {
  console.error("call sites this build could not read:");
  for (const u of unparsed) console.error(`  ${u.file}:${u.line}  ${u.why}`);
  console.error("\nEach is a live key that would be absent from English. Fix the site or this script.");
  process.exit(1);
}

// key -> text. The same key rendered from two places is the common case and collapses to one
// entry; the same key with DIFFERENT English is a bug that must not reach a translator, who
// would translate one of the two and silently change what the other site says.
const flat = new Map();
for (const c of candidates) {
  const prior = flat.get(c.key);
  if (prior !== undefined && prior !== c.text) {
    console.error(
      `key collision: ${c.key}\n  a: ${JSON.stringify(prior)}\n  b: ${JSON.stringify(c.text)} (${c.file}:${c.line})`,
    );
    process.exit(1);
  }
  flat.set(c.key, c.text);
}

// SECOND DETECTOR — see the collection site above. A literal shaped like a key, in a namespace
// this catalog owns, that no call site produced, is a key some path reaches at runtime and this
// build cannot see. Scoped to namespaces the catalog already declares so it never has an opinion
// about unrelated dotted strings: `panel.persona` is a prompt id, not vocabulary, and stays out.
const OWNED = new Set([...flat.keys()].map((k) => k.split(".")[0]));
const orphans = keyShapedLiterals.filter((l) => OWNED.has(l.key.split(".")[0]) && !flat.has(l.key));
if (orphans.length) {
  console.error("key-shaped literals this build did not capture:");
  for (const o of orphans) console.error(`  ${o.file}:${o.line}  ${o.key}`);
  console.error(
    "\nEach names a catalog namespace but reached no call site this build understands — most" +
      "\nlikely a translator wrapper defined in ANOTHER module. Teach the build about it, or" +
      "\nthe key is missing from English and untranslatable in every language, silently.",
  );
  process.exit(1);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ wrappers: Object.fromEntries(wrappersByFile), candidates }, null, 2));
  process.exit(0);
}

// Nest `a.b.c` so the file reads by area rather than as one long list.
//
// Ordered by CODE UNIT, not `localeCompare`. The committed file is compared byte for byte
// against a fresh build, so a collation that depends on the machine's ICU locale would make
// that comparison a property of whose laptop ran it. Every key is ASCII, so this is also the
// order a reader expects.
const nested = {};
const byCodeUnit = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
for (const [key, text] of [...flat.entries()].sort(byCodeUnit)) {
  const parts = key.split(".");
  let cur = nested;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] === "string") {
      console.error(`key "${key}" needs "${p}" to be a group, but a string already sits there`);
      process.exit(1);
    }
    cur = cur[p] ??= {};
  }
  cur[parts.at(-1)] = text;
}

const serialized = JSON.stringify(nested, null, 2) + "\n";

// `--print` writes nothing, so a test can rebuild the catalog and compare without touching the
// tree:
// a committed English catalog that no longer matches the code is a silent lie, exactly like a
// stale generated doc page.
if (process.argv.includes("--print")) {
  process.stdout.write(serialized);
  process.exit(0);
}

const outDir = path.join(ROOT, "locales", "en");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "main.json"), serialized);
console.log(`wrote locales/en/main.json — ${flat.size} keys from ${candidates.length} call sites`);
