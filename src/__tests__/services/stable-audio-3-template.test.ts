// #1458 — the bundled stable_audio_3 template had two independent defects.
//
// 1. `SaveAudioMP3` omitted the REQUIRED `quality` input, so every audio generation
//    for this family was rejected before execution:
//      400 prompt_outputs_failed_validation
//      - SaveAudioMP3 (node 8): Required input is missing (quality)
//    The ace_step_15 sibling in the same file always set it. One of two templates.
//
// 2. The shipped sampler/cfg defaults — lcm + cfg 7 — render DIGITAL SILENCE
//    (mean -91 dB) while ComfyUI reports success. The reporter measured six
//    combinations; that pair was the only silent one, and lcm at cfg 1 is fine, so
//    it was specifically the pairing the template shipped. A correctly-sized,
//    correctly-durated file of nothing, with nothing in the logs.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkflow } from "../../services/workflow-composer.js";

type Node = { class_type: string; inputs: Record<string, unknown> };
const nodes = (wf: unknown) => Object.values((wf as Record<string, Node>) ?? {});
const nodeOfType = (wf: unknown, type: string) =>
  nodes(wf).find((n) => n?.class_type === type);

describe("#1458 bug 1: SaveAudioMP3 carries the required quality", () => {
  it("emits quality, so the prompt passes validation", () => {
    const save = nodeOfType(createWorkflow("stable_audio_3", {}), "SaveAudioMP3");
    expect(save, "the template must still save audio").toBeTruthy();
    expect(save!.inputs.quality).toBe("320k");
  });

  it("honours a caller's audio_quality instead of dropping it", () => {
    // `audio_quality` is a PUBLIC parameter of the audio generation tool. This
    // family ignored it
    // AND emitted no quality at all, so a caller who set it was silently overridden
    // on top of every run failing — accepting a parameter and discarding it is its
    // own defect, and fixing only the omission would have left it in place.
    const save = nodeOfType(
      createWorkflow("stable_audio_3", { audio_quality: "128k" }),
      "SaveAudioMP3",
    );
    expect(save!.inputs.quality).toBe("128k");
  });

  it("matches the ace_step_15 sibling, which was always right", () => {
    const ace = nodeOfType(createWorkflow("ace_step_15", {}), "SaveAudioMP3");
    const sa3 = nodeOfType(createWorkflow("stable_audio_3", {}), "SaveAudioMP3");
    expect(ace!.inputs.quality).toBe(sa3!.inputs.quality);
  });
});

describe("#1458 bug 2: the defaults do not render silence", () => {
  const sampler = (wf: unknown) => {
    const k = nodes(wf).find((n) => "sampler_name" in (n?.inputs ?? {}));
    return k?.inputs as { sampler_name?: unknown; cfg?: unknown };
  };

  it("does NOT ship the lcm + cfg 7 pair", () => {
    // The exact measured-silent combination. Asserted as a PAIR, because neither
    // half is wrong alone — lcm at cfg 1 produces audio, and cfg 7 is fine with
    // euler or dpmpp_2m. Only the pairing is.
    const s = sampler(createWorkflow("stable_audio_3", {}));
    expect(`${s.sampler_name}+${s.cfg}`).not.toBe("lcm+7");
  });

  it("defaults to dpmpp_2m", () => {
    // Chosen over euler on the reporter's own measurement: at 42s, euler produced
    // ~53.7 audible click artifacts/sec against ~0.8/sec for dpmpp_2m. Both avoid
    // the silence; a default is judged on the long render, where nobody is watching.
    const s = sampler(createWorkflow("stable_audio_3", {}));
    expect(s.sampler_name).toBe("dpmpp_2m");
  });

  it("still lets a caller ask for lcm explicitly", () => {
    // The fix is a DEFAULT, not a ban. lcm at a low cfg is a legitimate fast path
    // and the reporter measured it working; refusing it would trade a bad default
    // for a missing capability.
    const s = sampler(createWorkflow("stable_audio_3", { sampler_name: "lcm", cfg: 1 }));
    expect(s.sampler_name).toBe("lcm");
    expect(s.cfg).toBe(1);
  });
});

describe("#1458 WIRING: the audio tool passes audio_quality to THIS family", () => {
  it("the stable_audio_3 dispatch forwards it, like the ace_step path", () => {
    // A mutation deleting this line SURVIVED the tests above, and rightly: they call
    // createWorkflow directly, so no amount of composer testing can see whether the
    // caller forwards the parameter. The composer honouring audio_quality is useless
    // if the dispatch never sends it — which is exactly the state this issue found.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../services/generate-audio.ts"),
      "utf8",
    );
    const at = src.indexOf('createWorkflow("stable_audio_3"');
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, src.indexOf("});", at));
    expect(call).toMatch(/audio_quality: resolved\.audio_quality/);
  });
});

describe("#1458 the audio_quality description matches where it now applies", () => {
  // The fix routed stable_audio_3's SaveAudioMP3 `quality` through the SAME
  // `audio_quality` parameter the ACE family uses. The parameter's own description
  // still said "ACE only", which tells a stable_audio_3 caller the knob does not apply
  // to them - a wrong answer about the tool's own surface, which is the defect class
  // this issue is an instance of. Caught by the review gate probing the enum chain.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../tools/generate-image.ts"),
    "utf8",
  );
  const line = src.split("\n").find((l) => l.includes("SaveAudioMP3 bitrate/quality"));

  it("the description exists and names BOTH families", () => {
    expect(line).toBeDefined();
    expect(line).toMatch(/stable_audio_3/);
    expect(line).toMatch(/ACE/);
  });

  it('no longer claims "ACE only"', () => {
    expect(line).not.toMatch(/ACE only/);
  });

  it("still names the legal values, which the live node reports as V0/128k/320k", () => {
    // Verified against the running server's /object_info/SaveAudioMP3:
    //   quality: ["COMBO", {default: "V0", options: ["V0", "128k", "320k"]}]
    // An enum that drifts from the node definition fails validation exactly the way
    // the omitted input did.
    for (const v of ["V0", "128k", "320k"]) expect(line).toContain(v);
  });
});
