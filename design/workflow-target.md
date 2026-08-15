# Per-workflow agent targeting

## Problem

Each ComfyUI browser tab connects to the orchestrator with a `tab_id`, but ComfyUI can have **multiple workflow tabs** open inside that browser tab. Graph tools (`graph_get_state`, `graph_add_node`, …) default to whichever workflow the user is **currently viewing**. If the user switches workflow tabs while the agent is working, edits land on the wrong graph.

## Solution

The orchestrator keeps a per-`tab_id` **workflow target**:

| mode | behavior |
|------|----------|
| `current` | Graph tools follow the user's active workflow tab (default) |
| `pinned` | Graph tools include `workflow_path` on scoped commands. The pin **must target the active canvas at pin time** — see the constraint below |

### Active-canvas constraint (#556/#571)

The panel has **no way to read or mutate a non-active workflow's graph**: every graph executor runs against `app.canvas.graph`, and the panel's pinned-target guard (#349/#186) **fails closed** with a "workflow mismatch" error whenever an injected `workflow_path` is not the workflow currently in view. Background editing of a non-active tab is therefore **not supported**.

Consequently a pin is only honorable when its target is the active canvas. `panel_set_workflow_target` (and the panel-driven `set_workflow_target` event) **validate at pin time** via `resolvePinTarget` and:

- **fail closed** if the workflow isn't open (#259),
- **fail at pin time** if it is open but not the active canvas (#556/#571) — never accept-then-defer,
- canonicalize an honorable pin to the workflow's stable `key`.

The injected `workflow_path` then acts as a **guard**: if the user later switches away, the next graph command fails loudly instead of silently editing the wrong graph.

### Orchestrator API

- **MCP tools:** `panel_get_workflow_target`, `panel_set_workflow_target`
- **Bridge event (panel → orchestrator):** `{ type: "set_workflow_target", tab_id, mode, path?, filename? }`
- **Bridge push (orchestrator → panel):** `{ type: "workflow_target", target }`
- **Ack:** `{ type: "ack", ok, kind: "workflow_target", target? }`

### Command injection

When pinned, the orchestrator adds `workflow_path` to:

- All `graph_*` commands
- `workflow_save`, `workflow_save_as`, `workflow_rename`, `workflow_close` when `path` is omitted

Never injected on: `workflow_list`, `workflow_new`, `workflow_open`.

### Panel implementation (comfyui-mcp-panel)

Graph executors run against the **active canvas** (`app.canvas.graph`); the panel cannot address a non-active workflow document. So each executor:

1. Reads optional `workflow_path` on the incoming `{ rid, cmd, … }` frame.
2. Treats it as a **guard**: if `workflow_path` does not identify the active canvas, it **fails closed** with a retryable "workflow mismatch" error (#349/#186) — it never blindly mutates the active graph under a mismatched pin.
3. Otherwise applies the mutation on the active canvas.

Because background editing is not possible, the orchestrator rejects a background pin **at pin time** (see the active-canvas constraint above) so the mismatch guard is only ever a last line of defense (e.g. the user switches tabs after a valid pin), not the normal failure path.

## Files

- `src/services/workflow-target-store.ts` — store + injection helper
- `src/orchestrator/panel-tools.ts` — MCP tools + `makePanelToolCtx` injection
- `src/orchestrator/index.ts` — bridge handler + hello sync