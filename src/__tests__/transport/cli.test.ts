import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportExplicitToolMode,
  helpRow,
  parseCliArgs,
  renderCliHelp,
  validateConnectUrl,
} from "../../transport/cli.js";
import { displayWidth } from "../../i18n/terminal-layout.js";
import { __resetI18nForTest, trFor } from "../../i18n/index.js";

const base = ["node", "comfyui-mcp"];

describe("parseCliArgs", () => {
  it("defaults to stdio on 127.0.0.1:9100 with no args/env", () => {
    expect(parseCliArgs(base, {})).toEqual({
      help: false,
      transport: "stdio",
      toolMode: "full",
      toolModeExplicit: false,
      host: "127.0.0.1",
      port: 9100,
      panelOrchestrator: false,
      token: undefined,
      tunnel: false,
      allowUnauthenticated: false,
      insecureBridge: false,
      setupAgent: undefined,
      setupDryRun: false,
    });
  });

  it("--http switches transport", () => {
    expect(parseCliArgs([...base, "--http"], {}).transport).toBe("http");
  });

  it("--transport http switches transport", () => {
    expect(parseCliArgs([...base, "--transport", "http"], {}).transport).toBe("http");
  });

  it("supports --port value and --host value", () => {
    const o = parseCliArgs([...base, "--http", "--host", "0.0.0.0", "--port", "8080"], {});
    expect(o).toEqual({ help: false, transport: "http", toolMode: "full", toolModeExplicit: false, host: "0.0.0.0", port: 8080, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false, insecureBridge: false, setupAgent: undefined, setupDryRun: false });
  });

  it("supports --flag=value form", () => {
    const o = parseCliArgs([...base, "--transport=http", "--port=3000", "--host=0.0.0.0"], {});
    expect(o).toEqual({ help: false, transport: "http", toolMode: "full", toolModeExplicit: false, host: "0.0.0.0", port: 3000, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false, insecureBridge: false, setupAgent: undefined, setupDryRun: false });
  });

  it("reads env defaults", () => {
    const o = parseCliArgs(base, { MCP_TRANSPORT: "http", MCP_HOST: "0.0.0.0", MCP_PORT: "5000" });
    expect(o).toEqual({ help: false, transport: "http", toolMode: "full", toolModeExplicit: false, host: "0.0.0.0", port: 5000, panelOrchestrator: false, token: undefined, tunnel: false, allowUnauthenticated: false, insecureBridge: false, setupAgent: undefined, setupDryRun: false });
  });

  it("FULL is the default tool mode since 0.50.0; --compact / COMFYUI_MCP_TOOL_MODE=compact opts in (#726)", () => {
    // The flip. Compact was the default from #667 only because the surface was
    // too big to ship — 154 names, ~50k tokens per tools/list. Consolidation
    // took it to 37, so the classic surface is affordable again and compact
    // becomes the opt-in for small local models (#97).
    expect(parseCliArgs(base, {}).toolMode).toBe("full");
    expect(parseCliArgs([...base, "--full"], {}).toolMode).toBe("full");
    expect(parseCliArgs([...base, "--tool-mode", "full"], {}).toolMode).toBe("full");
    expect(parseCliArgs([...base, "--tool-mode=full"], {}).toolMode).toBe("full");
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "full" }).toolMode).toBe("full");
    // compact is still fully available — it is the opt-in now, not gone
    expect(parseCliArgs([...base, "--compact"], {}).toolMode).toBe("compact");
    expect(parseCliArgs([...base, "--tool-mode", "compact"], {}).toolMode).toBe("compact");
    expect(parseCliArgs([...base, "--tool-mode=compact"], {}).toolMode).toBe("compact");
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "compact" }).toolMode).toBe("compact");
    // `--full` stays an ACCEPTED no-op so existing scripts and docs snippets
    // that pass it keep working rather than erroring on an unknown flag.
    expect(parseCliArgs([...base, "--full"], {}).toolModeExplicit).toBe(true);
    // explicit CLI wins over env, in both directions
    expect(
      parseCliArgs([...base, "--tool-mode", "full"], { COMFYUI_MCP_TOOL_MODE: "compact" }).toolMode,
    ).toBe("full");
    expect(parseCliArgs([...base, "--full"], { COMFYUI_MCP_TOOL_MODE: "compact" }).toolMode).toBe("full");
    expect(parseCliArgs([...base, "--compact"], { COMFYUI_MCP_TOOL_MODE: "full" }).toolMode).toBe("compact");
    // Unknown values fall back to THE DEFAULT — which is now full. The rule is
    // unchanged ("only the exact opt-in string counts"); the default moved under
    // it. Note this is the one caller-visible behaviour change beyond the
    // default itself: `--tool-mode bogus` used to yield compact.
    expect(parseCliArgs([...base, "--tool-mode", "bogus"], {}).toolMode).toBe("full");
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "bogus" }).toolMode).toBe("full");
    // either explicit env mode counts as an explicit choice (for `setup`)
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "compact" }).toolModeExplicit).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "full" }).toolModeExplicit).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "bogus" }).toolModeExplicit).toBe(false);
  });

  it("`setup <agent>` captures the agent, --dry-run, --comfyui-url, and explicit tool mode", () => {
    expect(parseCliArgs(base, {}).setupAgent).toBeUndefined();
    const o = parseCliArgs(
      [...base, "setup", "hermes", "--dry-run", "--comfyui-url", "http://10.0.0.5:8188"],
      {},
    );
    expect(o.setupAgent).toBe("hermes");
    expect(o.setupDryRun).toBe(true);
    expect(o.comfyuiUrl).toBe("http://10.0.0.5:8188");
    expect(o.toolModeExplicit).toBe(false);
    expect(parseCliArgs([...base, "setup", "copilot", "--compact"], {}).toolModeExplicit).toBe(true);
    expect(parseCliArgs([...base, "setup", "hermes", "--tool-mode", "full"], {}).toolModeExplicit).toBe(true);
    // `setup` with no agent yields empty string so index.ts can print usage
    expect(parseCliArgs([...base, "setup"], {}).setupAgent).toBe("");
    expect(parseCliArgs([...base, "setup", "--dry-run"], {}).setupAgent).toBe("");
  });

  it("--insecure-bridge sets insecureBridge=true; COMFYUI_MCP_INSECURE_BRIDGE env works too", () => {
    expect(parseCliArgs(base, {}).insecureBridge).toBe(false);
    expect(parseCliArgs([...base, "--insecure-bridge"], {}).insecureBridge).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_INSECURE_BRIDGE: "1" }).insecureBridge).toBe(true);
    expect(parseCliArgs([...base, "connect", "https://pod.example.com"], {}).insecureBridge).toBe(false);
  });

  it("reads token from COMFYUI_MCP_HTTP_TOKEN env and --token flag (flag wins)", () => {
    expect(parseCliArgs(base, { COMFYUI_MCP_HTTP_TOKEN: "envtok" }).token).toBe("envtok");
    expect(parseCliArgs([...base, "--token", "flagtok"], { COMFYUI_MCP_HTTP_TOKEN: "envtok" }).token).toBe(
      "flagtok",
    );
    expect(parseCliArgs([...base, "--token=eq"], {}).token).toBe("eq");
  });

  it("--tunnel forces http transport and sets tunnel=true; MCP_TUNNEL env works too", () => {
    const o = parseCliArgs([...base, "--tunnel"], {});
    expect(o.tunnel).toBe(true);
    expect(o.transport).toBe("http");
    const e = parseCliArgs(base, { MCP_TUNNEL: "1" });
    expect(e.tunnel).toBe(true);
    expect(e.transport).toBe("http");
  });

  it("reads the unauthenticated escape hatch from flag and env", () => {
    expect(parseCliArgs(base, {}).allowUnauthenticated).toBe(false);
    expect(
      parseCliArgs([...base, "--allow-unauthenticated-non-loopback"], {}).allowUnauthenticated,
    ).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_ALLOW_UNAUTH: "1" }).allowUnauthenticated).toBe(true);
  });

  it("--panel-orchestrator enables orchestrator mode; env works too", () => {
    expect(parseCliArgs(base, {}).panelOrchestrator).toBe(false);
    expect(parseCliArgs([...base, "--panel-orchestrator"], {}).panelOrchestrator).toBe(true);
    expect(parseCliArgs(base, { COMFYUI_MCP_PANEL_ORCHESTRATOR: "1" }).panelOrchestrator).toBe(true);
    expect(parseCliArgs([...base, "--panel-orchestrator"], {})).toMatchObject({
      panelOrchestrator: true,
      token: undefined,
      tunnel: false,
    });
  });

  it("`connect <url>` implies panelOrchestrator and captures comfyuiUrl", () => {
    const o = parseCliArgs([...base, "connect", "https://abcd-8188.proxy.runpod.net"], {});
    expect(o.panelOrchestrator).toBe(true);
    expect(o.comfyuiUrl).toBe("https://abcd-8188.proxy.runpod.net");
    expect(o.transport).toBe("stdio");
  });

  it("`connect` with no URL is sugar for --panel-orchestrator (no comfyuiUrl)", () => {
    const o = parseCliArgs([...base, "connect"], {});
    expect(o.panelOrchestrator).toBe(true);
    expect(o.comfyuiUrl).toBeUndefined();
  });

  it("`connect` followed by a flag does not swallow the flag as a URL", () => {
    const o = parseCliArgs([...base, "connect", "--port", "9999"], {});
    expect(o.panelOrchestrator).toBe(true);
    expect(o.comfyuiUrl).toBeUndefined();
    expect(o.port).toBe(9999);
  });

  it("`connect <url>` still parses trailing flags", () => {
    const o = parseCliArgs([...base, "connect", "http://10.0.0.5:8188", "--port=9181"], {});
    expect(o.comfyuiUrl).toBe("http://10.0.0.5:8188");
    expect(o.port).toBe(9181);
  });

  it("no `connect` subcommand leaves comfyuiUrl undefined", () => {
    expect(parseCliArgs(base, {}).comfyuiUrl).toBeUndefined();
    expect(parseCliArgs([...base, "--panel-orchestrator"], {}).comfyuiUrl).toBeUndefined();
  });

  it("explicit --stdio flag overrides MCP_TRANSPORT=http env", () => {
    expect(parseCliArgs([...base, "--stdio"], { MCP_TRANSPORT: "http" }).transport).toBe("stdio");
  });

  it("explicit flags override env values", () => {
    const o = parseCliArgs([...base, "--port", "7000"], { MCP_PORT: "5000" });
    expect(o.port).toBe(7000);
  });
});

describe("exportExplicitToolMode (#667)", () => {
  // The panel orchestrator's spawned MCP children read the tool mode from the
  // ENV, so an explicit CLI choice must be exported before they spawn —
  // otherwise `--full --panel-orchestrator` silently ran compact downstream.
  it("exports an explicit --full so orchestrator children spawn the full surface", () => {
    const cli = parseCliArgs([...base, "--full", "--panel-orchestrator"], {});
    const env: NodeJS.ProcessEnv = {};
    exportExplicitToolMode(cli, env);
    expect(env.COMFYUI_MCP_TOOL_MODE).toBe("full");
  });

  it("exports an explicit --compact (and an explicit env mode survives parsing)", () => {
    const env: NodeJS.ProcessEnv = {};
    exportExplicitToolMode(parseCliArgs([...base, "--compact"], {}), env);
    expect(env.COMFYUI_MCP_TOOL_MODE).toBe("compact");
    const env2: NodeJS.ProcessEnv = {};
    exportExplicitToolMode(parseCliArgs(base, { COMFYUI_MCP_TOOL_MODE: "full" }), env2);
    expect(env2.COMFYUI_MCP_TOOL_MODE).toBe("full");
  });

  it("leaves the env UNSET when the mode was only defaulted (children apply their documented default)", () => {
    const env: NodeJS.ProcessEnv = {};
    exportExplicitToolMode(parseCliArgs(base, {}), env);
    expect("COMFYUI_MCP_TOOL_MODE" in env).toBe(false);
  });
});

describe("validateConnectUrl", () => {
  it("accepts a full http(s) URL (returns null)", () => {
    expect(validateConnectUrl("https://abcd-8188.proxy.runpod.net")).toBeNull();
    expect(validateConnectUrl("http://127.0.0.1:8188")).toBeNull();
    expect(validateConnectUrl("https://comfy.example.com/comfyapi")).toBeNull();
  });

  it("rejects a non-URL token with a clear, actionable error", () => {
    const err = validateConnectUrl("not-a-url");
    expect(err).not.toBeNull();
    expect(err).toContain("not-a-url");
    expect(err).toMatch(/http\(s\) URL/);
  });

  it("rejects a non-http(s) protocol", () => {
    expect(validateConnectUrl("ftp://example.com")).not.toBeNull();
    expect(validateConnectUrl("ws://127.0.0.1:8188")).not.toBeNull();
  });

  it("rejects an empty string", () => {
    expect(validateConnectUrl("")).not.toBeNull();
  });
});

/**
 * Pin the CLI's language for a block of assertions.
 *
 * Not optional hygiene: `renderCliHelp()` now runs every string through `tr()`, and `tr()`
 * resolves its locale from COMFYUI_MCP_LANG / LC_ALL / LC_MESSAGES / LANG. A contributor
 * whose shell is `LANG=ko_KR.UTF-8` — the entire audience this feature is for — would
 * otherwise get a red suite on an unmodified tree, and the `(active: …)` row makes that true
 * TODAY, before any catalog exists. COMFYUI_MCP_LANG is set rather than the others because
 * it wins the precedence chain outright, so one variable is enough to pin the answer.
 */
function pinLocale(locale: string): () => void {
  const prev = process.env.COMFYUI_MCP_LANG;
  process.env.COMFYUI_MCP_LANG = locale;
  __resetI18nForTest();
  return () => {
    if (prev === undefined) delete process.env.COMFYUI_MCP_LANG;
    else process.env.COMFYUI_MCP_LANG = prev;
    __resetI18nForTest();
  };
}

describe("--help (#860)", () => {
  let restore = () => {};
  beforeEach(() => {
    restore = pinLocale("en");
  });
  afterEach(() => restore());

  it("sets help for both --help and -h, and does not disturb other options", () => {
    for (const flag of ["--help", "-h"]) {
      const cli = parseCliArgs([...base, flag], {});
      expect(cli.help, `${flag} must set help`).toBe(true);
      // A help request must not look like a mode choice: `setup` uses
      // toolModeExplicit to tell "user chose a mode" from "use the per-agent
      // default", so a stray true here would change unrelated behaviour.
      expect(cli.toolModeExplicit).toBe(false);
      expect(cli.panelOrchestrator).toBe(false);
      expect(cli.setupAgent).toBeUndefined();
    }
  });

  it("is false when not asked for", () => {
    expect(parseCliArgs(base, {}).help).toBe(false);
    expect(parseCliArgs([...base, "--full"], {}).help).toBe(false);
  });

  it("prints the tool-mode default the PARSER actually uses, not a written-down one", () => {
    // The point of the whole change. `.env.example` claimed the tool mode
    // defaulted to `full` long after #667 made it `compact`, so a user reading it
    // configured the reverse of what they wanted — a confidently wrong default is
    // worse than a missing one. This fails the moment someone replaces the derived
    // value with a literal that has drifted.
    const actual = parseCliArgs(base, {}).toolMode;
    expect(renderCliHelp()).toContain(`env: COMFYUI_MCP_TOOL_MODE      (default: ${actual})`);
  });

  it("prints the host and port defaults the parser actually uses", () => {
    const cli = parseCliArgs(base, {});
    const help = renderCliHelp();
    expect(help).toContain(`(default: ${cli.host})`);
    expect(help).toContain(`(default: ${cli.port})`);
  });

  it("carries no tool COUNT — RFC #726 consolidates the surface and any number expires", () => {
    // Deliberately asserts an ABSENCE, because the failure mode is someone adding
    // "~200 tools" for helpfulness and it silently becoming false.
    expect(renderCliHelp()).not.toMatch(/\b\d{2,}\s*(tools|schemas)\b/i);
  });

  it("documents every flag the parser accepts", () => {
    // Discrimination: a flag added to the parser and not to the help is exactly
    // the undiscoverability this issue is about, so the test derives the list
    // rather than restating it.
    const help = renderCliHelp();
    for (const flag of [
      "--compact", "--full", "--tool-mode",
      "--stdio", "--http", "--transport", "--host", "--port",
      "--token", "--tunnel", "--allow-unauthenticated-non-loopback",
      "--panel-orchestrator", "--comfyui-url", "--insecure-bridge",
      "--help",
    ]) {
      expect(help, `${flag} must appear in --help`).toContain(flag);
    }
  });

  it("consumes --lang's value so it cannot be read as an operand", () => {
    // The parser stores nothing for `--lang` — processLocale() reads it off argv directly,
    // because the locale has to be resolved before this parser runs. But the VALUE still has
    // to be eaten: `connect` and `setup` both take their operand from the next bare token,
    // so a loose locale code sitting in argv is one keystroke away from being read as one.
    for (const argv of [
      [...base, "--lang", "ko", "setup", "hermes"],
      [...base, "--lang=ko", "setup", "hermes"],
    ]) {
      expect(parseCliArgs(argv, {}).setupAgent, argv.join(" ")).toBe("hermes");
    }
    // ...and the flag itself must not be mistaken for an operand either.
    expect(parseCliArgs([...base, "setup", "--lang", "ko"], {}).setupAgent).toBe("");
    expect(parseCliArgs([...base, "connect", "--lang", "ko"], {}).comfyuiUrl).toBeUndefined();
    expect(parseCliArgs([...base, "connect", "http://x:8188", "--lang", "ko"], {}).comfyuiUrl).toBe(
      "http://x:8188",
    );
  });

  it("documents --lang, the one flag parseCliArgs never sees", () => {
    // `--lang` is read straight out of argv by processLocale(), so the "every flag the
    // parser accepts" test above structurally cannot cover it — and a language switch
    // nobody can find is the same undiscoverability #860 was about.
    const help = renderCliHelp();
    expect(help).toContain("--lang <code>");
    expect(help).toContain("env: COMFYUI_MCP_LANG");
  });
});

describe("--help is translated, and degrades to English", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("renders the shipped catalog, and never a raw key", () => {
    // This test used to assert the OPPOSITE — that a Korean screen came back byte-identical
    // to English — because no catalog existed to render. That was the honest assertion then
    // and is a false one now: locales/ko/main.json ships, so the prose has to move.
    //
    // What survives the change is the pair that actually matters. The descriptions are the
    // reader's half and must be translated; the left column is what the user TYPES and must
    // not be. And a raw `cli.*` key on screen is the failure mode a missing fallback produces,
    // which no amount of translation should ever be able to cause.
    restore = pinLocale("en");
    const english = renderCliHelp();
    restore();
    restore = pinLocale("ko");
    const korean = renderCliHelp();

    // The parenthetical around the active locale is itself a translated key, so match the
    // row rather than the English sentence: `env: <VAR>` is typed, `ko` is the answer.
    expect(korean).toMatch(/env: COMFYUI_MCP_LANG {2,}\(\S+: ko\)/);
    expect(english).toContain("env: COMFYUI_MCP_LANG   (active: en)");
    expect(korean).not.toBe(english);
    expect(korean).toMatch(/[가-힣]/);
    expect(korean).not.toMatch(/\bcli\.[a-z_]+\b/);
    for (const typed of ["comfyui-mcp connect [<comfyui-url>]", "--tool-mode <compact|full>", "--host <host>", "env: MCP_PORT", "-h, --help"]) {
      expect(korean).toContain(typed);
    }
  });

  it("still falls back to English for a key no catalog carries", () => {
    // The degradation path, now that it can no longer be observed from the assembled screen.
    // Every release between a NEW `tr()` call site and its translation lives here, and the
    // guarantee is a complete English sentence rather than a key.
    expect(trFor("ko", "cli.help_not_a_real_key", "start the MCP server")).toBe("start the MCP server");
  });

  it("lays the two columns out in terminal CELLS, not characters", () => {
    // The mutation this catches: `padTo(...)` swapped for `String.prototype.padEnd`.
    //
    // Written when no catalog existed, at which point every string on the screen was ASCII, the
    // assembled output was IDENTICAL under both, and this helper was the ONLY place the
    // difference could be observed. Catalogs ship now, so the full-screen test above would also
    // notice — but only for the locales it happens to render. This stays because it isolates
    // the property (cells, not characters) from any particular translation.
    const ascii = helpRow("--host <host>", "HTTP bind host", "env: MCP_HOST");
    const korean = helpRow("--host <host>", "호스트", "env: MCP_HOST");
    expect(displayWidth(ascii.slice(0, ascii.indexOf("env:")))).toBe(
      displayWidth(korean.slice(0, korean.indexOf("env:"))),
    );
    // ...and prove the naive version would have disagreed here.
    expect(korean.indexOf("env:")).not.toBe(ascii.indexOf("env:"));
  });
});
