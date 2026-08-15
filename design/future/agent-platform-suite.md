# Agent-platform capability suite (parked) — LoRA catalog, concept images, training, RunComfy, PhotoMap, vault

> **Status: PARKED — spec preserved from PR [#200](https://github.com/artokun/comfyui-mcp/pull/200)
> (branch `feat/agent-platform-tools`, DRAFT, closed to clear the queue).** The full working
> implementation — 44 files, all tests passing at port time — lives on that branch; nothing needs
> rewriting from scratch. Resuming means rebasing the branch (or re-cherry-picking its commits),
> not re-implementing this doc.
>
> All feature work by **@MichaelDanCurtis**
> ([MichaelDanCurtis/comfyui-mcp](https://github.com/MichaelDanCurtis/comfyui-mcp)), ported with
> `-x` provenance trailers. This was Stack 5 of the fork-inheritance effort, parked because it is a
> **product-direction decision** (RunComfy integration, training tooling), not a code-quality one.

## What the stack contains

Eight capabilities, in the branch's pick order:

| Capability | Tools / surface | Source files (on the branch) |
|---|---|---|
| **LoRA manager catalog** | `lora_catalog_*` panel tools; catalog DB | `src/services/lora-catalog.ts`, `src/tools/lora-manager.ts` |
| **Cross-provider concept images** | `concept_image`, apply-reference; Grok CLI OAuth scoped to Imagine API only | `src/services/concept-image*.ts`, `apply-reference.ts`, `src/tools/concept-image.ts` |
| **AI-Toolkit training supervisor** | `toolkit_*` — drive an ostris/ai-toolkit training run | `src/services/toolkit-supervisor.ts`, `src/tools/toolkit.ts` |
| **RunComfy dedicated-pod connector** | `runcomfy_*` — RunComfy as an alternative cloud backend to RunPod | `src/services/runcomfy-connector.ts`, `src/tools/runcomfy.ts` |
| **RunComfy Trainer API** | trainer-only split of fork commit `04ab724` (provider backends excluded, they went to the OAuth PR) | `src/services/runcomfy-trainer.ts`, `src/tools/runcomfy-trainer.ts` |
| **PhotoMapAI album tools** | search/indexing/curation against a running PhotoMapAI server (MIT, lstein/PhotoMapAI) | `src/services/photomap.ts`, `src/tools/photomap.ts` |
| **Vault / training packs** | PhotoMap curation → training-pack export; Civitai catalog enrich; `/api/vault` + `/api/photomap` console surfaces + landing-page section | `src/services/training-pack.ts`, `lora-civitai-enrich.ts`, `src/tools/vault.ts`, `panel-console-http.ts` |
| **LoRA Manager sidecar import** | reads willmiao ComfyUI-Lora-Manager `.metadata.json` sidecars into the catalog | `src/services/lora-manager-sidecar.ts` |

Plus: `workflow-pipeline` service/tools, `structure-map-concept` plugin skill,
`THIRD_PARTY_NOTICES.md` (LoRA Manager + PhotoMapAI attribution), and per-feature design docs —
preserved alongside this spec as [`ai-toolkit-supervisor.md`](./ai-toolkit-supervisor.md),
[`lora-manager.md`](./lora-manager.md), [`runcomfy-connector.md`](./runcomfy-connector.md),
[`workflow-pipeline.md`](./workflow-pipeline.md). The fork's roadmap variant of
`docs/design/agent-platform-roadmap.md` differs slightly from main's copy (~20 changed lines) —
diff against the branch when resuming.

## Preconditions and entanglements (why this can't merge casually)

1. **Base branch dependency.** The stack was cut on top of `feat/panel-console-credentials`
   ([#197](https://github.com/artokun/comfyui-mcp/pull/197)) because it extends
   `panel-console-http.ts` (adds `/api/vault` + `/api/photomap` and a landing-page section) and
   relies on that base's console port + `lora-catalog.ts` copy + Windows `path.sep` fix.
   **#197 must land first** (or the stack must be rebased onto whatever superseded it).
2. **Civitai-metadata redundancy vs #186.** Main already writes `<file>.civitai.json`/`.md`
   sidecars from `download_model` (`action:"download_civitai"`), and `model-resolver` reads them. This stack's
   `lora-civitai-enrich` fetches overlapping Civitai metadata into the **catalog DB** instead (no
   file-format collision, but two fetch paths). Stance recorded at port time: **upstream's on-disk
   sidecar stays source of truth**; at merge time either make the catalog read the #186 sidecars or
   consciously bless the dual path. The willmiao `.metadata.json` import is a third-party format
   and orthogonal.
3. **Product decisions pending.** RunComfy as a second cloud provider (vs going deeper on RunPod),
   and whether training supervision (AI-Toolkit, RunComfy Trainer) is in scope for comfyui-mcp at
   all vs. staying in the separate trainer effort (`docker/trainer`, `design/runpod-training-p4.md`).

## State at park time

`npx tsc --noEmit` clean; `npx vitest run` — 123 files / 1285 tests passing, including the 12 new
test files the stack ships. Conflicts vs main were resolved during the port (console-route unions,
tool-registration hunks).

## Resume checklist

- [ ] Decide the RunComfy question (adopt as second provider / trainer-only / drop).
- [ ] Decide the training-supervision scope question.
- [ ] Rebase `feat/agent-platform-tools` onto current main (expect conflicts in
      `panel-console-http.ts`, `src/tools/index.ts`, `src/orchestrator/index.ts` — same spots as
      the original port).
- [ ] Resolve the Civitai-metadata dual path (catalog reads #186 sidecars, or documented split).
- [ ] Re-run the full test suite; the stack's own tests define its acceptance criteria.
