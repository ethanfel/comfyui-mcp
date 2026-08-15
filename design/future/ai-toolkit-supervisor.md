# AI Toolkit supervisor

Headless control of a local [ostris AI-Toolkit](https://github.com/ostris/ai-toolkit) install via its Next.js UI API (port **8675**).

## Environment

| Variable | Purpose |
|----------|---------|
| `AI_TOOLKIT_ROOT` | Install root (`run.py` + `ui/`). Auto-detects `~/ai-toolkit`, `/workspace/ai-toolkit`, etc. |
| `AI_TOOLKIT_PORT` | UI port (default `8675`) |
| `AI_TOOLKIT_URL` | Full base URL (overrides port), e.g. `https://pod-8675.proxy.runpod.net` |
| `AI_TOOLKIT_AUTH` | When set on the toolkit UI, send `Authorization: Bearer <token>` on `/api/*` |

## MCP tools

- **`toolkit_status`** — `action`: `probe` (default), `start`, `stop`, `restart`. Returns running PID, API reachability, `/api/gpu`, jobs, queues.
- **`toolkit_list_models`** — Scans `config/examples/*.yaml` for `arch` and `model.name_or_path`.
- **`toolkit_run_job`** — `name` + `job_config` or `config_path`; creates job, calls `/api/jobs/{id}/start`, starts queue worker for `gpu_ids`.

## Start flow

`toolkit_status` with `action=start` runs `npm run start` in `{AI_TOOLKIT_ROOT}/ui` (Next.js + cron worker), same as a manual UI launch after `npm run build`.

## Related

- Plugin skill: `ai-toolkit-trainer` (dataset prep, params, ComfyUI handoff)
- Phase 4: RunComfy remote pods (separate connector)