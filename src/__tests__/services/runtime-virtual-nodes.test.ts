// #1372 — `list_packs(action:"check_runtime")` returned runtime:"unknown" because
// MarkdownNote was in unknownNodes, which stops the paid-API safety flow to ask a question
// that already has an answer.
//
// The "unknown" verdict expresses a specific and correct doubt: this class_type is absent
// from the server's registry, so it COULD be a paid partner node the server does not
// expose, and claiming "local/free" would be a guess with someone's money on it.
//
// It just cannot apply to a node that does not execute. MarkdownNote, Note, Reroute and
// PrimitiveNode are LiteGraph-native — the frontend registers them, /object_info never
// lists them, and they are stripped before a prompt is queued. A virtual node can no more
// be a paid API node than it can be a checkpoint loader.
//
// MEASURED, not assumed: across four real pack workflows checked against this machine's
// live /object_info, every class_type that landed in unknownNodes was frontend-only —
// GetNode, SetNode, Note, "Label (rgthree)", "Fast Groups Bypasser (rgthree)", "Fast Groups
// Muter (rgthree)". None of them executes anywhere, let alone on a paid API.

import { describe, expect, it } from "vitest";

import { checkWorkflowRuntime } from "../../services/api-nodes.js";
import {
  FRONTEND_ONLY_NODE_TYPES,
  NON_EXECUTING_NODE_TYPES,
} from "../../services/workflow-converter.js";

const KSAMPLER = { input: { required: { seed: ["INT"] } }, output: ["LATENT"], name: "KSampler" };
/** An API node as the classifier recognises one. */
const API_NODE = {
  input: { required: {} },
  output: ["IMAGE"],
  name: "FluxProImageNode",
  api_node: true,
};

function graphOf(...types: string[]): unknown {
  return {
    nodes: types.map((type, i) => ({ id: i + 1, type, widgets_values: [] })),
    links: [],
  };
}

function depsWith(objectInfo: Record<string, unknown>) {
  return { getObjectInfo: async () => objectInfo } as never;
}

describe("a frontend-only node is not an unknown runtime (#1372)", () => {
  it("THE REPORTED CASE: a local workflow with MarkdownNote is local, not unknown", async () => {
    const r = await checkWorkflowRuntime(graphOf("KSampler", "MarkdownNote"), depsWith({ KSampler: KSAMPLER }));
    expect(r.runtime).toBe("local");
    expect(r.usesApiNodes).toBe(false);
    expect(r.unknownNodes).toEqual([]);
  });

  it("every type in the shared set is treated the same way", async () => {
    // Imported from the converter, so this cannot drift from the list that decides what
    // gets stripped before queueing.
    for (const t of NON_EXECUTING_NODE_TYPES) {
      const r = await checkWorkflowRuntime(graphOf("KSampler", t), depsWith({ KSampler: KSAMPLER }));
      expect(r.runtime, `${t} must not make the runtime unknown`).toBe("local");
      expect(r.unknownNodes, `${t} must not be reported as unknown`).toEqual([]);
    }
  });

  it("a REGISTERED node that collides with a virtual name is still classified (codex P1)", async () => {
    // THE SAFETY HOLE. The skip used to run before the /object_info lookup, so a
    // third-party backend node legitimately named "Note" — registered, executable, and
    // api_node:true — was skipped unexamined and the workflow reported "local /
    // usesApiNodes:false". That tells the agent the run is confirmed FREE and skips the
    // credit confirmation, which is the one outcome this classifier exists to prevent.
    //
    // Absence from the registry is not a heuristic for "virtual", it is the definition.
    const r = await checkWorkflowRuntime(
      graphOf("KSampler", "Note"),
      depsWith({ KSampler: KSAMPLER, Note: { ...API_NODE, name: "Note" } }),
    );
    expect(r.runtime, "a registered api_node must never be skipped as virtual").toBe("mixed");
    expect(r.usesApiNodes).toBe(true);
  });

  it("…and a registered LOCAL node of the same name is classified local, not skipped", async () => {
    const r = await checkWorkflowRuntime(
      graphOf("Note"),
      depsWith({ Note: { input: { required: {} }, output: [], name: "Note" } }),
    );
    expect(r.runtime).toBe("local");
    expect(r.usesApiNodes).toBe(false);
  });

  it("a GENUINELY unrecognised node still collapses the verdict — the doubt is preserved", async () => {
    // The over-broad direction. If this stopped refusing, the safety flow would claim
    // "free" for a workflow that might contain a paid partner node.
    const r = await checkWorkflowRuntime(
      graphOf("KSampler", "SomeUninstalledPackNode"),
      depsWith({ KSampler: KSAMPLER }),
    );
    expect(r.runtime).toBe("unknown");
    expect(r.usesApiNodes).toBeNull();
    expect(r.unknownNodes).toEqual(["SomeUninstalledPackNode"]);
  });

  it("virtual nodes leave the DENOMINATOR too, or an all-local graph reads as mixed", async () => {
    // One API node plus three Notes was 1-of-4 classifiable → "mixed". The notes are not
    // evidence of anything, in either direction.
    const r = await checkWorkflowRuntime(
      graphOf("FluxProImageNode", "Note", "Note", "MarkdownNote"),
      depsWith({ FluxProImageNode: API_NODE }),
    );
    expect(r.runtime).toBe("api");
    expect(r.usesApiNodes).toBe(true);
  });

  it("a workflow of ONLY virtual nodes is local, not unknown and not a division by zero", async () => {
    const r = await checkWorkflowRuntime(graphOf("Note", "MarkdownNote"), depsWith({}));
    expect(r.runtime).toBe("local");
    expect(r.usesApiNodes).toBe(false);
  });

  it("an API node is still detected when a virtual node sits beside it", async () => {
    const r = await checkWorkflowRuntime(
      graphOf("KSampler", "FluxProImageNode", "MarkdownNote"),
      depsWith({ KSampler: KSAMPLER, FluxProImageNode: API_NODE }),
    );
    expect(r.runtime).toBe("mixed");
    expect(r.usesApiNodes).toBe(true);
  });
});

// #1400 — the follow-up. #1372 covered the four LiteGraph-NATIVE virtuals, which left the
// larger half of the measured population: KJNodes Get/Set bus nodes. In the same four-pack
// measurement they were the most common entries by far — 3x GetNode, 3x SetNode against
// 2x Note — so a Get/Set-routed workflow still collapsed to "unknown" and still stopped the
// safety flow.
//
// The converter has ALWAYS known these never reach the backend: `deVirtualize` strips the
// whole Get/Set bus before a prompt is built, rewriting each consumer's link to the real
// upstream source. So this is not a new list of third-party names to keep current — it is
// the classifier finally consulting the list the converter must already keep correct, for
// a reason far more load-bearing than this verdict (a stale entry there drops links).
describe("a Get/Set bus node is not an unknown runtime (#1400)", () => {
  it("THE REPORTED CASE: a Get/Set-routed local workflow is local, not unknown", async () => {
    const r = await checkWorkflowRuntime(
      graphOf("KSampler", "GetNode", "SetNode"),
      depsWith({ KSampler: KSAMPLER }),
    );
    expect(r.runtime).toBe("local");
    expect(r.usesApiNodes).toBe(false);
    expect(r.unknownNodes).toEqual([]);
  });

  it("every wiring virtual the CONVERTER strips is treated the same way", async () => {
    // Imported, not restated: if the converter learns a new bus type, the classifier
    // learns it in the same commit or this fails.
    for (const t of FRONTEND_ONLY_NODE_TYPES) {
      const r = await checkWorkflowRuntime(graphOf("KSampler", t), depsWith({ KSampler: KSAMPLER }));
      expect(r.runtime, `${t} must not make the runtime unknown`).toBe("local");
      expect(r.unknownNodes, `${t} must not be reported as unknown`).toEqual([]);
    }
  });

  it("the shared set CONTAINS both halves — natives and wiring virtuals", async () => {
    // Guards the union itself: dropping either half would leave the other's tests green.
    for (const t of NON_EXECUTING_NODE_TYPES) expect(FRONTEND_ONLY_NODE_TYPES.has(t)).toBe(true);
    for (const t of ["GetNode", "SetNode", "PRO_GetNode", "PRO_SetNode"]) {
      expect(FRONTEND_ONLY_NODE_TYPES.has(t), `${t} must be classified frontend-only`).toBe(true);
    }
  });

  it("a REGISTERED backend node named GetNode is still examined, not skipped", async () => {
    // The #1396 codex P1, inherited: the skip applies only when the server does NOT
    // register the type. A third-party backend node that happens to be called GetNode —
    // and is a paid API node — must not be waved through unexamined.
    const r = await checkWorkflowRuntime(
      graphOf("KSampler", "GetNode"),
      depsWith({ KSampler: KSAMPLER, GetNode: API_NODE }),
    );
    expect(r.runtime).toBe("mixed");
    expect(r.usesApiNodes).toBe(true);
    expect(r.apiNodes).toContain("GetNode");
  });

  it("bus nodes leave the DENOMINATOR too — one API node beside a bus is 'api', not 'mixed'", async () => {
    // The ratio decides "api" vs "mixed". A virtual node is not classifiable in either
    // direction, so counting it as classifiable makes an all-paid workflow read as
    // partly local — the same arithmetic #1372 fixed for Notes, which the Get/Set half
    // would otherwise reintroduce. (Mutation testing found nothing covered this.)
    const r = await checkWorkflowRuntime(
      graphOf("FluxProImageNode", "GetNode", "SetNode"),
      depsWith({ FluxProImageNode: API_NODE }),
    );
    expect(r.runtime).toBe("api");
    expect(r.usesApiNodes).toBe(true);
  });

  it("rgthree's canvas-only nodes are still UNKNOWN — cautious, and deliberately so", async () => {
    // The rest of #1400's population (Label, Fast Groups Bypasser/Muter) is NOT covered.
    // The converter does not strip them, so nothing here can prove they never execute, and
    // guessing "free" is a guess with someone's money on it. Recorded as a test so the gap
    // is a decision rather than an oversight.
    const r = await checkWorkflowRuntime(
      graphOf("KSampler", "Fast Groups Bypasser (rgthree)"),
      depsWith({ KSampler: KSAMPLER }),
    );
    expect(r.runtime).toBe("unknown");
    expect(r.unknownNodes).toEqual(["Fast Groups Bypasser (rgthree)"]);
  });
});
