# Agent platform roadmap

Extend comfyui-mcp orchestrator + panel with multi-provider agents, cross-provider image sourcing, and autonomous infra management.

## Phase 0 — Per-workflow agent (done in comfyui-mcp)

- `WorkflowTargetStore` + `workflow_path` injection on graph commands
- MCP: `panel_get_workflow_target`, `panel_set_workflow_target`
- Bridge: `set_workflow_target` / `workflow_target` sync
- **Panel follow-up:** honor `workflow_path` in graph executors ([workflow-target.md](./workflow-target.md))

## Phase 1 — Grok backend (P0)

- `GrokBackend` implementing `AgentBackend` (OAuth via Grok Build / xAI CLI)
- Add `grok` to `BackendId`, readiness probe, panel provider chip
- Spike: auth token location, chat/tool wire format, MCP over HTTP parity

## Phase 2 — Cross-provider concept images (P1)

- `fetch_concept_image` — Grok Imagine / Google image gen → temp files
- `apply_reference_to_workflow` — wire refs into LoadImage / Qwen edit / Krea img2img nodes
- Skill: structure-map → Qwen/Krea pipeline

## Phase 3 — AI Toolkit supervisor (P2)

- Process supervisor for local AI Toolkit installs (start/stop, job queue, health)
- MCP tools: `toolkit_status`, `toolkit_run_job`, `toolkit_list_models`

## Phase 4 — RunComfy connector (P3)

- API recon for RunComfy pod lifecycle
- Tools: `runcomfy_list_pods`, `runcomfy_sync_workflow`, `runcomfy_queue`

## Phase 5 — Multi-workflow projects (P4)

- YAML project manifest (ordered workflows, shared assets)
- `run_workflow_pipeline` — execute stages with per-workflow pins

## Notes

- **Google AI Pro:** Gemini agent backend exists; image gen is a separate provider layer, not a new agent backend.
- **Panel repo:** UI for workflow picker binds to `set_workflow_target`; graph executors must respect `workflow_path`.
- **Do not replace comfyui-mcp-panel** — it remains the UI; this repo owns orchestration + MCP tools.