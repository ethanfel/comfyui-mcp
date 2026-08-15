/**
 * #1398 / #1353 — the one place that says where a code-mode agent's panel tools are.
 *
 * On a code-mode / deferred-tool client (the Codex backend) the panel tools are NOT
 * declared directly. They live in the `ALL_TOOLS` catalog under an `mcp__panel__`
 * prefix, so any instruction that says "look for a `panel_` tool" is followed
 * literally, finds nothing among the direct declarations, and licenses exactly the
 * wrong conclusion — while the panel MCP endpoint is answering `tools/list` with 91
 * tools and HTTP 200.
 *
 * #1353 fixed the message a caller gets when it CALLS a missing tool. It did not
 * fix the steering INJECTED into the system prompt, which is the surface the #1398
 * reporter actually followed: their agent concluded the live-canvas tools were
 * absent and went on to investigate rolling the product back two dozen versions.
 *
 * Two surfaces making the same claim in their own words is how one of them ends up
 * a version behind the other. They share this text now, so a third can too.
 */

/** The tool a reader is most likely to look for first, in both spellings. */
export const DEFERRED_PANEL_EXAMPLE = "panel_graph_outline";

/**
 * The prefixed name a deferred catalog actually holds. Built rather than written
 * out so the prefix appears once: the namespace is `mcp__<server>__`, and the panel
 * MCP server is registered as `panel` (see PANEL_NAMESPACE_RE in tools/compact.ts,
 * which strips exactly this shape off an incoming call).
 */
export const DEFERRED_PANEL_PREFIX = "mcp__panel__";

/** `mcp__panel__panel_graph_outline` — the string a search must match. */
export const DEFERRED_PANEL_QUALIFIED_NAME = `${DEFERRED_PANEL_PREFIX}${DEFERRED_PANEL_EXAMPLE}`;

/**
 * The caveat, phrased to be dropped into a longer sentence about absence.
 *
 * Deliberately names BOTH the catalog and the exact string to look for. "Check your
 * deferred tools" is not enough: the reporter's agent did inspect its tools, and the
 * thing it needed was the spelling.
 */
export const DEFERRED_PANEL_TOOLS_NOTE =
  `A code-mode/deferred-tool client (e.g. the Codex backend) does NOT declare these ` +
  `directly — it lists them in its deferred catalog (\`ALL_TOOLS\`) under an MCP prefix, ` +
  `so the name to look for is \`${DEFERRED_PANEL_QUALIFIED_NAME}\`, not ` +
  `\`${DEFERRED_PANEL_EXAMPLE}\`. Search that catalog too, and if it is there, call it ` +
  `through the nested tools namespace.`;

/**
 * The same caveat as a standalone instruction for the INJECTED steering, where it has
 * to carry its own "before you conclude anything" framing rather than continuing a
 * sentence about a specific failed call.
 */
export const DEFERRED_PANEL_TOOLS_STEERING =
  `FINDING THESE TOOLS: if you cannot see a \`${DEFERRED_PANEL_EXAMPLE}\`-style name among ` +
  `your directly declared tools, you have NOT established that the live-canvas tools are ` +
  `missing. ${DEFERRED_PANEL_TOOLS_NOTE} Only when BOTH your direct declarations and your ` +
  `deferred catalog hold nothing matching \`panel_\` may you say the live-canvas tools are ` +
  `unavailable — and never treat their apparent absence as a product fault to diagnose, ` +
  `downgrade, or roll back.`;

/**
 * Guarantee the guidance survives a persona OVERRIDE (codex review, #1398 P1).
 *
 * The default persona interpolates the steering, but the persona is resolved through
 * `resolvePrompt("panel.persona", …)`: a locale translation or a user override
 * replaces the WHOLE string, silently taking this with it — and a non-English or
 * customized deployment then reproduces #1398 exactly, with the fix apparently
 * shipped. The guidance is about the SPELLING of a tool name, which is the same in
 * every language, so it belongs outside anything translatable.
 *
 * Idempotent, keyed on the WHOLE steering rather than on the tool name (codex round
 * 2, P1). Keying on the name alone meant a persona that merely MENTIONS
 * `mcp__panel__panel_graph_outline` — a user override naming the tool, a translation
 * that keeps identifiers verbatim — was returned unchanged and never received the
 * catalog, the namespace, or the do-not-diagnose-a-rollback part. That persona then
 * reproduces #1398 while looking, to this function, like it already had the fix.
 */
export function withDeferredPanelToolsNote(persona: string): string {
  if (persona.includes(DEFERRED_PANEL_TOOLS_STEERING)) return persona;
  return `${persona}

${DEFERRED_PANEL_TOOLS_STEERING}`;
}
