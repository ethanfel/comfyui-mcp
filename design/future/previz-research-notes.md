# Previz-to-video — field research notes (round 2)

**Companion to:** [`previz-to-video.md`](./previz-to-video.md) (RFC PR #187) ·
**Researched:** 2026-07-09, web-sourced, citations inline. UNVERIFIED items flagged.

How creators actually run "block in 3D → render motion reference → AI restyle"
pipelines today, plus operational facts for the two model legs and the official
Blender MCP. This is the evidence base for the H1 skill's concrete numbers.

---

## 1. Named prior art (processes worth stealing from)

### Doug Hogan — "Seedance Playblast2Render" (closest analog to our Seedance leg)
[comfy.org workflow](https://comfy.org/workflows/ef543bd4a773-ef543bd4a773/) ·
[YouTube](https://www.youtube.com/watch?v=5DfpOf6VPR4)

Raw CG **playblast** (blockout, no materials) → final shot. Five groups:
`VHS_LoadVideo` + `VHS_VideoInfo` **extract fps/duration from the playblast
itself** and compute output frame counts (sidesteps fps mismatch entirely) →
optional hero-frame picks for style exploration → **Nano Banana Pro generates
multi-angle reference boards** from those hero frames → a Gemini node builds a
"shot-aware prompt" → `ByteDance2ReferenceNode` gets playblast + reference
board to "lock in motion, silhouette, and camera." Troubleshooting: raise
reference influence for style, **simplify the prompt when drift appears, fix
seeds for repeatable iteration**.

### Mickmumpitz — AI Renderer 2.0 + 3D Movie Pipeline (the control-pass school)
[Guide](https://mickmumpitz.ai/guides/ai-powered-3d-animation-rendering) ·
[RunComfy mirror](https://www.runcomfy.com/comfyui-workflows/blender-to-comfyui-ai-renderer-2-0-workflow-cinematic-video-output) ·
[3D Movie Pipeline post](https://mickmumpitz.ai/posts/new-video-free-161509029?synced=1)

Fully local (Wan 2.1 VACE + SkyReels merge; newer pipeline FLUX.2 + LTX-2.3).
Renders **explicit control passes** from Blender rather than one clay video:
- **Layout/outline**: Workbench engine, MatCap shading, Cavity + Outlines on
  (feeds Canny-style control). Older recipe: Freestyle white-line pass.
- **Depth**: Z pass → compositor Invert + Map Range (near=white, normalized).
  Native Blender depth beats monocular estimation of the render.
- **Color-ID masks**: flat emission shader per object, record hex codes →
  regional prompting per object/character (the standard multi-character answer).
- **Mouth mask** (dialogue): white = locked to 3D, black = AI freedom; + a
  dialogue MP3 → LTX lip sync.
Rules: **fps + aspect identical between Blender and workflow**; resolution
divisible by 64 (LTX); ≤3 reference frames (LTX); character held by a
"consistency LoRA" at ~0.7; Wan VACE window **121 frames, 4n+1 rule**, iterative
batch-splitting beyond that. Multiple style refs override the start frame.

### Evolink / community — "Awesome Blender + Seedance Workflow Usecases" (28 cases)
[github.com/Evolink-AI/…](https://github.com/Evolink-AI/Awesome-Blender-Seedance-Workflow-Usecases)
(mirror: cheercheung/…)

The canonical loop, several cases **agent-built via Blender MCP** ("Codex/Claude
builds the blockout in 2–3 minutes, exports MP4"). Renders are **gray-box /
clay viewport previews, no materials** — "purely motion/camera guidance."
Layered control: the reference *video* carries camera + character positioning;
still *images* carry environment/style. Three camera patterns: Blender-only
camera; hybrid (Blender camera + external start frame); position-only
(reference controls placement, prompt recovers dynamism). Recorded failures:
**foot sliding** (fix with prompt reinforcement, not stricter imitation), cloth
physics, **character proportions must match beyond height**, multi-cut
reference videos get "averaged."

### Corridor Digital — "Anime Rock, Paper, Scissors" (the archetype, 2023)
[Kotaku coverage](https://kotaku.com/anime-rock-paper-scissors-corridor-digital-ai-animation-1850186624)

Live-action → Dreambooth-trained SD (style-locked on the target film) →
per-frame img2img → deflicker. Lessons that still hold: strongest character
consistency comes from **training on the target style/character** (today: a
LoRA), and **backgrounds stay 3D and get restyled separately** from performers.

### Adjacent
- **Pallaidium** ([tin2tin/Pallaidium](https://github.com/tin2tin/Pallaidium)) —
  gen-AI studio inside Blender's VSE; already wraps Seedance 2.0 R2V (≤9 image
  refs) — the whole loop without leaving Blender.
- **Banodoco / Steerable Motion** ([repo](https://github.com/banodoco/Steerable-Motion)) —
  keyframe-batch alternative: render N hero stills from the previz and travel
  between them (Wan VACE anchors).

## 2. Seedance 2.0 in ComfyUI — operational facts

- Nodes in ComfyUI core (`comfy_api_nodes/nodes_bytedance.py`, category
  `partner/video/ByteDance`): `ByteDance2TextToVideoNode`,
  **`ByteDance2ReferenceNode`** (R2V), `ByteDance2FirstLastFrameNode`, plus
  Create Image/Video Asset (one-time liveness check for real-person portraits;
  AI faces skip it). Templates: `api_seedance2_0_{t2v,r2v,flf2v}`,
  `api_seedance2_0_mini_{t2v,r2v}`.
  [docs.comfy.org](https://docs.comfy.org/tutorials/partner-nodes/bytedance/seedance-2-0)
- **Reference limits**: ≤9 images, ≤3 videos (each ≥1.8s, total ≤15.1s,
  480p–1080p, 24–60 fps, ≤50MB), ≤3 audio. Output: **4–15s discrete**
  (default 7), 480p→4K (Fast/Mini: ≤720p), seed + watermark + audio toggles.
- **Prompt syntax**: `@Image1…@Video1…@Audio1` with explicit roles — "Keep the
  motion of @Video1, replace subject with @Image1", "Follow the camera path
  from @Video1", "apply the slow right-to-left dolly from @video1 starting at
  the 3-second mark". Omitting roles causes morphing. Motion = video refs;
  aesthetics = text.
- **Cost** ([pricing](https://docs.comfy.org/tutorials/partner-nodes/pricing),
  211 credits = $1, tokens = dur × w × h × fps ÷ 1024): with a video ref a 5s
  720p R2V ≈ **$0.66** (Mini ≈ $0.32); video-ref generations bill at a *lower*
  per-token rate than pure T2V. Content-policy rejections still consume credits.
- **Community sweet spot: 6–8s per shot**; 12s+ brings drift/color shift —
  "3 shots and stitch." Greybox reference videos are a proven input; known
  weak spots: foot contact, cloth, stiffness under pure imitation (reinforce
  with prompt language).
- **Versions**: Seedance 2.0 / 2.0 Fast / 2.0 Mini are what exist in ComfyUI
  today. **"Seedance 5.0" does not exist** — that's **Seedream 5.0**, the
  *image* model. Latest video model is **Seedance 2.5** (native 30s single
  segment, up to 50 refs, region-local editing) with **no ComfyUI partner
  nodes yet** as of 2026-07-09.

## 3. Wan 2.2 Animate — operational facts

- Native template `video_wan2_2_14B_animate` (core node `WanAnimateToVideo`) or
  **Kijai WanVideoWrapper** for the power path (block swap, context windows,
  fp8 scaled). [docs.comfy.org](https://docs.comfy.org/tutorials/video/wan/wan2-2-animate)
- **16 fps native, 77-frame windows (~4.8s)**; extend by chaining 77-frame
  segments (native) or `WanVideoContextOptions` sliding windows (wrapper —
  "doesn't degrade over time," VRAM-capped regardless of length). Resolution
  multiples of 16.
- Quant tiers: fp8 scaled ~19GB (24GB cards standard fit); GGUF Q4_K_M 11.5GB →
  Q8 18.7GB for 16GB cards; optional lightx2v 4-step LoRA; relight LoRA for
  replacement-mode lighting harmonization.
- Chain: **DWPose Estimator** extracts pose+face from the driving video (feed
  normal RGB — no pre-baked skeleton needed); Points Editor + **SAM2** mask for
  **mix/replace** mode; **move/animate** mode (our previz case) = disconnect
  `background_video`/`character_mask`.
- **Driving-video requirement**: DWPose needs a **readable humanoid** —
  silhouette, face, hands. A greybox humanoid rig should track (UNVERIFIED for
  literal flat-grey mannequins — H0 must test this); non-humanoid or extreme
  proportions won't. Community guidance: **calm camera, fixed lens** when
  identity matters — aggressive moves mutate faces.

**Routing rule this implies (confirmed by both research threads):** camera
language and staging live in the **Seedance** reference video; **Wan Animate**
is the character-performance transfer with a stable camera. The RFC's gut-check
on this split is resolved — encode it as skill guidance.

## 4. Mixamo mechanics

- **Auto-rig upload**: FBX (embed media for textures) / OBJ / ZIP, **≤300MB**;
  T-pose or A-pose, clean humanoid, no extra scene objects (cameras/empties
  break the rigger), no wings/tails/props, no existing rig. Marker placement
  (chin/wrists/elbows/knees/groin) → server-side skeleton + weights.
  [Adobe help](https://helpx.adobe.com/creative-cloud/help/mixamo-rigging-animation.html)
- **Download for Blender**: FBX Binary, 30 or 60 fps, **no keyframe
  reduction**; first clip *With Skin*, subsequent clips *Without Skin*.
  **"In Place"** strips forward translation — usually wanted, so the Blender
  scene owns world-space travel and the reference video stays readable.
- **Retargeting (2026 state)**: free **"Retarget" extension** on
  extensions.blender.org (Blender 5+, Mixamo preset) is the default;
  **Auto-Rig Pro** (paid, Remap + Mixamo preset, hips-as-root so translation
  retargets) is the quality pick; Rokoko plugin free but lags releases.
  Mixamo skeletons root at the **hips** — the free "Import Mixamo - Root
  Motion" extension bakes hip translation to a generated root bone when engines
  need it.

## 5. Official Blender MCP — what the agent actually gets

> Distinguish **official** (`projects.blender.org/lab/blender_mcp`, Gitea) from
> the community `ahujasid/blender-mcp` (PyPI) several tutorials use. The
> official one: Blender add-on (TCP, auto-start) + stdio MCP server; tools
> auto-discovered from `mcp/blmcp/tools/`; ships `prompts.yml` + bpy API docs +
> manual excerpts as context. (Lab pages 403 automated fetchers; tool
> identifiers below are from official descriptions, not confirmed verbatim.)

- Tools: execute Python **in the connected instance** or **in a background
  headless Blender** (sandbox that can't wreck the open file); blend-file
  summary; bpy API docs lookup; **screenshot of an area/window**; render to
  path with current settings.
- **Fast previz render recipe** (via execute_python, for the H1 skill):
  `bpy.ops.render.opengl(animation=True, view_context=True)` captures the
  viewport shading — orders of magnitude faster than EEVEE/Cycles. Headless:
  `view_context=False` + `scene.render.engine = 'BLENDER_WORKBENCH'`. Knobs:
  `scene.display.shading.light = 'MATCAP'|'STUDIO'|'FLAT'`,
  `.color_type = 'SINGLE'|'RANDOM'|'MATERIAL'`, `.show_object_outline`.
  Direct-to-mp4: `file_format='FFMPEG'`, `ffmpeg.format='MPEG4'`,
  `ffmpeg.codec='H264'`, set `fps`/`frame_start`/`frame_end`/`filepath`.

## 6. Round 3 — more creators, downloadable workflows, non-Blender sources

### 6.1 Finds that change the plan

- **ComfyUI-UniRig** ([PozzettiAndrea/ComfyUI-UniRig](https://github.com/PozzettiAndrea/ComfyUI-UniRig))
  — wraps **UniRig** (VAST/Tripo, SIGGRAPH 2025, trained on 14k+ rigs incl.
  quadrupeds) *and* **Make-It-Animatable** (CVPR 2025; skeleton/skin-weight
  prediction "in under a second" — this is the "skin token" from the
  PixelArtistry video). Mesh in → **Mixamo-compatible rigged FBX** out,
  local, free, self-contained (bundles Blender). **The mixamo.com manual hop
  is optional, not structural.** Cloud alternates with real APIs: Meshy
  rigging/animation endpoints ([docs](https://docs.meshy.ai/en/api/rigging),
  rig + 600-clip library retarget; zero-credit claim UNVERIFIED), Tripo
  one-shot rig+retarget SDK, Anything World (best on non-humanoids).
- **ComfyUI-Yedp-Action-Director** ([yedp123](https://github.com/yedp123/ComfyUI-Yedp-Action-Director))
  — an interactive **3D viewport node inside ComfyUI**: up to 16
  Mixamo-rigged characters, clip sequencing, webcam facial capture, cameras/
  HDRIs, baking **7 synchronized passes** (OpenPose/Depth/Canny/Normal/
  Shaded/Alpha/Textured) straight into ControlNet/VACE pipelines. "Previz
  without opening Blender" — a natural first rung below the full Blender leg.
- **SCAIL / SCAIL-2** (zai-org, on Wan 2.1 14B) — early-2026 content is
  migrating motion transfer from Wan Animate to SCAIL-2: end-to-end (no
  skeleton/pose maps), better multi-character, GGUF builds down to **~6GB**
  ([tutorial](https://www.stablediffusiontutorials.com/2026/06/wan2.1-scail2.html),
  [RunComfy graph](https://www.runcomfy.com/comfyui-workflows/scail-2-motion-transfer-in-comfyui-reference-image-to-video)).
  The H2 pack choice (Animate vs SCAIL-2 vs both) should be re-checked at
  build time.
- **Kling 2.6 Motion Control** — third API path, simplest possible graph
  (LoadVideo + LoadImage → `KlingMotionControl`): motion+expression transfer
  with identity lock; reference 3–30s ([template](https://comfy.org/workflows/api_kling_motion_control-8f381a482443/)).
- **Self-filmed phone video is the community default previz** for
  single-character work (MDMZ, Max Novak, Benji, Intellectz all assume a
  performer video). Filming consensus: full body/mid-shot with hands visible,
  locked tripod, no cuts, even lighting, big readable motion, minimal frame
  traversal. The 3D path stays necessary for camera choreography,
  multi-character blocking, and non-human proportions.

### 6.2 Creators (beyond rounds 1–2)

- **Purz** ([comfy.org author](https://www.comfy.org/workflows/purz/)) —
  official templates: Wan 2.2 Animate auto character-replace / full-scene
  (**Nano Banana 2 auto-derives the swap reference from the video's first
  frame** — unattended swaps), 4K Seedance R2V, SAM3 text-prompt video
  masking; [blender-ai-keyframes](https://github.com/purzbeats/blender-ai-keyframes)
  converts audio to Blender f-curves → exported as AI-param schedules.
- **toyxyz** ([Gumroad rig](https://toyxyz.gumroad.com/l/ciojz)) — "character
  bones that look like OpenPose": retarget any character/mocap onto it and
  Blender renders **all ControlNet passes simultaneously** (OpenPose incl.
  wan-scale, depth, canny, face landmark, fingers); the foundational Blender
  control-pass rig everyone else builds on.
- **ggvfx** ([production workflows](https://github.com/ggvfx/comfyui-workflows))
  — real VFX production: camera-track a live plate → rebuild the move on
  **Unreal grey-box geometry** → grey-box render as driving video → depth
  ControlNets for Wan VACE *or* straight into Seedance R2V → comp in Nuke.
  Also SCAIL for pose+camera match. Proves greybox-as-driving-plate at
  production quality, 24GB VRAM.
- **Benji (Future Thinker)** ([Patreon](https://www.patreon.com/aifuturetech))
  — iClone 8 + AI Render → ComfyUI v2v; long-video "All-In-Looping": Animate
  + VACE Fun + PUSA LoRA with **overlap-frame stitching** to kill reversed
  motion and color shift.
- **Sebastian Kamph** ([workflow](https://www.patreon.com/posts/restyle-with-wan-127437500))
  — restyle-one-frame pattern: extract frame 1 (`frame_load_cap=1`), restyle
  that single image anywhere, VACE 14B propagates it across the clip.
  Cheapest look-dev iteration loop.
- **MDMZ** ([RunComfy collab](https://www.runcomfy.com/comfyui-workflows/wan-2-2-animate-swap-characters-lip-sync-workflow-comfyui))
  — character swap + lip-sync: original audio muxed back via
  VHS_VideoCombine; filming guidance for self-filmed drivers.
- **Max Novak** ([tutorial](https://www.youtube.com/watch?v=0trUwzli5G0)) —
  masking-free pure pose-drive variant; long takes via un-bypassing WanVideo
  **context options** with frame-window = context-frame count.
- **Intellectz** ([free workflow](https://www.patreon.com/posts/wan-animate-for-141999455))
  — QA gate: workflow **pauses at the Points Editor with an audio chime** so
  masks are verified before GPU time burns.
- **Esha Sharma / AIStudyNow** ([FusionX VACE](https://aistudynow.com/how-to-use-wan-2-1-fusionx-vace-in-comfyui-workflow-included/))
  — dual ControlNet (Canny + DWPose) motion capture, 125 frames @ 1024×576;
  documented drop-one-ControlNet VRAM fallback.
- **Reallusion AI Render** (iClone/CC, [open beta](https://magazine.reallusion.com/2025/07/28/ai-render-for-iclone-character-creator-enters-open-beta-with-comfyui-workflow/))
  — the productized competitor: iClone ships **3D-derived Depth / 3D OpenPose
  / Normal / geometry Canny** into ComfyUI with 22 presets; their stated
  finding matches ours — 3D-sourced passes beat 2D estimation for temporal
  stability.
- **Vladimir Chopine, Nerdy Rodent, enigmatic_e, GET GOING FAST** — v2v
  restyle / Wan-Animate variants (depth-guided stylization; VACE Fun
  character consistency; mask-region infill to repair hands/faces; FP8+GGUF
  twin workflows + Triton/SageAttention ~50% speedups).
- Negative findings: **Curious Refuge** (paywalled coursework, no public
  pipeline), **Dave Clark/Promise** (advocacy, no reproducible workflow),
  **JSFilmz** (previz education, no AI-restyle leg), **Latent Vision /
  Olivio / Aitrepreneur / AI Search** (no 3D-previz pipeline published).

### 6.3 Downloadable workflow shortlist (H2 pack candidates / references)

| Workflow | Why it matters |
| --- | --- |
| [Wan2.1 VACE control video (official)](https://comfy.org/workflows/video_wan_vace_14B_v2v-2652985596d8/) | The graph our previz depth/pose render plugs into directly |
| [shanef3d "Video Restyle"](https://comfy.org/workflows/templates_shane_video_restyle-5931e9bdf9db/) | First-frame styling + Canny/Depth switch, VACE propagation |
| [Purz Wan2.2 Animate auto full-scene](https://comfy.org/workflows/templates_purz_wan22_animate_auto_full_scene-840b6e4c3983/) | Fully automatic replace (YOLO+ViTPose+SAM2, no point-picking) |
| [The_frizzy1 GGUF unlimited-length loop](https://civitai.com/models/2046477) | Loop-node extension; 12GB @ Q8, down to 4GB @ Q4 |
| [Coyote_98 low-VRAM Animate](https://civitai.com/models/1980698) | 12GB/32GB: 113 frames @ 640p in ~10 min |
| [SCAIL-2 motion transfer](https://www.runcomfy.com/comfyui-workflows/scail-2-motion-transfer-in-comfyui-reference-image-to-video) | The multi-character / no-pose-map successor |
| [Kling 2.6 Motion Control (API)](https://comfy.org/workflows/api_kling_motion_control-8f381a482443/) | 4-node API path; ref 3–30s |
| [Minta Seedance Multiframe Stitch](https://www.comfy.org/workflows/araminta-k/) | Keyframe beat-boards → one continuous clip |
| [Storyboard To Video (Seedance)](https://comfy.org/workflows/f4e29143100c-f4e29143100c/) | Scene text → 8-panel storyboard → animated — previz-to-final in one graph |
| [LTX 2.3 Cameraman IC-LoRA](https://comfy.org/workflows/460daa6b205d-460daa6b205d/) | Camera-move transfer from reference clip onto a styled still |
| [Video→OpenPose utility](https://comfy.org/workflows/utility-openpose-video-dc73712c1842/) | Standard front-end when the reference is live footage |

### 6.4 Wan 2.2 Animate concrete settings (for the H1 skill)

From [stablediffusiontutorials.com](https://www.stablediffusiontutorials.com/2025/09/wan2.2-animate.html):
start at **640px** (author OOM'd at 1120, succeeded at 960); **KSampler 6
steps** (1–2 test / 7–10 quality), **CFG 1.0**, Euler/simple, denoise 1.0;
Relight + lightx2v rank64 LoRAs; ≤5s input recommended; Points Editor: 5–10
green dots on character, red on background; Mix vs Pose mode = connect vs
disconnect `background_video`+`mask`.

### 6.5 Motion/mocap tools with agent-drivable APIs (Mixamo-library alternates)

- **Move AI** ([developers.move.ai](https://developers.move.ai/docs/api-reference/)) —
  phone video → FBX/BVH/GLB/**.blend** via GraphQL API; best-in-class agent fit.
- **DeepMotion SayMotion** ([REST API](https://github.com/DeepMotion/SayMotion-REST-API)) —
  **text prompt → animation** (FBX/GLB/BVH); free 25 credits/mo, $15/mo tier.
- **Text2Motion** ([Blender add-on](https://github.com/text2motion/blender-integration)) —
  text → animation applied directly to an in-scene armature via REST API; the
  most agent-friendly text-to-animation path into Blender.
- **Kinetix** — video→anim freeware + Text2Emotes API; its models are licensed
  *into* Mixamo. **Cascadeur** ($12/mo Indie for FBX export) is human-in-the-loop
  polish, poor headless fit. **Rokoko Vision** free tier is single-cam FBX only.
- Camera-only: Seedance accepts **"@Video1 for camera movement only"**;
  [CinePack](https://superhivemarket.com/products/cinepack-pre-animated-camera-moves)
  ships 120+ pre-animated Blender camera moves — render them over greybox to
  mass-produce camera reference clips (no published pre-rendered pack exists;
  gap/opportunity). [ReCamMaster](https://jianhongbai.github.io/ReCamMaster/)
  re-renders an existing video along a *new* camera path.

## 6.6 Community counter-proposal (Discord, seanmcmagic — agent-drafted, taken with salt)

A session-tested argument + alternative architecture, preserved faithfully:

- **The "why", sharpened**: the panel's real value is that Claude acts on
  **live, current state** instead of frozen training data — live model cards
  corrected guessed CFG/negative/resolution settings all session; the
  Hub catalog changes daily and can't be baked into weights; the agent had no
  idea how the panel's own consent gate worked until it read live source. A
  Blender integration gives the same superpower on the 3D side: the agent
  sees *your actual rig, scene, and pose* instead of hallucinating plausible
  bpy calls. And posed skeleton/depth export **solves multi-character
  composition by construction** (who's touching whom, camera angle) — which
  text prompting never reliably did.
- **Proposed architecture** (differs from the RFC's): fork an existing bpy
  socket bridge (ahujasid/blender-mcp), mirror the comfyui-mcp two-package
  split — `blender-agent-panel` (thin Blender add-on, UI only) +
  `blender-mcp-orchestrator` (npx-launched tool host, loopback WS, different
  port) — and expose **~15 curated named tools instead of raw Python**
  (`blender_get_scene_outline`, `blender_render_viewport`,
  `blender_add_object`, `blender_set_transform`, `blender_list_bones`,
  `blender_set_bone_rotation`, `blender_apply_pose_preset`,
  `blender_export_pose_map`, `blender_export_camera_keyframes`,
  `blender_bake_depth_pass`, `blender_bake_normal_pass`,
  `blender_get_camera_params`, …). Reuse the existing consent file
  (`~/.comfyui-mcp/panel-settings.json`). Build order: read-only bridge →
  **pose + camera tools together** (not camera-first) → ComfyUI round trip
  (both API and local paths) → mobile app card.
- **Model-agnostic exports**: pose/camera leave Blender as generic artifacts
  (skeleton image/video, depth map, keyframe JSON), and the *downstream* node
  decides the backend — Seedance for paid cinematic work (server-side content
  filtering), Wan Animate/ControlNet for local unrestricted work.
- **Prior art flagged**: [alexisrolland/ComfyUI-Blender](https://github.com/alexisrolland/ComfyUI-Blender)
  (175+ stars, on the Comfy Registry) — Blender triggers ComfyUI workflows,
  but one-directional with no pose/scene export; UI-pattern reference only.

RFC disposition (see the vision doc's architecture section): adopt the
live-state framing, model-agnostic exports, pose+camera-together ordering,
and the prior-art pointer; hold the fork-and-own-two-packages architecture as
an open question against the official-MCP-via-companion-servers approach —
the curated-tools concern is real (small local models struggle with raw bpy;
same lesson as compact tool mode #97/#113) but may be answerable with skill
recipes over the official server before owning a whole Blender add-on.

## 7. Numeric anchors for the H1 skill (cheat sheet)

| Thing | Number |
| --- | --- |
| Seedance refs | ≤9 images, ≤3 videos (≤15.1s total), ≤3 audio |
| Seedance output | 4–15s discrete; aim **6–8s/shot**; 1080p@24 typical |
| Seedance R2V cost | ~$0.66 / 5s @ 720p (Mini ~$0.32); rejections still bill |
| Wan Animate | 16 fps, 77-frame (~4.8s) windows, chained; res %16 |
| Wan VRAM | fp8 ~19GB (24GB cards); GGUF Q4_K_M 11.5GB (16GB cards) |
| Wan VACE (control-pass leg) | 121-frame window, 4n+1 rule |
| Blender render | fps/aspect must equal workflow; Hogan pattern: read fps from the playblast |
| Mixamo upload | ≤300MB FBX/OBJ/ZIP, T/A-pose, no extra objects |
| Mixamo download | FBX Binary 30/60fps, no keyframe reduction, In Place for locomotion |
