# RunComfy connector

Headless control of [RunComfy](https://www.runcomfy.com/) dedicated ComfyUI machines (pods) via the **Server API**, plus queueing workflows on a pod's live ComfyUI backend.

## Environment

| Variable | Purpose |
|----------|---------|
| `RUNCOMFY_API_KEY` | Bearer token (RunComfy dashboard → API keys) |
| `RUNCOMFY_USER_ID` | Your user UUID (required in Server API paths) |
| `RUNCOMFY_API_BASE` | Optional override (default `https://beta-api.runcomfy.net`) |

## MCP tools

- **`runcomfy_list_pods`** — `GET /prod/api/users/:user/servers`. Lists pods with `server_id`, `current_status`, `main_service_url`, `workflow_version_id`.
- **`runcomfy_sync_workflow`** — `GET /prod/api/users/:user/workflows`. Lists cloud workflows and `workflow_version_id` values. Optional `local_workflow_path` name-matches a local JSON file to a cloud workflow.
- **`runcomfy_queue`** — POST workflow to a pod's `main_service_url/prompt`. Use `server_id` or `main_service_url` for an existing pod, or `workflow_version_id` to launch then queue (polls until ComfyUI responds).

## Queue flow

1. `runcomfy_sync_workflow` → pick `latest_version_id` / `matched_version_id`
2. `runcomfy_queue` with `workflow_version_id` + `workflow` or `workflow_path` (launches pod if needed)
3. Or `runcomfy_list_pods` → reuse `server_id` when `main_service_url` is ready

UI workflows are converted with `convertUiToApi` using the pod's remote `/object_info`.

## Serverless API

RunComfy also offers serverless deployments at `https://api.runcomfy.net` (`/prod/v2/deployments/.../inference`). This phase targets **dedicated pods** (Server API) per the roadmap; serverless can be a follow-up.

## Related

- Phase 3: [ai-toolkit-supervisor.md](./ai-toolkit-supervisor.md) (local training UI)
- [agent-platform-roadmap.md](./agent-platform-roadmap.md)