# Previz-to-video — 3D-blocked reference scenes for motion-controlled AI video (vision doc)

**Status:** PARKED — preserved from RFC PR [#187](https://github.com/artokun/comfyui-mcp/pull/187) (branch `spec/previz-to-video`, closed to clear the queue; the branch also carried a ROADMAP.md "Theme H" entry, reproduced in the addendum at the bottom) · **Field research:** [`previz-research-notes.md`](./previz-research-notes.md)

> Prior art: [Doug Hogan's Seedance Playblast2Render](https://comfy.org/workflows/ef543bd4a773-ef543bd4a773/)
> (playblast → `ByteDance2ReferenceNode`, fps read from the playblast itself),
> [Mickmumpitz's AI Renderer 2.0](https://mickmumpitz.ai/guides/ai-powered-3d-animation-rendering)
> (local control-pass school: depth/outline/color-ID passes → Wan VACE), and the
> [Awesome Blender + Seedance use-case collection](https://github.com/Evolink-AI/Awesome-Blender-Seedance-Workflow-Usecases)
> (28 cases, several agent-built via Blender MCP).

> Living doc. Casual "run it by a smart friend" framing at the top; concrete
> architecture + phases below. Draft — shaping it before building.

---

## The pitch

Prompting alone can't direct a shot. You can get *a* beautiful video out of Wan
or Seedance, but you can't get **the** shot — this character crosses frame left
while the camera dollies past that prop, beat lands on frame 40. The most
reliable control signal we have today isn't words, it's **a pre-animated 3D
scene**: block the shot in Blender with rigged characters and a keyframed
camera, render a cheap untextured preview, and hand that to a video model as a
motion/camera reference. The model keeps the body movement, timing, camera
motion and pacing — and repaints everything else from reference images. Swap
the reference images, keep the animation: infinite restyles of one shot.

ComfyUI's own demo of exactly this recipe:
[Seedance 2.0 restyling a Blender/Mixamo previz](https://www.youtube.com/watch?v=3r6qzGGNK8s)
— Mixamo characters + a generated bus + keyframed camera, rendered rough, then
"follow the exact same body movement, timing, camera motion and pacing from the
reference video; change the appearance to match the reference images."

The reason this belongs in comfyui-mcp: **every step of that pipeline is
agent-drivable now.** Blender ships an official MCP (5.1+). Meshy 6 partner
nodes live in ComfyUI core for text/image→3D assets. Wan 2.2 Animate runs the
free local path; Seedance 2.0 Reference-to-Video is the paid API path. Our
agent already does story→scenes→frames→clips (the `director` skill). What's
missing is the **cinematography department**: a skill + pack that teaches the
agent to previz a scene in Blender and cash it out through ComfyUI. You'd tell
the panel "two characters argue on a rooftop, camera circles them, then one
walks off a ledge — make it look like a 90s anime" and the agent blocks it,
renders the reference, and restyles it — asking before it spends credits.

The panel's job, first and foremost, is **natural motion between characters
you created inside ComfyUI** (Discord feedback, verbatim intent): ComfyUI is
the character shop, Mixamo auto-rigs what it produces, and Claude — with full
visibility into the Blender scene — directs the performance from the user's
natural language.

Why this is the panel's home turf (community articulation, from a live
session): the panel's whole value is that the agent acts on **live, current
state instead of frozen training data** — live model cards correct guessed
settings, the daily-changing workflow catalog can't live in weights, and the
agent doesn't know how anything on disk works until it reads it. A Blender
stage extends that same superpower to 3D: the agent sees *your actual rig,
scene, and pose* rather than hallucinating plausible bpy calls. And a posed
scene **solves multi-character composition by construction** — who's touching
whom, from what angle — which text prompting has never done reliably.

## Evidence this works today

- [ComfyUI (official): style-swapping one Blender animation](https://www.youtube.com/watch?v=3r6qzGGNK8s)
  — the core recipe end-to-end: Mixamo + Tripo asset + camera keyframes →
  rough render → Seedance 2.0 R2V with character/environment ref images.
  Confirms: no textures/lighting needed in the previz; camera motion survives.
- [PixelArtistry: Claude took over ComfyUI + Blender](https://www.youtube.com/watch?v=KdYv_TT-ZnQ)
  — Claude driving Blender MCP + a ComfyUI MCP together: batch asset kits
  (image model → img2mesh → import to Blender), retopo/bake cleanup, and
  text-to-animation (Kinetix) retargeted onto rigged characters. Confirms: the
  dual-MCP orchestration pattern holds up for real multi-step 3D work.
- [Stefan 3D AI: official Blender MCP setup](https://www.youtube.com/watch?v=wSY1kHXSap0)
  — the official 5.1 add-on is drag-drop + auto-start, Claude connector is
  one-click; agent-built materials, geometry nodes, baking, LODs all in single
  prompts. Confirms: setup friction is low enough to put in a skill.
- [PixelArtistry: 3D AI news #13](https://www.youtube.com/watch?v=N15zYcv0Snk)
  — the surrounding ecosystem (retopo, splats, markerless mocap) is compounding
  fast; spatial reasoning in current Claude models is measurably better.
- **Community, on Discord**: a member (seanmcmagic) built a fully-local
  **character shop** *with the Agent Panel's help* and shared the workflow —
  SDXL (WAI-Illustrious) hero image → Qwen-Image-Edit 2511 + multiple-angles
  LoRA batch-generating consistent views → **Hunyuan3D v2 multi-view** → GLB.
  Preserved at
  [`previz-assets/master-3d-model-maker.community.json`](./previz-assets/master-3d-model-maker.community.json)
  (Discord CDN links expire). Confirms: the free asset path is real today, and
  people are already using the panel to build this pipeline's front half. The
  same thread asked for **3D-modeling and audio skill files** — H1 answers the
  3D half.

## The pieces on the board

| Piece | What it gives us | Status / cost |
| --- | --- | --- |
| **Blender MCP (official)** | Scene assembly, import, retarget, camera keyframes, viewport render — via `execute_python` + scene-summary tools; add-on + TCP server (localhost:9876, auto-start), Blender 5.1+ | Free; separate MCP server ([projects.blender.org/lab/blender_mcp](https://projects.blender.org/lab/blender_mcp)) |
| **ComfyUI-UniRig** | **Local auto-rigging**: mesh → Mixamo-compatible rigged FBX (UniRig + Make-It-Animatable, sub-second skinning; handles non-humanoids) | Free, local, in-graph — agent-drivable today; [repo](https://github.com/PozzettiAndrea/ComfyUI-UniRig) |
| **Mixamo** | Fallback auto-rigger + huge free library of humanoid clips | Free w/ Adobe account, **no API** — website hop is manual; curated local FBX library + Blender retarget add-ons |
| **Yedp Action Director** | **Previz inside ComfyUI**: 3D viewport node, ≤16 Mixamo-rigged characters, cameras/HDRIs → bakes 7 control passes (pose/depth/canny/normal/shaded/alpha/textured) | Free custom node — the lighter first rung below the full Blender stage |
| **Meshy 6 partner nodes** | text→3D / image→3D / multi-image→3D in ComfyUI core (Templates → 3D); GLB/FBX into `output/` | **Paid** (Comfy credits, ~211/$1) |
| **Local 3D gen** | Trellis 2 / Hunyuan3D / TripoSplat custom nodes as the free asset path; community-proven character-shop graph (SDXL → Qwen-Edit multi-angle → Hunyuan3D v2 MV → GLB, see Evidence) | Free, local GPU |
| **Wan 2.2 Animate** | Reference video + character image → animated character (DWPose-driven); move/animate & mix/replace modes; native Comfy template | Free, local (fp8 ~19GB on 24GB cards, GGUF Q4 on 16GB; 16 fps, 77-frame windows, res %16). Watch **SCAIL-2** — end-to-end successor, no pose maps, better multi-character, GGUF ~6GB; re-check at H2 build time |
| **Kling 2.6 Motion Control** | Simplest API path: character image + motion video (3–30s) → identity-locked transfer, 4-node graph | **Paid** API node — third restyle leg alongside Seedance/Wan |
| **Self-filmed video** | A phone clip of the user performing IS a previz for single-character shots (community default); filming rules: full body, locked tripod, no cuts, even light | Free — the skill should accept it as a first-class motion source |
| **Seedance 2.0 R2V** | ≤3 reference videos (≤15.1s total) + ≤9 reference images + ≤3 audio, `@Video1`/`@Image1` role-tagged prompts; follows choreography + camera; 4–15s out (sweet spot 6–8s) | **Paid** API node (`ByteDance2ReferenceNode`, ~$0.66 / 5s @ 720p; Mini ~$0.32); Seedance 2.5 exists (30s native) but has no Comfy nodes yet |
| **Already in this repo** | `director` skill (story→scenes→clips), packs system, `upload_image (action:"video")`/`upload_image (action:"stage")` I/O, `list_api_nodes` (actions `list`/`schema`/`generate`), `list_packs` action:"check_runtime" ask-before-spend | Shipped |

## Architecture — who talks to whom

**comfyui-mcp does not wrap Blender.** The agent (Claude) holds *two* MCP
connections — comfyui-mcp for generation/canvas, Blender MCP for scene work —
and a skill teaches it the choreography. That keeps us out of the business of
proxying bpy, and it's exactly the pattern proven in the videos.

Handoff points (all already representable):

1. **ComfyUI → Blender**: Meshy/Trellis writes GLB/FBX into ComfyUI `output/`;
   the agent imports it via Blender MCP `execute_python`
   (`bpy.ops.import_scene.gltf`) — **directly from the output folder**, the
   same file awareness the panel already has on the drive
   (`get_image (action:"list_outputs")`, workspace paths). No copy step, no asking the user
   where the file went.
2. **ComfyUI → Mixamo (auto-rig)**: a ComfyUI-authored character mesh from
   `output/` goes to mixamo.com for auto-rigging (or a Mixamo-family Blender
   add-on) and comes back as a skeleton-bound FBX. See the character loop below.
3. **Mixamo → Blender**: user-curated local FBX clip library (see below);
   import + retarget onto the character rig via add-on or bpy.
4. **Blender → ComfyUI**: viewport/OpenGL render (solid shading, no lights, no
   materials — it's a motion reference) to mp4 or frame sequence →
   `upload_image (action:"video")` → reference input of the Wan Animate graph or Seedance node.
5. **Reference stills**: character/environment look-images from any local
   image pack (Z-Image, Krea2, …) or provided by the user.

**The character loop (Discord feedback, revised by round-3 research)**:
characters are **authored in ComfyUI first** — image model → img2mesh →
FBX/GLB in `output/` — then auto-rigged, and only then animated and directed
in Blender. Rigging now has a fully-automatic local path: **ComfyUI-UniRig**
(UniRig + Make-It-Animatable) turns a mesh into a **Mixamo-compatible rigged
FBX** locally, free, inside the same ComfyUI the agent already drives — no
website hop at all. Mixamo's site remains the fallback rigger and the clip
library; when used, the skill runs it as a guided handoff: stage the exact
file, tell the user what to upload and click, pick the rigged FBX back up
from the download folder. (Cloud alternates with real APIs: Meshy rigging +
600-clip retarget, Tripo one-shot rig+retarget.) Direction stays verifiable:
the agent inspects the scene graph and screenshots the viewport, so it *sees*
every scene it's directing — the same trust model as the canvas, where it
reads the graph it mutates.

**Mixamo reality check**: there is no official API and scraping is a ToS
minefield, so the skill treats Mixamo's clip library as a **one-time shopping
trip** — a documented starter list (idle/walk/run/turn/sit/fight/dance/death…)
the user downloads once into a conventional folder (e.g.
`~/.comfyui-mcp/previz/clips/`), which the agent then reuses forever.
Auto-rigging is per-character but follows the same stage → guide → pick-up
pattern. Text-to-animation add-ons (Kinetix-style) and markerless mocap slot
into the same folder convention later.

**Model-agnostic exports (adopted from community feedback)**: everything that
leaves Blender is a **generic control artifact** — clay/skeleton video, depth
pass, camera-keyframe JSON — never tied to one backend. The downstream node
decides: Seedance/Kling for hosted cinematic work, Wan Animate / VACE /
ControlNet for local work. Same Blender tooling either way. Corollary from the
same feedback: hosted backends filter content server-side, so the local leg
isn't just the free leg — it's the only leg for content the APIs won't render.
One more scope rule adopted: **pose export and camera export ship together**
(H0/H1), not camera-first — multi-character shots need pose matching from day
one, camera motion alone doesn't hold characters consistent.

**Orchestrator gap + the architecture question**: the panel agent currently
speaks only to comfyui-mcp. Claude Desktop / Claude Code users can add the
Blender MCP alongside today, but the *panel* needs **companion MCP server
support** — a config that passes extra MCP servers into the spawned agent
session (H3). A community counter-proposal (research notes §6.6) goes
further: fork a bpy socket bridge and ship our own two-package Blender panel
(`blender-agent-panel` add-on + `blender-mcp-orchestrator`) exposing **~15
curated named tools instead of raw `execute_python`** — reusing the panel's
consent file. The concern behind it is real: raw bpy is hostile to small
local models (the exact lesson compact tool mode taught us on the ComfyUI
side) and hard to consent-gate. Current lean: **don't own a Blender add-on
yet** — official MCP underneath, curated *recipes* in the H1 skill on top,
and revisit a thin curated tool layer (possibly proxying the official
add-on's socket rather than forking) if H0/H1 show local models can't drive
recipes reliably. Prior art either way:
[alexisrolland/ComfyUI-Blender](https://github.com/alexisrolland/ComfyUI-Blender)
(Blender→ComfyUI trigger, one-directional, UI-pattern reference).

## Deliverables

- **`previz-director` skill** (`plugin/skills/previz-director/SKILL.md`) — the
  whole recipe as knowledge, with the field-research numbers baked in
  ([research notes](./previz-research-notes.md)): Blender MCP setup + port
  sanity check; scene blocking conventions (real-world scale — Seedance needs
  character *proportions* to match, not just height; camera rig patterns:
  dolly/orbit/crane as reusable bpy snippets); Mixamo library convention +
  auto-rig handoff + retarget procedure (free Retarget extension / ARP);
  viewport render recipe (`bpy.ops.render.opengl`, Workbench MatCap/solid,
  outlines on, **fps read from the playblast and held identical through the
  workflow**, silhouette-readable for DWPose); the **routing rule** — camera
  language and staging go to Seedance R2V, character-performance transfer with
  a calm camera goes to Wan Animate; role-tagged prompt templates ("Keep the
  motion of @Video1 … replace subject with @Image1", "Follow the camera path
  from @Video1"), shot length guidance (6–8s per shot, stitch longer);
  known-weak-spots watchlist (foot contact, cloth, multi-cut references);
  style-sweep pattern (one previz, N reference-image sets).
- **`wan-animate` pack** (`packs/wan-animate/`) — the free path, installable:
  Wan 2.2 Animate 14B fp8 + controlnet_aux (DWPose) + SAM2 nodes, template
  workflow wired for reference-video input. Follows the existing manifest
  conventions; `pack.yaml` links the skill.
- **`character-shop` pack (community seed)** — productize the shared
  Master 3D Model Maker graph (SDXL hero → Qwen-Edit 2511 multi-angle LoRA →
  Hunyuan3D v2 MV → GLB) as the free character-authoring pack, with credit to
  its author, **extended with a ComfyUI-UniRig stage** so the pack's output is
  a rigged, animation-ready FBX — the full character loop with zero manual
  hops. It's the ComfyUI half of the character loop, already panel-built.
- **Meshy + Seedance guidance** — no pack needed (they're core API nodes);
  the skill documents the built-in templates and wraps both in the
  `list_packs` action:"check_runtime" / ask-before-spending convention. Free alternates
  (Trellis/Hunyuan3D for assets, Wan Animate for video) are always named
  first.
- **3D-asset file awareness** — extend the existing output-folder awareness
  (`get_image (action:"list_outputs")` already tags `kind: "video"`) to **3D assets**
  (`kind: "model"` for GLB/FBX/OBJ in `output/`), so "import the character I
  just generated into Blender" and "stage this mesh for Mixamo auto-rigging"
  resolve to exact paths without the user hunting for files. Small, and it's
  the glue the whole character loop stands on.
- **Companion MCP servers for the panel orchestrator** — config +
  session-spawn plumbing so the panel agent can reach Blender MCP. Specced
  separately when we get there (it's generic, not Blender-specific).
- **`director` integration** — a previz mode for the existing story pipeline:
  scene list → one Blender previz per shot → batch restyle. Character
  consistency comes free (same 3D characters every shot); the director skill's
  hero-frame/ref-image machinery supplies the style side.

## Phases

| Phase | Goal | Contents |
| --- | --- | --- |
| **H0 — spike (manual)** | Prove the recipe on this rig, end-to-end, once | Meshy (or Trellis) asset → Mixamo character + clip → Blender blocking + camera → viewport render → Wan Animate local AND Seedance R2V; write down every snag. Must answer: does DWPose track a flat-grey mannequin, or does the previz need MatCap/toon shading + a visible face? |
| **H1 — skill** | `previz-director` SKILL.md from H0's notes | Knowledge only, zero code; usable immediately from Claude Desktop/Code with both MCPs configured |
| **H2 — pack + glue** | `wan-animate` pack; 3D-asset file awareness | Free path installable via `apply_manifest`; `kind: "model"` in output listing; H1 skill references both |
| **H3 — panel parity** | Companion MCP servers in the orchestrator | Panel agent gets Blender MCP; pairing-level UX ("Connect Blender" hint in panel) |
| **H4 — storytelling** | Director × previz | Shot lists drive previz scenes; multi-shot continuity (same cast/set across shots); style sweeps as a first-class op |

H0/H1 ship value with **no code at all** — that's the point of leading with a
skill. H2 is manifest-writing. Only H3 touches the orchestrator.

## Costs & safety

Two of the pieces are paid (Meshy, Seedance — Comfy credits billed to the
user's Comfy account). Existing convention applies unchanged: the agent calls
`list_packs` with `action: "check_runtime"`, treats `api`/`mixed` as possibly-paid, and **asks
before spending credits — never silently**. Every paid step has a named free
alternative (local img2mesh; Wan Animate), and the skill presents the free
path as the default. Blender MCP is local and free; its `execute_python` is
arbitrary code execution *inside the user's Blender* — the skill should say so
plainly and keep generated bpy scripts inspectable in chat, same spirit as our
graph mutations being undoable.

## Where I actually want a gut-check

- **How early does the panel need Blender?** Discord feedback says the *side
  panel* controlling motion is the headline feature — which pulls H3
  (companion MCP servers) forward. Counter-pressure: H0–H2 already work from
  Claude Desktop/Code and prove the recipe before we touch the orchestrator.
  Current lean: keep H3 third, but spec it in parallel with H1 so panel parity
  lands fast once the skill is validated.
- **Curated Blender tools vs raw bpy over the official MCP?** The community
  proposal (notes §6.6) wants ~15 named tools (`blender_export_pose_map`,
  `blender_set_bone_rotation`, …) instead of `execute_python`. Real tension:
  named tools are what small local backends can actually drive, and what a
  consent gate can reason about — but 15 tools can't cover retargeting,
  physics, and the long tail that makes Blender worth having. H0/H1 decide:
  if skill recipes over the official MCP work for Claude but fail for
  qwen/gemma-class backends, a thin curated layer (proxying the official
  add-on's socket, not forking a new one) becomes an H3-adjacent item.
- **Bundle a tiny CC0 previz kit?** A mannequin character + 3–5 CC0 motion
  clips shipped in the pack would make H0-style demos work without the Mixamo
  shopping trip (and without leaning on Adobe's ToS). Leaning yes — and
  round-3 research softens the need further: UniRig rigs locally, and
  text-to-animation APIs (DeepMotion SayMotion, Text2Motion's Blender add-on,
  Move AI phone mocap) can *generate* clips instead of shopping for them.
  Mixamo becomes the curated-quality option, not the bottleneck.
- **Yedp Action Director as the on-ramp?** A 3D previz viewport *inside*
  ComfyUI (Mixamo rigs, cameras, 7 baked control passes) covers simple shots
  with zero Blender setup, and the full Blender MCP stage takes over when
  shots need real set dressing, physics, or multi-take direction. Should H1
  teach both rungs, or does two previz stages confuse the story?
- **Headless Blender?** The official MCP can execute in a background Blender
  process — a render-farm-ish mode for batch shots. Interactive-first feels
  right (the user watches the blocking happen, same as the canvas), headless
  later.
- ~~DWPose readability as a skill rule~~ — **resolved by field research**: the
  split is real and stable. Camera moves + staging → Seedance (follows the
  reference video's trajectory faithfully); character performance with a calm
  camera → Wan Animate (DWPose needs a readable humanoid; aggressive camera
  moves mutate identity). One open sub-question for H0: does DWPose track a
  *flat-grey mannequin* reliably, or does the previz need a MatCap/toon-shaded
  humanoid with a visible face?
- **A third leg worth a later pack?** The Mickmumpitz school renders explicit
  control passes (depth via compositor Map Range, Freestyle/Workbench
  outlines, per-object color-ID masks for regional prompting) into a local
  Wan-VACE restyle. More setup, more control, fully free — and color-ID masks
  are the best multi-character answer anyone has. Candidate `previz-restyle`
  pack after H2, not in scope now.
- **Where does the clip library live** — `~/.comfyui-mcp/previz/` vs the
  ComfyUI workspace vs a pack `templates/` dir. Orchestrator config already
  has a home dir; leaning `~/.comfyui-mcp/previz/`.
- ~~Seedance "5.0"~~ — **resolved**: it doesn't exist ("Seedream 5.0" is the
  *image* model). The current video line is 2.0 / 2.0 Fast / 2.0 Mini in
  ComfyUI, with **Seedance 2.5** (native 30s, ≤50 refs) released but not yet
  in ComfyUI partner nodes. The skill names capabilities, not node class
  names, so 2.5 slots in when it lands.

---

## Addendum — ROADMAP.md Theme H entry (from the PR branch, preserved verbatim)

## Theme H — 3D previz → motion-controlled video (Blender MCP + Mixamo + Meshy) (#187)
The most reliable way to direct an AI video shot is a pre-animated 3D scene: block it in Blender
(agent-driven via the **official Blender MCP**, 5.1+), populate with **Mixamo** motion clips and
**Meshy 6** / local img2mesh assets, render a rough viewport reference, then restyle it with
**Wan 2.2 Animate** (free, local) or **Seedance 2.0 Reference-to-Video** (paid API node) — motion,
timing and camera survive; appearance comes from reference images. Full vision:
[`design/previz-to-video.md`](./design/previz-to-video.md). comfyui-mcp does **not** wrap Blender —
the agent holds both MCPs and a skill teaches the choreography. Headline (community feedback): the
panel directs **natural motion between characters authored in ComfyUI** — ComfyUI is the character
shop, Mixamo auto-rigs its output, Blender is the stage Claude can fully see and direct.

- **H0 — Manual spike.** Run the recipe once end-to-end on this rig (asset → Mixamo auto-rig →
  blocking → viewport render → Wan Animate AND Seedance R2V); capture every snag.
- **H1 — `previz-director` skill.** The whole recipe as knowledge (blocking conventions, character
  loop incl. the guided Mixamo auto-rig handoff, retarget procedure, render settings, handoff
  commands, R2V prompt templates). Zero code; works today from Claude Desktop/Code with both MCPs
  configured.
- **H2 — `wan-animate` + `character-shop` packs + 3D-asset file awareness.** The free video path
  installable via `apply_manifest` (Wan 2.2 Animate 14B fp8 + DWPose + SAM2 + wired template); the
  community-seeded character-shop pack (SDXL hero → Qwen-Edit 2511 multi-angle → Hunyuan3D v2 MV →
  GLB, `design/previz-assets/master-3d-model-maker.community.json`); plus `kind: "model"`
  (GLB/FBX/OBJ) in the output listing so import-to-Blender / stage-for-Mixamo resolve exact paths.
- **H3 — Companion MCP servers in the orchestrator.** Config + session-spawn plumbing so the *panel*
  agent can reach Blender MCP (generic mechanism, Blender is just the first customer). Open question
  tracked in the RFC: whether small local backends additionally need a thin curated tool layer
  (`blender_export_pose_map`-style named tools) over the official MCP's raw `execute_python` —
  community proposal, decided by H0/H1 evidence.
- **H4 — Director × previz.** Shot lists drive previz scenes; multi-shot cast/set continuity; style
  sweeps (one previz, N looks) as a first-class op.

> Paid pieces (Meshy, Seedance) stay behind the existing `list_packs`
> `action: "check_runtime"` /
> ask-before-spending convention; every paid step has a named free alternative.

