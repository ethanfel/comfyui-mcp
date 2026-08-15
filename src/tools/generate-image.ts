import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateImage } from "../services/generate-image.js";
import { enqueueWorkflow } from "../services/workflow-executor.js";
import {
  listLocalModels,
  type LocalModel,
} from "../services/model-resolver.js";
import { selectTxt2ImgCheckpoint } from "../services/checkpoint-capability.js";
import { REMBG_NODE } from "../services/remove-background.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { generateAudioAction } from "./generate-audio.js";
import { generate3dAction } from "./generate-3d.js";
import { generateVideoAction } from "./generate-video.js";
import { upscaleImageAction } from "./upscale-image.js";
import { removeBackgroundAction } from "./remove-background.js";
import {
  generateWithControlNetAction,
  generateWithIpAdapterAction,
} from "./generate-conditioned.js";
import { regenerateAction } from "./assets.js";

async function resolveCheckpoint(): Promise<string | undefined> {
  let models: LocalModel[];
  try {
    models = await listLocalModels("checkpoints");
  } catch {
    // Listing failed (server unreachable, …) — the caller's generic
    // "no checkpoint found" error is the accurate report for that.
    return undefined;
  }
  if (models.length === 0) return undefined;
  // Skip checkpoints that cannot drive a txt2img graph (video models without
  // a text encoder, GGUF files) instead of taking the alphabetically-first
  // entry and failing at CLIPTextEncode every time (issue #892).
  const choice = await selectTxt2ImgCheckpoint(models);
  if (choice) return choice.name;
  const MAX_LISTED = 5;
  const listed = models
    .slice(0, MAX_LISTED)
    .map((m) => m.name)
    .join(", ");
  const more =
    models.length > MAX_LISTED ? `, … and ${models.length - MAX_LISTED} more` : "";
  throw new ValidationError(
    `Found ${models.length} local checkpoint(s), but none appears txt2img-capable: ` +
      `every one lacks text-encoder weights in its safetensors header (a video or ` +
      `UNet-only model) or is a GGUF file CheckpointLoaderSimple cannot load ` +
      `(${listed}${more}). Download an image checkpoint with download_model ` +
      `(action:"search_civitai" can find one), then pass it as \`checkpoint\` or save ` +
      `it with get_defaults (action:"set"). If you believe one was misdetected, ` +
      `pass \`checkpoint\` explicitly to bypass this check.`,
  );
}

/**
 * The nine HIGH-LEVEL GENERATION entry points collapsed into one
 * action-parameterized `generate_image` tool (0.50.0 surface consolidation,
 * slice 16).
 *
 * `generate_image` is the SURVIVOR and keeps its registration slot; the eight
 * sibling entry points it absorbed are listed, with their replacement call
 * forms, in DEAD_NAMES (src/tools/vocabulary.ts) — the one place a retired name
 * is allowed to live, so that a stale mention anywhere else stays detectable.
 *
 * NINE actions, one over the RFC's soft cap of eight, and deliberately so: every
 * one of them is "describe what you want, get a queued render back with a
 * prompt_id", and the two that most obviously could split off — the two
 * post-processing actions — are the ones an agent reaches for in the SAME
 * breath as a generation (render it, then clean it up), so a separate name
 * would cost a tool slot to re-separate what callers already chain. Splitting
 * them back out into their own two-action tool is a live option if a ninth
 * action proves to be one too many in practice; it costs one slot.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model. The price of flatness is a wide
 * parameter list, so every `.describe()` below names the action(s) it belongs to.
 *
 * REQUIREDNESS: only `action` can be schema-required. `prompt` was required by
 * five of the nine old tools and meaningless to three, `image` was required by
 * the two post-processing actions and optional for video/3d, and so on — so the
 * handler enforces per-action PRESENCE and NAMES the missing field, which is the
 * one deliberate behavioural difference a flat enum permits. The guards test
 * ABSENCE, not falsiness: `prompt: ""` passed z.string() before this
 * consolidation and reached the service (which builds a graph with an empty
 * positive prompt — a legitimate, if odd, render), and still does.
 *
 * ONE VALUE CONSTRAINT COULD NOT STAY IN ZOD. `strength` meant different things
 * with different ranges in the two tools that had it: video's i2v adherence was
 * `z.number().min(0).max(1)`, ControlNet's conditioning weight was
 * `z.number().positive()` (unbounded above). A flat shape has one `strength`, so
 * one of the two ranges would have been silently widened or narrowed — a real
 * behaviour change either way (ControlNet strength 1.5 is ordinary and would
 * have started failing; video strength 2.0 was rejected and would have started
 * reaching the service). The field is therefore `z.number()` at the schema layer
 * and RANGE-CHECKED PER ACTION in the handler, which reproduces each old
 * rejection exactly and names the field, the action and the range. Every OTHER
 * value constraint is untouched at the zod layer.
 */
const GENERATE_ACTIONS = [
  "image", "audio", "video", "3d", "controlnet",
  "ip_adapter", "regenerate", "upscale", "remove_background",
] as const;

export function registerGenerateImageTool(server: McpServer): void {
  server.tool(
    "generate_image",
    "Generate media from a prompt or an existing image — the high-level entry points that build the graph for you. Every action enqueues on the connected ComfyUI and returns the prompt_id immediately; the resulting asset_id arrives in the completion notification. Driven by the `action` parameter:\n" +
      '- action:"image" — Text-to-image. Builds a txt2img workflow, filling any unspecified parameter from your configured defaults (get_defaults (action:"set") / COMFYUI_DEFAULT_* / config file), auto-selecting a local checkpoint when none is given — checkpoints known to lack a text encoder (e.g. video models) are skipped. `prompt` is required. For full control over the node graph, use create_workflow + enqueue_workflow instead.\n' +
      '- action:"audio" — Text-to-audio, supporting the ACE Step 1.5 and Stable Audio 3 model families. Builds the appropriate workflow graph, filling unspecified parameters from your defaults and auto-selecting local models. `model_family`, `prompt` and `duration` are required. Requires a running ComfyUI with the corresponding model files installed.\n' +
      '- action:"video" — Text-to-video, or image-to-video when `image` is given (animate a start frame). Composes an LTX-2.3 distilled workflow on your LOCAL GPU using the render-verified Comfy-Org node stack (gemma text encoder + abliterated/distilled LoRAs). Needs the LTX-2.3 models (~24-46GB): install with apply_manifest --path packs/ltx-2.3-txt2vid/manifest.yaml (or ltx-2.3-img2vid for i2v); returns an actionable error if the checkpoint is missing. `seconds` is converted to an 8n+1 frame count. For i2v, higher `strength` means MORE adherence to the start frame but LESS motion (1.0 can freeze the clip) — keep ~0.6. This minimal path omits the synchronized audio + stage-2 spatial upscale that the full ltx-2.3 packs ship. `prompt` is required. The video is written under output/video/ — find it with get_image (action:"list_outputs") (VHS/SaveVideo outputs may not appear in /history).\n' +
      '- action:"3d" — Generate a 3D model (glb/obj/fbx) from a text prompt or an input image, using the connected ComfyUI\'s hosted partner 3D nodes (Tripo, Meshy, Rodin, Hunyuan3D — auto-detected from the server; these are paid API nodes needing a comfy.org API key/login on the server or COMFY_API_KEY here). `mode` is required ("text" needs `prompt`, "image" needs `image`). Poll queue (action:"status") / get_history (action:"list") for the resulting model file (saved to ComfyUI\'s output directory). If the server has no 3D-capable API nodes, returns an actionable error naming local-pack alternatives.\n' +
      '- action:"controlnet" — Image conditioned by a ControlNet preprocessed image (pose skeleton, depth, canny, normal, etc.) plus a text prompt. Upload the control image first with upload_image (action:"image"), then pass its filename as `control_image`. `prompt` and `control_image` are required; `checkpoint` and `controlnet_model` auto-resolve from local models. control_image must ALREADY be a preprocessed map (this action does not run the preprocessor); requires a running ComfyUI with a matching controlnet model in models/controlnet/.\n' +
      '- action:"ip_adapter" — Image guided by a reference image\'s style/subject via IP-Adapter, plus a text prompt. Requires the ComfyUI_IPAdapter_plus custom nodes. Upload the reference first with upload_image (action:"image"), then pass its filename as `reference_image`. `prompt` and `reference_image` are required; `checkpoint` auto-resolves. Requires a running ComfyUI with ComfyUI_IPAdapter_plus and a matching IP-Adapter model installed, or the workflow will fail at execution time.\n' +
      '- action:"regenerate" — Re-enqueue the workflow that produced an EXISTING ASSET, optionally applying `overrides`. Overrides are applied to any node input matching the key name (e.g. cfg, steps, sampler_name, scheduler, seed, denoise, text). Seeds are re-randomized by default so each call yields a fresh image unless seed is explicitly passed in overrides. `asset_id` is required. To re-run from execution HISTORY rather than a registered asset, use enqueue_workflow (action:"rerun").\n' +
      '- action:"upscale" — Upscale an image with an ESRGAN super-resolution model. Builds an UpscaleModelLoader → ImageUpscaleWithModel workflow (scale=2 supersamples the 4x result back down for sharper output) and enqueues it on your LOCAL GPU. Upload the source first with upload_image (action:"image") (or stage a prior output with upload_image (action:"stage")), then pass its filename as `image`. Needs an upscale model in models/upscale_models/ (e.g. 4x-ClearRealityV1 / 4x_foolhardy_Remacri, provided by the anima/ernie packs or download_model); returns an actionable error if none is found. `image` is required.\n' +
      `- action:"remove_background" — Remove an image's background, returning a transparent (RGBA) cutout. Builds a LoadImage → ${REMBG_NODE} → SaveImage workflow using the ComfyUI-RMBG (BiRefNet) matting node and enqueues it on your LOCAL GPU. Upload the source first with upload_image (action:"image") (or stage a prior output with upload_image (action:"stage")), then pass its filename as \`image\`. Requires the ComfyUI-RMBG custom node (pack: wan-transparent, or install_custom_node 'comfyui-rmbg'); the BiRefNet model auto-downloads on first run. If the node isn't installed, returns an actionable error telling you how to install it. \`image\` is required.`,
    {
      action: z
        .enum(GENERATE_ACTIONS)
        .describe(
          'What to generate. action:"image"/action:"video" require `prompt`; action:"audio" requires `model_family`+`prompt`+`duration`; action:"3d" requires `mode` (+ `prompt` or `image`); action:"controlnet" requires `prompt`+`control_image`; action:"ip_adapter" requires `prompt`+`reference_image`; action:"regenerate" requires `asset_id`; action:"upscale" and action:"remove_background" require `image`.',
        ),

      // ── shared txt2img-family parameters ──────────────────────────────────
      prompt: z
        .string()
        .optional()
        .describe(
          'Positive text prompt. REQUIRED for actions "image", "audio", "video", "controlnet" and "ip_adapter"; for action:"3d" it is required in mode "text" and optional (passed through only if the chosen node accepts it) in mode "image". Unused by action:"regenerate", action:"upscale" and action:"remove_background".',
        ),
      negative_prompt: z
        .string()
        .optional()
        .describe(
          'Negative prompt (default: empty / from defaults). Used by actions "image", "video", "controlnet", "ip_adapter" and — for the Stable Audio 3 family only — "audio".',
        ),
      width: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Image width in pixels. Actions "image", "controlnet", "ip_adapter".'),
      height: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Image height in pixels. Actions "image", "controlnet", "ip_adapter".'),
      steps: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Sampling steps. Actions "image", "audio", "video", "controlnet", "ip_adapter" (video defaults to 8 for the distilled model).'),
      cfg: z
        .number()
        .positive()
        .optional()
        .describe('CFG scale. Actions "image", "audio", "video", "controlnet", "ip_adapter" (video defaults to 1.0 for the distilled model).'),
      sampler: z
        .string()
        .optional()
        .describe('Sampler name (e.g. euler, dpmpp_2m). Actions "image", "audio", "controlnet", "ip_adapter".'),
      scheduler: z
        .string()
        .optional()
        .describe('Scheduler (e.g. normal, karras). Actions "image", "audio", "controlnet", "ip_adapter".'),
      seed: z
        .number()
        .int()
        .optional()
        .describe('Seed (omit to randomize). Actions "image", "audio", "video", "controlnet", "ip_adapter".'),
      checkpoint: z
        .string()
        .optional()
        .describe(
          'Checkpoint filename; auto-selected from local models if omitted. The relevant checkpoint differs per action: a diffusion checkpoint for "image"/"controlnet"/"ip_adapter", the LTX checkpoint for "video", the Stable Audio 3 checkpoint for "audio".',
        ),
      batch_size: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('action:"image" — number of images to generate.'),
      filename_prefix: z
        .string()
        .optional()
        .describe(
          'Output filename prefix. action:"audio" (default audio/ace_step or audio/stable_audio_3), action:"video" (default \'video/ltx-2.3\') and action:"remove_background" (default \'ComfyUI_cutout\').',
        ),

      // ── image inputs ──────────────────────────────────────────────────────
      image: z
        .string()
        .optional()
        .describe(
          'Filename of an image in ComfyUI\'s input dir (upload it first with upload_image (action:"image"), or stage a prior output with upload_image (action:"stage")). REQUIRED for action:"upscale" and action:"remove_background"; the start frame for action:"video" image-to-video; the input image for action:"3d" in mode "image".',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Model file for the post-processing actions: action:"upscale" — an upscale model in models/upscale_models/ (auto-selected from local models if omitted); action:"remove_background" — the BiRefNet matting model (default \'BiRefNet_toonout\'; auto-downloaded by ComfyUI-RMBG).',
        ),
      scale: z
        .union([z.literal(2), z.literal(4)])
        .optional()
        .describe('action:"upscale" — net upscale factor: 2 or 4 (default 4).'),

      // ── conditioned generation ────────────────────────────────────────────
      control_image: z
        .string()
        .optional()
        .describe(
          'action:"controlnet" — filename of the (already-uploaded, already-preprocessed) control image in ComfyUI\'s input dir. REQUIRED for that action.',
        ),
      controlnet_model: z
        .string()
        .optional()
        .describe('action:"controlnet" — ControlNet model file (in models/controlnet/); auto-selected if omitted.'),
      reference_image: z
        .string()
        .optional()
        .describe(
          'action:"ip_adapter" — filename of the (already-uploaded) reference image in ComfyUI\'s input dir. REQUIRED for that action.',
        ),
      weight: z
        .number()
        .optional()
        .describe('action:"ip_adapter" — IP-Adapter influence on the output, typically 0.0-1.0 (default 0.8); higher = closer to the reference.'),
      preset: z
        .string()
        .optional()
        .describe("action:\"ip_adapter\" — IPAdapterUnifiedLoader preset (default 'PLUS (high strength)')."),
      weight_type: z
        .enum(["standard", "prompt is more important", "style transfer"])
        .optional()
        .describe("action:\"ip_adapter\" — IPAdapter weight mode (default 'standard' — required by current IPAdapter_plus builds)."),
      strength: z
        .number()
        .optional()
        .describe(
          'Two DIFFERENT knobs sharing one field, each with its own range, checked when the action runs: action:"video" (i2v only) — adherence to the start frame, 0-1 inclusive (default 0.6; higher = LESS motion); action:"controlnet" — conditioning strength, must be > 0, typically 0.0-2.0 (default 1.0; higher = stronger adherence to the control image).',
        ),

      // ── video ─────────────────────────────────────────────────────────────
      seconds: z
        .number()
        .positive()
        .optional()
        .describe('action:"video" — clip length in seconds (default 4; ~10s max).'),
      resolution: z
        .string()
        .optional()
        .describe("action:\"video\" — 'WIDTHxHEIGHT' e.g. '768x512' (rounded to multiples of 32; default 768x512)."),
      fps: z
        .number()
        .positive()
        .optional()
        .describe('action:"video" — frames per second (default 25).'),

      // ── 3d ────────────────────────────────────────────────────────────────
      mode: z
        .enum(["text", "image"])
        .optional()
        .describe(
          'action:"3d" — "text" = text-to-3D from `prompt`; "image" = image-to-3D from an uploaded input `image`. REQUIRED for that action.',
        ),
      node: z
        .string()
        .optional()
        .describe(
          'action:"3d" — explicit 3D API node class_type to use (e.g. "MeshyTextToModelNode"); auto-selected if omitted. Use list_api_nodes with filter "3d" to see options.',
        ),
      inputs: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"3d" — provider-specific extra inputs passed through to the node (e.g. style, texture, quality). Use list_api_nodes (action:"schema") on the chosen node for valid keys.',
        ),

      // ── audio ─────────────────────────────────────────────────────────────
      model_family: z
        .enum(["ace_step_1.5", "stable_audio_3"])
        .optional()
        .describe(
          'action:"audio" — audio model family; determines which workflow template and model loaders to use. REQUIRED for that action.',
        ),
      duration: z
        .number()
        .positive()
        .optional()
        .describe('action:"audio" — audio duration in seconds. REQUIRED for that action.'),
      unet: z
        .string()
        .optional()
        .describe('action:"audio" — ACE UNet model filename (in models/diffusion_models/); auto-selected if omitted.'),
      vae: z
        .string()
        .optional()
        .describe('action:"audio" — ACE VAE model filename (in models/vae/); auto-selected if omitted.'),
      clip_a: z
        .string()
        .optional()
        .describe('action:"audio" — primary text encoder filename (in models/text_encoders/); auto-selected if omitted.'),
      clip_b: z
        .string()
        .optional()
        .describe('action:"audio" — secondary text encoder filename (in models/text_encoders/); auto-selected if omitted.'),
      clip: z
        .string()
        .optional()
        .describe('action:"audio" — Stable Audio CLIP encoder filename (in models/text_encoders/); auto-selected if omitted.'),
      lyrics: z
        .string()
        .optional()
        .describe('action:"audio" — lyrics or song structure description (ACE only — section-by-section breakdown).'),
      language: z
        .string()
        .optional()
        .describe("action:\"audio\" — language code for prompt (ACE only, default: 'en')."),
      musical_key: z
        .string()
        .optional()
        .describe("action:\"audio\" — target musical key (ACE only, e.g. 'C major', 'E minor'; default: 'C major')."),
      shift: z
        .number()
        .optional()
        .describe('action:"audio" — ModelSamplingAuraFlow shift parameter (ACE only, default: 3).'),
      guidance_scale: z
        .number()
        .optional()
        .describe('action:"audio" — TextEncodeAceStepAudio1.5 cfg_scale, the text encoder guidance scale (ACE only, default: 2).'),
      bpm: z
        .number()
        .int()
        .min(10)
        .max(300)
        .optional()
        .describe('action:"audio" — TextEncodeAceStepAudio1.5 tempo in beats per minute (ACE only, 10-300, default: 120).'),
      timesignature: z
        .enum(["2", "3", "4", "6"])
        .optional()
        .describe("action:\"audio\" — TextEncodeAceStepAudio1.5 time signature (ACE only, one of '2'/'3'/'4'/'6', default: '4')."),
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe('action:"audio" — TextEncodeAceStepAudio1.5 LLM sampling temperature (ACE only, 0-2, default: 0.85).'),
      top_p: z
        .number()
        .min(0)
        .max(2000)
        .optional()
        .describe('action:"audio" — TextEncodeAceStepAudio1.5 LLM top-p nucleus sampling (ACE only, 0-2000, default: 0.9).'),
      top_k: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('action:"audio" — TextEncodeAceStepAudio1.5 LLM top-k sampling (ACE only, 0-100, default: 0 = disabled).'),
      min_p: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('action:"audio" — TextEncodeAceStepAudio1.5 LLM min-p sampling (ACE only, 0-1, default: 0).'),
      generate_audio_codes: z
        .boolean()
        .optional()
        .describe('action:"audio" — generate audio codes via the TextEncodeAceStepAudio1.5 LLM (ACE only, default: true).'),
      audio_quality: z
        .enum(["V0", "128k", "320k"])
        .optional()
        // #1458 — NOT "ACE only" any more. Both audio families end in SaveAudioMP3, and
        // stable_audio_3 now sets `quality` from this same parameter, so telling a
        // stable_audio_3 caller the knob does not apply to them is exactly the wrong
        // answer this issue is about.
        .describe("action:\"audio\" — SaveAudioMP3 bitrate/quality (ACE and stable_audio_3, one of 'V0'/'128k'/'320k', default: '320k')."),

      // ── re-render an existing asset ───────────────────────────────────────
      asset_id: z
        .string()
        .optional()
        .describe('action:"regenerate" — asset id of the source generation. REQUIRED for that action.'),
      overrides: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"regenerate" — map of input-name → new value applied to every node that already has that input. Common keys: cfg, steps, sampler_name, scheduler, seed, denoise, text.',
        ),
      disable_random_seed: z
        .boolean()
        .optional()
        .describe(
          'action:"regenerate" and action:"3d" — if true, do not randomize seed fields. For action:"regenerate", combine with `overrides.seed` to reproduce the exact original image.',
        ),
    },
    async (args) => {
      try {
        // Per-action PRESENCE, enforced here because a flat shape can only make
        // `action` schema-required. Each guard names the missing field, which is
        // the same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness: `prompt: ""` and `asset_id: ""` both
        // passed z.string() before this consolidation and reached their services
        // (which answer with their own behaviour — an empty positive prompt, a
        // not-found asset). A `!x` guard would swallow those paths and substitute
        // generic text.
        const need = <T>(value: T | undefined, action: string, field: string, what: string): T => {
          if (value === undefined) {
            throw new ValidationError(
              `generate_image action:"${action}" requires \`${field}\` — ${what}.`,
            );
          }
          return value;
        };

        // The one constraint that could not stay in zod — see the header. Each
        // branch reproduces exactly what its old tool's schema rejected.
        const strengthFor = (action: "video" | "controlnet"): number | undefined => {
          const v = args.strength;
          if (v === undefined) return undefined;
          if (action === "video" && (v < 0 || v > 1)) {
            throw new ValidationError(
              `generate_image action:"video" requires \`strength\` between 0 and 1 (i2v adherence to the start frame); got ${v}.`,
            );
          }
          if (action === "controlnet" && v <= 0) {
            throw new ValidationError(
              `generate_image action:"controlnet" requires \`strength\` greater than 0 (ControlNet conditioning strength, typically 0.0-2.0); got ${v}.`,
            );
          }
          return v;
        };

        switch (args.action) {
          case "image": {
            const result = await generateImage(
              {
                prompt: need(args.prompt, "image", "prompt", "what to draw"),
                negative_prompt: args.negative_prompt,
                width: args.width,
                height: args.height,
                steps: args.steps,
                cfg: args.cfg,
                sampler: args.sampler,
                scheduler: args.scheduler,
                seed: args.seed,
                checkpoint: args.checkpoint,
                batch_size: args.batch_size,
              },
              {
                resolveCheckpoint,
                // The workflow composer already draws a random seed when none is
                // given, so executor-side re-randomization would only ever clobber
                // the seed this tool just resolved — including an explicit one
                // (issue #865).
                enqueue: (workflow) =>
                  enqueueWorkflow(workflow, { disable_random_seed: true }),
              },
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      status: "enqueued",
                      prompt_id: result.prompt_id,
                      queue_remaining: result.queue_remaining,
                      // #1037 — a 200 from /prompt does not mean every output was accepted;
                      // ComfyUI queues the branches that validate and reports the rest.
                      ...(result.rejectedOutputs
                        ? { rejected_outputs: result.rejectedOutputs }
                        : {}),
                      checkpoint: result.checkpoint,
                      note: 'asset_id will be available in the completion notification; use get_image (action:"view") or generate_image (action:"regenerate") with it.',
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          case "audio":
            return await generateAudioAction({
              model_family: need(args.model_family, "audio", "model_family", '"ace_step_1.5" or "stable_audio_3"'),
              prompt: need(args.prompt, "audio", "prompt", "what the audio should sound like"),
              duration: need(args.duration, "audio", "duration", "the clip length in seconds"),
              seed: args.seed,
              steps: args.steps,
              cfg: args.cfg,
              sampler: args.sampler,
              scheduler: args.scheduler,
              filename_prefix: args.filename_prefix,
              unet: args.unet,
              vae: args.vae,
              clip_a: args.clip_a,
              clip_b: args.clip_b,
              lyrics: args.lyrics,
              language: args.language,
              musical_key: args.musical_key,
              shift: args.shift,
              guidance_scale: args.guidance_scale,
              bpm: args.bpm,
              timesignature: args.timesignature,
              temperature: args.temperature,
              top_p: args.top_p,
              top_k: args.top_k,
              min_p: args.min_p,
              generate_audio_codes: args.generate_audio_codes,
              audio_quality: args.audio_quality,
              checkpoint: args.checkpoint,
              clip: args.clip,
              negative_prompt: args.negative_prompt,
            });
          case "video":
            return await generateVideoAction({
              prompt: need(args.prompt, "video", "prompt", "what happens in the clip"),
              image: args.image,
              negative_prompt: args.negative_prompt,
              seconds: args.seconds,
              resolution: args.resolution,
              fps: args.fps,
              seed: args.seed,
              steps: args.steps,
              cfg: args.cfg,
              strength: strengthFor("video"),
              checkpoint: args.checkpoint,
              filename_prefix: args.filename_prefix,
            });
          case "3d":
            return await generate3dAction({
              mode: need(args.mode, "3d", "mode", '"text" for text-to-3D or "image" for image-to-3D'),
              prompt: args.prompt,
              image: args.image,
              node: args.node,
              inputs: args.inputs,
              disable_random_seed: args.disable_random_seed,
            });
          case "controlnet":
            return await generateWithControlNetAction({
              prompt: need(args.prompt, "controlnet", "prompt", "what to draw"),
              control_image: need(
                args.control_image,
                "controlnet",
                "control_image",
                "the already-uploaded, already-preprocessed control map",
              ),
              controlnet_model: args.controlnet_model,
              strength: strengthFor("controlnet"),
              negative_prompt: args.negative_prompt,
              width: args.width,
              height: args.height,
              steps: args.steps,
              cfg: args.cfg,
              sampler: args.sampler,
              scheduler: args.scheduler,
              seed: args.seed,
              checkpoint: args.checkpoint,
            });
          case "ip_adapter":
            return await generateWithIpAdapterAction({
              prompt: need(args.prompt, "ip_adapter", "prompt", "what to draw"),
              reference_image: need(
                args.reference_image,
                "ip_adapter",
                "reference_image",
                "the already-uploaded style/subject reference",
              ),
              weight: args.weight,
              preset: args.preset,
              weight_type: args.weight_type,
              negative_prompt: args.negative_prompt,
              width: args.width,
              height: args.height,
              steps: args.steps,
              cfg: args.cfg,
              sampler: args.sampler,
              scheduler: args.scheduler,
              seed: args.seed,
              checkpoint: args.checkpoint,
            });
          case "regenerate":
            return await regenerateAction({
              asset_id: need(args.asset_id, "regenerate", "asset_id", "the source generation to re-run"),
              overrides: args.overrides,
              disable_random_seed: args.disable_random_seed,
            });
          case "upscale":
            return await upscaleImageAction({
              image: need(args.image, "upscale", "image", "the source image in ComfyUI's input dir"),
              scale: args.scale,
              model: args.model,
            });
          case "remove_background":
            return await removeBackgroundAction({
              image: need(args.image, "remove_background", "image", "the source image in ComfyUI's input dir"),
              model: args.model,
              filename_prefix: args.filename_prefix,
            });
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown generate_image action "${String(exhaustive)}". Expected one of: ${GENERATE_ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
