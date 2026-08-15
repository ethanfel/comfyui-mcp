# Multi-workflow pipeline

Run ordered ComfyUI stages from a YAML project manifest — shared assets, per-stage workflow pins, and automatic output chaining between stages.

## MCP tool

**`run_workflow_pipeline`** — load manifest from `project_path` or inline `project_yaml`, execute stages in order (optional `start_at` / `stop_at`), `dry_run` to validate only.

Requires a reachable ComfyUI server (local, remote, or cloud).

## Manifest format

```yaml
name: hero-to-video
description: Optional summary
assets:
  storyboard: ./refs/storyboard.png   # uploaded once to ComfyUI input/
stages:
  - id: hero
    workflow: pack:z-image-turbo      # or path: workflows/hero.json
    pin: workflows/hero.json          # optional panel hint (panel_set_workflow_target)
    inputs:
      text: "portrait of a cat in soft light"
    assets:
      storyboard: primary             # wire shared asset into LoadImage slots
    wait: true
    timeout_seconds: 900
  - id: edit
    workflow: pack:qwen-image-edit
    pin: workflows/edit.json
    chain_from: hero                  # previous stage id
    chain_role: primary
    inputs:
      text: "add sunglasses"
    output_node_id: "9"               # optional SaveImage node for chaining
```

### Stage fields

| Field | Purpose |
|-------|---------|
| `workflow` | `pack:<name>`, `path:<file>`, bare pack name, or file path |
| `pin` | Workflow path label for panel pinning (returned in results; does not switch the UI) |
| `inputs` | Flat overrides (`applyOverrides`) across all nodes |
| `node_inputs` | Per-node input patches (`{ "6": { text: "..." } }`) |
| `assets` | Map manifest `assets` keys → reference role (`primary`, `reference`, …) |
| `chain_from` | Prior stage id — stages output via `upload_image (action:"stage")`, wires into next workflow |
| `chain_role` / `chain_node_id` / `chain_input_name` | Control reference patching |
| `wait` | Wait for completion (default `true`) |
| `timeout_seconds` | Per-stage wait cap (default 1800) |
| `disable_random_seed` | Pass through to `enqueue_workflow` |
| `extra_data` | `/prompt` extra_data (API node credentials, etc.) |

## Chaining

When `chain_from` is set, the prior stage's primary output is fetched from `/history`, re-staged with `upload_image (action:"stage")`, and applied to the next workflow with `apply_reference_to_workflow`. This matches the director / multi-stage panel guidance (never guess filesystem `input/` paths).

## Related

- Phase 0: [workflow-target.md](./workflow-target.md) — `pin` aligns with `panel_set_workflow_target`
- Phase 2: `fetch_concept_image` + `apply_reference_to_workflow`
- Plugin skill: `director` — full story-to-video orchestration pattern