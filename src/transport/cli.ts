import { parseComfyUIUrl } from "./comfyui-url.js";
import { tr, processLocale } from "../i18n/index.js";
import { padTo } from "../i18n/terminal-layout.js";

export type TransportMode = "stdio" | "http";
export type ToolMode = "full" | "compact";

export interface CliOptions {
  /** --help / -h: print usage and exit WITHOUT starting a server. There was no
   *  help flag at all, so nothing at the CLI taught `--compact` / `--full` —
   *  and compact became the DEFAULT in #667, meaning the behaviour changed under
   *  users with no local way to discover the flag that controls it (#860). */
  help: boolean;
  transport: TransportMode;
  /** --full / --tool-mode full / COMFYUI_MCP_TOOL_MODE=full (DEFAULT since
   *  0.50.0): register the direct tool surface.
   *
   *  Compact was the default from #667 only because the surface was too big to
   *  ship: ~200 schemas cost a client ~200KB (~50k tokens) on every tools/list,
   *  which harnesses that inject schemas into context pay on every read. The
   *  0.50.0 consolidation folded 154 names into 37 action-parameterized tools,
   *  so the same read is now roughly a fifth of that — a reasonable default for
   *  a frontier harness, and the owner's stated goal ("get the tool count down,
   *  then make --compact the optional one").
   *
   *  --compact / COMFYUI_MCP_TOOL_MODE=compact opts INTO the three
   *  list_tools/describe_tool/call_tool meta-tools, which is still the right
   *  choice for small local models (#97) — and remains the DEFAULT on the two
   *  lanes that serve them, deliberately diverging from this one. See
   *  resolveHttpLaneComfyToolMode and comfyuiSpawnEnv. */
  toolMode: ToolMode;
  host: string;
  port: number;
  /** --panel-orchestrator: run the standalone background orchestrator that owns
   *  the UI bridge and drives the panel with autonomous Agent SDK sessions
   *  (subscription auth, no API key). Mutually exclusive with the MCP server. */
  panelOrchestrator: boolean;
  /** Shared-secret token required on the HTTP /mcp endpoint when set
   *  (COMFYUI_MCP_HTTP_TOKEN). Undefined → endpoint is open (local default). */
  token?: string;
  /** --tunnel / MCP_TUNNEL=1: force http transport, auto-generate a token if
   *  none set, and open a cloudflared quick tunnel to the local port so the
   *  /mcp endpoint is reachable as a hosted/remote Custom Connector. */
  tunnel: boolean;
  /** --allow-unauthenticated-non-loopback / COMFYUI_MCP_ALLOW_UNAUTH=1: opt into
   *  an OPEN /mcp endpoint on a non-loopback host (otherwise a hard fail). */
  allowUnauthenticated: boolean;
  /** ComfyUI target URL captured from the `connect <comfyui-url>` subcommand.
   *  When set, startup exports it as COMFYUI_URL so the panel orchestrator drives
   *  that (possibly REMOTE, e.g. RunPod) ComfyUI from the agent running on THIS
   *  machine — no Node/agent needed on the ComfyUI box. Undefined when `connect`
   *  wasn't used (or used without a URL). `connect` also implies panelOrchestrator. */
  comfyuiUrl?: string;
  /** `setup <agent>` subcommand: merge a ready-to-run comfyui server entry into
   *  a non-Claude harness's own config file (hermes | openclaw | copilot), then
   *  exit — never starts the MCP server. Issue #97. */
  setupAgent?: string;
  /** --dry-run (setup only): print the merged config instead of writing it. */
  setupDryRun: boolean;
  /** Whether --compact/--tool-mode was passed explicitly (vs defaulted): lets
   *  `setup` distinguish "user chose a mode" from "use the per-agent default". */
  toolModeExplicit: boolean;
  /** --insecure-bridge / COMFYUI_MCP_INSECURE_BRIDGE=1: force the plain loopback
   *  `ws://127.0.0.1:<port>` bridge even when driving a REMOTE https ComfyUI.
   *  By default a remote-https target auto-upgrades the bridge to a token-gated
   *  `wss://` (cloudflared quick tunnel) so the pod's HTTPS panel page can reach
   *  it (a plain ws:// from https is blocked by the browser). Use this if you run
   *  your own SSH tunnel / reverse proxy and don't want a Cloudflare tunnel. */
  insecureBridge: boolean;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9100;

/**
 * Parse transport-related CLI flags and env vars. stdio is the default so
 * existing Claude Code / Desktop users are unaffected; --http opts into the
 * streamable-HTTP server. Supports both "--flag value" and "--flag=value".
 *
 * Precedence: explicit CLI flag > env var > built-in default.
 */
export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const args = argv.slice(2);

  let help = false;
  let transport: TransportMode = env.MCP_TRANSPORT === "http" ? "http" : "stdio";
  // 0.50.0 flip: full is the default, compact is the opt-in. Only the exact
  // string "compact" selects it, so a typo'd value falls back to the default
  // exactly as a typo'd value used to fall back to compact.
  let toolMode: ToolMode = env.COMFYUI_MCP_TOOL_MODE === "compact" ? "compact" : "full";
  let host = env.MCP_HOST ?? DEFAULT_HOST;
  let port = env.MCP_PORT ? Number(env.MCP_PORT) : DEFAULT_PORT;
  let panelOrchestrator =
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "1" ||
    env.COMFYUI_MCP_PANEL_ORCHESTRATOR === "true";
  let token = env.COMFYUI_MCP_HTTP_TOKEN?.trim() || undefined;
  let tunnel = env.MCP_TUNNEL === "1" || env.MCP_TUNNEL === "true";
  let allowUnauthenticated =
    env.COMFYUI_MCP_ALLOW_UNAUTH === "1" || env.COMFYUI_MCP_ALLOW_UNAUTH === "true";
  let insecureBridge =
    env.COMFYUI_MCP_INSECURE_BRIDGE === "1" || env.COMFYUI_MCP_INSECURE_BRIDGE === "true";
  let comfyuiUrl: string | undefined;
  let setupAgent: string | undefined;
  let setupDryRun = false;
  let toolModeExplicit =
    env.COMFYUI_MCP_TOOL_MODE === "compact" || env.COMFYUI_MCP_TOOL_MODE === "full";

  const valueOf = (current: string, inline: string, i: number): [string, number] => {
    if (current.includes("=")) return [current.slice(current.indexOf("=") + 1), i];
    return [args[i + 1] ?? "", i + 1];
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "connect") {
      // `comfyui-mcp connect <comfyui-url>` — one-command local connect: run the
      // panel orchestrator (subscription auth, no API key) and point it at the
      // given ComfyUI via COMFYUI_URL. The URL is the next positional token (a
      // following "--flag" is left to be parsed normally). With no URL it's just
      // sugar for --panel-orchestrator (local default / inherited COMFYUI_URL).
      panelOrchestrator = true;
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        comfyuiUrl = next;
        i += 1; // consume the URL token
      }
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--http") {
      transport = "http";
    } else if (a === "--stdio") {
      transport = "stdio";
    } else if (a === "--transport" || a.startsWith("--transport=")) {
      const [v, ni] = valueOf(a, "--transport", i);
      transport = v === "http" ? "http" : "stdio";
      i = ni;
    } else if (a === "--host" || a.startsWith("--host=")) {
      const [v, ni] = valueOf(a, "--host", i);
      if (v) host = v;
      i = ni;
    } else if (a === "--port" || a.startsWith("--port=")) {
      const [v, ni] = valueOf(a, "--port", i);
      if (v) port = Number(v);
      i = ni;
    } else if (a === "--panel-orchestrator") {
      panelOrchestrator = true;
    } else if (a === "--token" || a.startsWith("--token=")) {
      const [v, ni] = valueOf(a, "--token", i);
      if (v) token = v;
      i = ni;
    } else if (a === "--tunnel") {
      tunnel = true;
    } else if (a === "--allow-unauthenticated-non-loopback") {
      allowUnauthenticated = true;
    } else if (a === "--insecure-bridge") {
      insecureBridge = true;
    } else if (a === "--compact") {
      toolMode = "compact";
      toolModeExplicit = true;
    } else if (a === "--full") {
      toolMode = "full";
      toolModeExplicit = true;
    } else if (a === "--tool-mode" || a.startsWith("--tool-mode=")) {
      const [v, ni] = valueOf(a, "--tool-mode", i);
      // Inverted with the 0.50.0 default: only the exact string "compact"
      // selects compact, so `--tool-mode bogus` falls back to the default, which
      // is what it always did — the default just changed under it.
      toolMode = v === "compact" ? "compact" : "full";
      toolModeExplicit = true;
      i = ni;
    } else if (a === "setup") {
      // `comfyui-mcp setup <agent>` — write the comfyui MCP entry into a
      // non-Claude harness's config (hermes | openclaw | copilot) and exit.
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        setupAgent = next;
        i += 1;
      } else {
        setupAgent = ""; // present but missing the agent → index.ts prints usage
      }
    } else if (a === "--lang" || a.startsWith("--lang=")) {
      // Recognised here ONLY so its value token cannot be mistaken for a positional. The
      // value itself is read by processLocale() straight off argv, because the locale has to
      // be known before this parser runs — `--help` is rendered in it, and so is the error
      // this parser's own callers print. Skipping the case entirely (which is what happened
      // when `--lang` was introduced) leaves a bare locale code loose in argv, in the same
      // stream where `connect` and `setup` read their operands off the next token.
      const [, ni] = valueOf(a, "--lang", i);
      i = ni;
    } else if (a === "--dry-run") {
      setupDryRun = true;
    } else if (a === "--comfyui-url" || a.startsWith("--comfyui-url=")) {
      // Also parsed by config.ts for the server itself; captured here so
      // `setup` can embed it into the generated harness config.
      const [v, ni] = valueOf(a, "--comfyui-url", i);
      if (v) comfyuiUrl = v;
      i = ni;
    }
  }

  // --tunnel implies the HTTP transport: a cloudflared quick tunnel needs an
  // HTTP origin to point at. (Token auto-generation happens at startup, not
  // here, to keep this parser pure/side-effect-free.)
  if (tunnel) transport = "http";

  return {
    help,
    transport,
    toolMode,
    toolModeExplicit,
    host,
    port,
    panelOrchestrator,
    token,
    tunnel,
    allowUnauthenticated,
    comfyuiUrl,
    insecureBridge,
    setupAgent,
    setupDryRun,
  };
}

/**
 * Propagate an explicitly-chosen tool mode into the process environment so the
 * panel orchestrator's spawned MCP children inherit it (#667). Children read
 * the mode from the ENV (resolveHttpLaneComfyToolMode for the HTTP lane,
 * comfyuiSpawnEnv for the Ollama family) — a bare --full/--compact flag
 * otherwise never reaches them, so `--full --panel-orchestrator` silently ran
 * compact downstream. A DEFAULTED mode is deliberately NOT exported: unset env
 * is how children tell "user chose nothing" from "user chose compact".
 *
 * The 0.50.0 flip changed what unset MEANS, and the distinction now carries
 * real weight rather than being a tidiness argument. Before, unset resolved to
 * compact everywhere, so exporting or not exporting a defaulted mode was
 * unobservable. Now the top-level default is FULL while both child lanes still
 * default to COMPACT on purpose — the HTTP lane shares its tool budget with ~91
 * `panel_*` tools, and the Ollama lane feeds a small local model's 16k context
 * (#97). Not exporting a defaulted mode is what lets those lanes keep their own
 * default; exporting it would silently push the full surface into exactly the
 * two places compact exists to protect. An EXPLICIT --full still reaches them,
 * which is the documented way to opt a child lane in.
 */
export function exportExplicitToolMode(
  cli: Pick<CliOptions, "toolMode" | "toolModeExplicit">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (cli.toolModeExplicit) env.COMFYUI_MCP_TOOL_MODE = cli.toolMode;
}

/**
 * Validate the `connect <comfyui-url>` positional before the orchestrator starts.
 * The URL is exported as COMFYUI_URL and used to drive a (possibly remote)
 * ComfyUI, so a bad value (e.g. `connect not-a-url`) must hard-fail instead of
 * silently falling back to the local default — which would leave the startup
 * banner claiming it's "Driving <bad url>" while actually targeting localhost.
 *
 * Reuses parseComfyUIUrl (the same parser COMFYUI_URL / --comfyui-url use) so the
 * accept/reject rules stay identical. Returns a clear, actionable error message
 * when the URL is invalid, or null when it parses cleanly.
 */
export function validateConnectUrl(url: string): string | null {
  try {
    parseComfyUIUrl(url);
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Translated because this string IS the body of the fatal "cannot start" line the user
    // reads in their terminal; translating the frame and leaving the reason English would
    // produce a half-English sentence at the one moment the tool is refusing to run. The
    // example URLs stay verbatim — they are things to copy, not things to read.
    return tr(
      "cli.connect_url_invalid",
      'Invalid ComfyUI URL passed to `connect`: "{url}" ({reason}). ' +
        "Pass a full http(s) URL, e.g. https://abcd-8188.proxy.runpod.net or http://127.0.0.1:8188.",
      { url, reason },
    );
  }
}

/** Cell column where `--help` descriptions start, and where the trailing `env:` notes start. */
const DESC_COL = 45;
const ENV_COL = 65;

/**
 * One `--help` row: `left` is the flag/subcommand (never translated), `desc` the prose,
 * `tail` an optional `env: …` note that keeps its own column.
 *
 * The gap used to be typed into the string literal, which is a layout that survives exactly
 * as long as every description is English. This computes it from the DISPLAY WIDTH of
 * whatever actually lands in the column, so a Korean description — two terminal cells per
 * character — does not shove the `env:` notes off their column.
 *
 * The `3` minimum separator is not decoration: it is what keeps an entry whose description
 * overruns its column readable, and it is what reproduces the previous hand-typed layout
 * exactly (`--token` and `--tunnel` already sat three spaces from their `env:` note).
 *
 * Exported only so a test can hand it a Korean description. The whole screen renders English
 * until a catalog exists, so nothing about the ASSEMBLED output can show whether the columns
 * are computed in cells or in characters — the two agree for every string that exists today.
 */
export function helpRow(left: string, desc: string, tail?: string): string {
  const body = tail ? padTo(desc, ENV_COL - DESC_COL, 3) + tail : desc;
  return `  ${padTo(left, DESC_COL - 2)}${body}`.trimEnd();
}

/**
 * Usage text for `--help` / `-h`.
 *
 * Every default shown is DERIVED by parsing an empty argv against an empty env,
 * not restated. That is the whole point: a hand-written default is a claim that
 * drifts the moment the parser changes, and this repo has just spent a release
 * cycle on documentation that confidently asserted the opposite of the code —
 * `.env.example` said the tool mode defaulted to `full` when #667 had made it
 * `compact`, and a user reading it configured the reverse of what they wanted.
 * Deriving makes that class of drift impossible rather than unlikely.
 *
 * Deliberately carries NO tool COUNT. RFC #726 consolidates the surface to ~30
 * tools, so any number written here expires; the text describes the shapes
 * instead ("three meta-tools" is a property of the facade, not a census).
 *
 * TRANSLATED, PROSE ONLY. The left-hand column is flags and subcommands — what the user has
 * to type, identical in every language — so only the descriptions go through `tr()`, and
 * `helpRow` above owns the alignment that used to live in the string literals.
 */
export function renderCliHelp(): string {
  const d = parseCliArgs([], {});
  // The whole parenthetical is one key, not the word "default" glued to a value. A lone
  // adjective is the classic untranslatable unit — several of our languages inflect it by
  // what follows — and the value itself is a machine token that must not be touched.
  const def = (v: string | number | boolean) =>
    tr("cli.help_default", "(default: {value})", { value: String(v) });

  return [
    "",
    `comfyui-mcp — ${tr("cli.help_tagline", "drive ComfyUI from an AI agent")}`,
    "",
    tr("cli.help_section_usage", "USAGE"),
    helpRow("comfyui-mcp [options]", tr("cli.help_usage_server", "start the MCP server")),
    helpRow(
      "comfyui-mcp connect [<comfyui-url>]",
      tr("cli.help_usage_connect", "run the panel orchestrator against a (possibly remote) ComfyUI"),
    ),
    helpRow("comfyui-mcp setup <hermes|openclaw|copilot> [--compact|--full] [--comfyui-url <url>] [--dry-run]", ""),
    helpRow("", tr("cli.help_usage_setup", "write the comfyui entry into that harness's config, then exit")),
    "",
    tr("cli.help_section_tool_surface", "TOOL SURFACE"),
    helpRow(
      "--compact",
      `${tr("cli.help_compact", "register only the three meta-tools")} ${def(d.toolMode === "compact")}`,
    ),
    // Not translated: three tool NAMES the user will type or read in a client.
    helpRow("", "(list_tools / describe_tool / call_tool)"),
    helpRow("--full", tr("cli.help_full", "register the full direct tool surface")),
    helpRow("--tool-mode <compact|full>", tr("cli.help_same_as_value", "same, as a value")),
    helpRow("", `env: COMFYUI_MCP_TOOL_MODE      ${def(d.toolMode)}`),
    "",
    tr("cli.help_section_transport", "TRANSPORT"),
    helpRow(
      "--stdio",
      `${tr("cli.help_stdio", "stdio transport")} ${def(d.transport === "stdio")}`,
    ),
    helpRow("--http", tr("cli.help_http", "streamable-HTTP transport")),
    helpRow("--transport <stdio|http>", tr("cli.help_same_as_value", "same, as a value"), "env: MCP_TRANSPORT"),
    helpRow("--host <host>", tr("cli.help_host", "HTTP bind host"), `env: MCP_HOST   ${def(d.host)}`),
    helpRow("--port <port>", tr("cli.help_port", "HTTP bind port"), `env: MCP_PORT   ${def(d.port)}`),
    helpRow(
      "--token <token>",
      tr("cli.help_token", "require this shared secret on /mcp"),
      "env: COMFYUI_MCP_HTTP_TOKEN",
    ),
    helpRow(
      "--tunnel",
      tr("cli.help_tunnel", "open a cloudflared quick tunnel (implies --http)"),
      "env: MCP_TUNNEL",
    ),
    helpRow(
      "--allow-unauthenticated-non-loopback",
      tr("cli.help_allow_unauth", "allow an OPEN /mcp on a non-loopback host"),
    ),
    "",
    tr("cli.help_section_panel", "PANEL / COMFYUI"),
    helpRow(
      "--panel-orchestrator",
      tr("cli.help_panel_orchestrator", "run the background orchestrator that drives the panel"),
    ),
    helpRow(
      "--comfyui-url <url>",
      tr("cli.help_comfyui_url", "target a specific (incl. remote) ComfyUI"),
      "env: COMFYUI_URL",
    ),
    helpRow("--insecure-bridge", tr("cli.help_insecure_bridge", "allow an unauthenticated panel bridge")),
    "",
    // `--lang` is parsed straight out of argv by processLocale(), not by parseCliArgs, so it
    // is the one flag that would otherwise be undiscoverable from the tool it controls.
    //
    // ACTIVE, not "default", and that word is load-bearing. Every other value on this screen
    // comes from `parseCliArgs([], {})` — a built-in default, deliberately blind to the
    // environment. The language is the opposite: it is resolved FROM the environment through
    // four variables and a fallback chain, so the only answer worth printing is the one the
    // user is actually getting. Calling that a "default" would be false the moment they pass
    // the flag this very row documents.
    helpRow(
      "--lang <code>",
      tr("cli.help_lang", "language for this CLI's own output"),
      `env: COMFYUI_MCP_LANG   ${tr("cli.help_active", "(active: {locale})", { locale: processLocale() })}`,
    ),
    helpRow("-h, --help", tr("cli.help_help", "show this and exit")),
    "",
    tr("cli.help_full_reference", "Full reference: {url}", {
      url: "https://github.com/artokun/comfyui-mcp#readme",
    }),
    "",
  ].join("\n");
}
