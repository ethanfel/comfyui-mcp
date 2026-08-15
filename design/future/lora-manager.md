# LoRA Manager

Curated catalog of local LoRA files with metadata agents and users need to apply them correctly.

## Storage

Per ComfyUI instance (slug from `getInstanceSlug()`):

| Path | Purpose |
|------|---------|
| `~/.comfyui-mcp/instances/<slug>/lora-catalog.json` | Catalog entries |
| `~/.comfyui-mcp/instances/<slug>/lora-previews/` | Preview images |

Overrides for tests: `COMFYUI_MCP_LORA_CATALOG`, `COMFYUI_MCP_LORA_PREVIEWS`.

## Catalog entry fields

- `relPath` — ComfyUI-relative path under `models/` (e.g. `loras/style/foo.safetensors`)
- `displayName`, `description`, `setupInstructions`
- `keywords`, `negativeKeywords` — trigger / avoid tokens
- `baseModels`, `strengthMin` / `strengthMax` / `strengthDefault`
- `previewFile` — filename under `lora-previews/`
- `sourceUrl`, CivitAI ids, `tags`, `notes`
- `missing` — set by sync when file no longer on disk

## ComfyUI LoRA Manager integration (willmiao)

[ComfyUI LoRA Manager](https://github.com/willmiao/ComfyUI-Lora-Manager) stores rich Civitai metadata in **`.metadata.json` sidecars** beside each LoRA (trigger words, `usage_tips` strength/clip_skip, previews, tags). It also provides a `/loras` web UI and a Civitai browser extension for one-click downloads when a Civitai API key is set in LoRA Manager settings.

comfyui-mcp does not replace LoRA Manager — it **imports** sidecar data into the agent catalog so orchestrator/panel tools share the same trigger words and strength hints.

Recommended flow when LoRA Manager is installed:

1. `lora_catalog_sync` — ensure every on-disk LoRA has a catalog stub
2. `lora_catalog_import_sidecars` — pull Civitai + usage_tips from sidecars (fast, no API calls)
3. `lora_catalog_enrich_civitai` — only for LoRAs missing sidecars or hash-only matches

## MCP tools (headless `comfyui` server)

| Tool | Role |
|------|------|
| `lora_catalog_sync` | Scan `list_local_models({action:"list", model_type:"loras"})` and merge into catalog |
| `lora_catalog_detect_lora_manager` | Detect LoRA Manager install + Civitai API key in its settings |
| `lora_catalog_import_sidecars` | Import `.metadata.json` sidecars (Civitai trainedWords, usage_tips, previews) |
| `lora_catalog_enrich_civitai` | Hash-based Civitai backfill when sidecars are absent |
| `lora_catalog_list` | Human-readable list with filters |
| `lora_catalog_get` | One entry by id or path |
| `lora_catalog_upsert` | Create/update metadata |
| `lora_catalog_set_preview` | Copy local image into preview store |
| `lora_catalog_search` | JSON summaries for agents |

## Panel bridge commands

| Command | Direction | Payload |
|---------|-----------|---------|
| `open_lora_manager` | orchestrator → panel | `{ catalog: LoraSummary[] }` — open browse UI |
| `pick_lora` | orchestrator → panel | `{ header, allow_multiple?, catalog }` → `{ picked }` |

Panel tools: `panel_open_lora_manager`, `panel_pick_lora`.

If the panel does not implement `pick_lora`, the orchestrator falls back to `ask_user` with text options (no previews).

## Panel UI follow-up (`comfyui-mcp-panel`)

1. Handle `open_lora_manager` — modal/sidebar with grid (preview, name, keywords, setup blurb).
2. Handle `pick_lora` — same UI in selection mode; return `{ picked: summary | summaries[] }`.
3. Optional: let users edit metadata in UI → call `lora_catalog_upsert` via agent or direct API later.