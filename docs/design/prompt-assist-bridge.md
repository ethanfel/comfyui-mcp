# Prompt-assist bridge

The prompt-assist bridge is a narrow product-integration lane for browser UI
components that want agent help with text but must not join the ComfyUI sidebar
conversation or receive the sidebar agent's graph tools.

The first consumer is MiniMax H3's Scene Prompt Editor. Each editor opens its
own WebSocket route and identifies its connection with:

```json
{
  "type": "hello",
  "tab_id": "prompt-assistant:<browser-uuid>",
  "tab_session_id": "<browser-uuid>",
  "headless": true,
  "client_kind": "prompt_assistant"
}
```

The WebSocket bridge registers this as an auxiliary route rather than a panel
tab, and the orchestrator handles its hello before the ordinary panel hello
path. It therefore does not appear in tab lists, affect default graph routing,
retarget ComfyUI, select or start a sidebar backend, modify the shared
`orchestrator::<provider>` session, synchronize the panel pack, receive shared
agent output, or advertise graph commands. The response is
`prompt_assist_ready` with prompt-lane provider availability.

## Request and result

Requests are correlated and carry an opaque source revision:

```json
{
  "type": "prompt_assist_request",
  "request_id": "pa-uuid",
  "conversation_id": "h3-browser-uuid",
  "provider": "codex",
  "mode": "continuity",
  "instruction": "Make the ending hand useful motion into scene 4.",
  "source_revision": "scene-3:415:deadbeef",
  "context": {
    "generation_mode": "h3_chain_scene",
    "scene_id": "scene-3",
    "scene_index": 2,
    "scene_count": 8,
    "source_prompt": "...",
    "selected_text": "...",
    "shared_prompt": "...",
    "previous_prompt": "...",
    "next_prompt": "..."
  }
}
```

The server emits `prompt_assist_started`, throttled
`prompt_assist_progress`, and one terminal frame:

- `prompt_assist_result` with separate `message` and `rewritten_prompt` fields;
- `prompt_assist_error` with an actionable error;
- `prompt_assist_cancelled` after a correlated cancellation.

The source revision is echoed, not interpreted by the server. The editor owns
the live source text and must compare it before Apply. A result is always a
draft; the bridge has no operation that edits a Plan or graph.

`prompt_assist_cancel`, `prompt_assist_reset`, and `prompt_assist_close` stop a
turn, clear the named bounded transcript, and retire a client respectively.
Only one request per client route may run at once.

## Provider isolation

Codex uses the existing app-server backend with prompt-lane overrides:

- `sandbox: "read-only"`;
- `mcp_servers={}` so user and ComfyUI MCP servers are not inherited;
- an ephemeral thread;
- a strict structured-output schema;
- immediate refusal if a tool call is nevertheless observed.

Hermes uses `hermes --oneshot` with the valid, normally-empty
`context_engine` toolset, workspace rules disabled, and an ephemeral system
prompt that prohibits tools and graph/file actions. The user's configured
model/provider and credentials remain authoritative. A persistent Hermes ACP
adapter can replace this runner later without changing the browser protocol.

Recent conversation is stored only in the orchestrator process, bounded to ten
items, and keyed by client route, conversation id, and provider. It is not
serialized into the ComfyUI workflow. Provider switching therefore preserves
separate Codex and Hermes prompt conversations without mixing either into the
sidebar agent.

## Remote ComfyUI

A local HTTP ComfyUI can use the panel's stored/default loopback bridge. An
HTTPS-hosted ComfyUI must first use the panel pack's
`/comfyui_mcp_panel/bridge_url` discovery route so it receives the advertised,
token-gated `wss://` URL from the local orchestrator.

## Deliberate non-goals

This lane does not attach to an already-running interactive terminal agent,
scrape a PTY, share a sidebar conversation, or give a rewrite request implicit
permission to run the graph. A later console companion should use explicit MCP
resources/tools and leases rather than weakening this browser lane.
