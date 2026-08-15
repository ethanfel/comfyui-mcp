// #1334 — a nested seed with NO control_after_generate phantom shifted every widget
// after it, and the API prompt came out silently wrong.
//
// `specHasControlAfterGenerate` INFERS a phantom from "INT named seed/noise_seed/
// rand_seed". That is correct for the frontend's auto-augmented TOP-LEVEL seeds
// (UltimateSDUpscale.seed, KSamplerAdvanced.noise_seed) and wrong for a V3
// dynamic-combo NESTED `seed`, which need not have one at all.
//
// On the reporter's TongzeArkReferenceToVideo (frontend 1.48.7) the row carried no
// phantom, the converter consumed the real next value anyway, and everything after it
// slid by one:
//
//   widget            intended   produced
//   watermark         false      true
//   generate_audio    true       "default"
//   priority          0          172800
//
// The saved UI graph was correct and the live panel widget map was correct; only
// UI→API conversion was wrong — so nothing on screen contradicted it.
//
// THE PHANTOM IS A FRONTEND-OWNED COMBO, so its serialized value is always one of four
// known strings. The slot's own content is therefore better evidence than any inference
// from name and type, and checking it costs nothing when a phantom really is present.

import { describe, expect, it } from "vitest";

import { convertUiToApi } from "../../services/workflow-converter.js";

/** The reporter's node, reduced to what drives the mapping: a dynamic combo whose
 *  selected option nests `seed` (no control_after_generate) followed by three more. */
function arkNodeDef(): Record<string, unknown> {
  return {
    input: {
      required: {
        model: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "doubao-seedance-2-5-260628",
                inputs: {
                  required: {
                    // No control_after_generate flag — this is the whole point.
                    seed: ["INT", { default: -1 }],
                    watermark: ["BOOLEAN", { default: false }],
                    generate_audio: ["BOOLEAN", { default: true }],
                    priority: ["INT", { default: 0 }],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  };
}

/** A node whose nested seed DOES carry a phantom, to prove the skip still happens. */
function seededNodeDef(): Record<string, unknown> {
  return {
    input: {
      required: {
        model: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "m",
                inputs: {
                  required: {
                    seed: ["INT", { default: 0, control_after_generate: true }],
                    watermark: ["BOOLEAN", { default: false }],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  };
}

const OBJECT_INFO = {
  TongzeArkReferenceToVideo: arkNodeDef(),
  SeededArk: seededNodeDef(),
} as unknown as Parameters<typeof convertUiToApi>[1];

function convert(type: string, widgetsValues: unknown[]) {
  const graph = {
    nodes: [{ id: 7, type, widgets_values: widgetsValues, inputs: [] }],
    links: [],
  };
  const { workflow } = convertUiToApi(graph as never, OBJECT_INFO);
  return (workflow as Record<string, { inputs: Record<string, unknown> }>)["7"].inputs;
}

describe("a nested seed WITHOUT a phantom does not eat the next widget (#1334)", () => {
  it("maps the reporter's row exactly as saved", () => {
    // ["model", -1, false, true, 0] — no phantom anywhere in it.
    const inputs = convert("TongzeArkReferenceToVideo", [
      "doubao-seedance-2-5-260628",
      -1,
      false,
      true,
      0,
    ]);

    expect(inputs["model.seed"]).toBe(-1);
    // Each of these was wrong before, by exactly one slot.
    expect(inputs["model.watermark"]).toBe(false);
    expect(inputs["model.generate_audio"]).toBe(true);
    expect(inputs["model.priority"]).toBe(0);
  });

  it("a nested seed WITH a phantom still skips it — the inference is not lost", () => {
    // The direction that would break real workflows if the fix were a blanket removal:
    // when the slot IS a control mode it must still be consumed, or the following
    // widget shifts the other way.
    const inputs = convert("SeededArk", ["m", 12345, "randomize", true]);

    expect(inputs["model.seed"]).toBe(12345);
    expect(inputs["model.watermark"]).toBe(true); // not "randomize"
  });

  it("every control mode is recognised, not just randomize", () => {
    for (const mode of ["fixed", "randomize", "increment", "decrement"]) {
      const inputs = convert("SeededArk", ["m", 1, mode, true]);
      expect(inputs["model.watermark"]).toBe(true);
    }
  });

  it("a phantom-flagged seed at the END of the row does not over-consume", () => {
    // Nothing follows the seed, so there is no slot to skip and nothing to shift.
    const inputs = convert("SeededArk", ["m", 99]);
    expect(inputs["model.seed"]).toBe(99);
  });
});
