import { describe, expect, it } from "vitest";
import {
  makeGraph,
  parityVerdict,
  describeShape,
  MOCK_WORKFLOW_UUID,
} from "../../../scripts/knowledge-parity-mock-graph.mjs";

/**
 * The mock canvas's executors, exercised rather than grepped (#1384).
 *
 * The previous versions of these checks read the script's SOURCE TEXT, and mutation testing
 * showed what that buys: wrapping the `graph_load` refusal in `if (false)` left every
 * assertion green while the mock went back to reporting a successful load of nothing — the
 * false success this harness exists to detect in the product.
 */
describe("#1384 — the mock's graph_load", () => {
  it("loads a UI workflow from any of the shapes one arrives in", () => {
    for (const payload of [
      { workflow: { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "CLIPTextEncode" }] } },
      { workflow: { workflow: { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "X" }] } } },
      { workflow: { prompt: { nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "X" }] } } },
    ]) {
      const { EXEC } = makeGraph();
      expect(EXEC.graph_load(payload).loaded.node_count).toBe(2);
    }
  });

  it("loads an API-format prompt — a node-id map, which a real panel accepts", () => {
    // Refusing this made the smoke fail where the PRODUCT passes: a harness false
    // negative, the same class of lie as the false success the refusal was added to stop
    // (codex). Recognised only when every key is numeric and every value is an object, so
    // an ordinary workflow with two unrelated keys is still refused.
    const { nodes, EXEC } = makeGraph();
    const out = EXEC.graph_load({
      workflow: { prompt: { "1": { class_type: "KSampler" }, "2": { class_type: "CLIPTextEncode" } } },
    });
    expect(out.loaded.node_count).toBe(2);
    expect(nodes.size).toBe(2);
  });

  it("REFUSES a shape it cannot read instead of reporting a load of nothing", () => {
    const { nodes, EXEC } = makeGraph();
    EXEC.graph_add_node({ class_type: "KSampler" });
    expect(nodes.size).toBe(1);

    // Neither an array nor a node-id map: nothing here says how to build a canvas. This
    // used to fall through to an empty list, CLEAR the canvas, and answer node_count: 0.
    expect(() => EXEC.graph_load({ workflow: { format: "v2", data: "…" } })).toThrow(
      /SMOKE MOCK understands/,
    );
    // …and the canvas it could not load into is untouched, which is what "nothing was
    // loaded" has to mean.
    expect(nodes.size).toBe(1);
  });

  it("names the SHAPE it was handed, never the payload", () => {
    // A workflow carries prompts and paths, and this string goes into a transcript.
    const { EXEC } = makeGraph();
    const err = (() => {
      try {
        EXEC.graph_load({ workflow: { note: "a very private prompt", format: "v2" } });
        return "";
      } catch (e) {
        return String((e as Error).message);
      }
    })();
    expect(err).toMatch(/an object with keys/);
    expect(err).not.toMatch(/private prompt/);
    expect(describeShape([1, 2, 3])).toBe("an array of 3");
    expect(describeShape(undefined)).toBe("nothing");
  });
});

describe("#1384 — the mock's read commands answer in the product's shapes", () => {
  it("graph_outline returns ONE string", () => {
    const { EXEC } = makeGraph();
    EXEC.graph_add_node({ class_type: "KSampler", title: "sampler" });
    const out = EXEC.graph_outline({});
    // `panel_graph_outline` promises `outline` and bounds it by max_chars; an object of
    // nodes would be reported as a panel ignoring its own contract.
    expect(typeof out.outline).toBe("string");
    expect(out.outline).toMatch(/KSampler/);
    expect(out).not.toHaveProperty("nodes");
  });

  it("graph_find_nodes returns matches with the cap semantics the tool relies on", () => {
    const { EXEC } = makeGraph();
    for (let i = 0; i < 5; i++) EXEC.graph_add_node({ class_type: "KSampler" });
    EXEC.graph_add_node({ class_type: "CLIPTextEncode" });

    const all = EXEC.graph_find_nodes({ query: "ksampler" });
    expect(all.matches).toHaveLength(5);
    expect(all.total).toBe(5);
    expect(all.truncated).toBe(false);

    // A capped result is explicitly NOT a complete match set — a caller that cannot tell
    // treats a truncated answer as exhaustive.
    const capped = EXEC.graph_find_nodes({ query: "ksampler", limit: 2 });
    expect(capped.matches).toHaveLength(2);
    expect(capped.total).toBe(5);
    expect(capped.truncated).toBe(true);
  });

  it("nodes_list is absent, because this mock has no Manager to describe", () => {
    // In the product it lists installed custom-node PACKS. Any answer here is a fabricated
    // Manager state: empty sends a dependency check off to install things, populated is
    // invented. The unknown-command error names the harness instead.
    const { EXEC } = makeGraph();
    expect(EXEC).not.toHaveProperty("nodes_list");
  });
});

describe("#1384 — the verdict", () => {
  it("requires the canvas to have actually changed", () => {
    // Printed as one of four criteria and left out of the verdict, so a run that discovered
    // the pack and applied nothing passed while reporting "built nodes: NO".
    const all = { discovery: true, discoveredKrea2: true, appliedPack: true, builtOnCanvas: true };
    expect(parityVerdict(all)).toBe(true);
    // Every criterion is load-bearing, including `appliedPack` — without it an agent could
    // read the Krea2 knowledge, drop one unrelated node, and PASS, which demonstrates that
    // it can add a node rather than that it used what it read (codex).
    for (const missing of ["discovery", "discoveredKrea2", "appliedPack", "builtOnCanvas"]) {
      expect(parityVerdict({ ...all, [missing]: false }), `${missing} must matter`).toBe(false);
    }
  });
});

describe("#1384 — workflow_list, which nothing called", () => {
  it("answers with this tab's workflow identity", () => {
    // The extraction left MOCK_WORKFLOW_UUID behind in the old script's lexical scope, so
    // this threw a ReferenceError and answered ok:false on every call — invisible because
    // no test called it and the one smoke run afterwards happened not to reach it. An
    // extraction is a behaviour change until something proves otherwise.
    const { EXEC } = makeGraph();
    const out = EXEC.workflow_list({});
    expect(out.active.workflow_uuid).toBe(MOCK_WORKFLOW_UUID);
    expect(out.workflows[0].workflow_uuid).toBe(MOCK_WORKFLOW_UUID);
    // …and it is a well-formed uuid, or the per-command stamp fence has nothing to fence on.
    expect(MOCK_WORKFLOW_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("EVERY executor answers without throwing", () => {
    // The general form of the bug above: an extracted executor that references something
    // left behind fails only when called. Calling each one with a plausible argument is
    // cheap and would have caught it.
    // A FRESH GRAPH PER EXECUTOR. Sharing one canvas made this order-dependent: whichever
    // executor ran first could clear or delete what the next one was handed, so the loop
    // failed on state rather than on the thing it is checking.
    const names = Object.keys(makeGraph().EXEC);
    for (const name of names) {
      const { EXEC } = makeGraph();
      const added = EXEC.graph_add_node({ class_type: "KSampler" }).added;
      const args: Record<string, unknown> = {
        node_id: added.id,
        from_node_id: added.id,
        to_node_id: added.id,
        class_type: "KSampler",
        widget: "seed",
        value: 1,
        title: "t",
        node_ids: [added.id],
        items: [],
        query: "k",
        workflow: { nodes: [{ id: 1, type: "KSampler" }] },
        pos: [0, 0],
        mode: 0,
      };
      expect(
        () => (EXEC[name] as (m: unknown) => unknown)(args),
        `${name} must not throw`,
      ).not.toThrow();
    }
  });
});
