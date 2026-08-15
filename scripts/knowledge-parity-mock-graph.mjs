/**
 * The knowledge-parity smoke's MOCK CANVAS — its own module so the tests can call it.
 *
 * These executors decide whether the smoke tells the truth. When they were inline in a
 * script that connects to ComfyUI at import, nothing could exercise them, so the tests
 * asserted on source TEXT — and mutation testing showed exactly what that is worth: wrapping
 * the `graph_load` refusal in `if (false)` left every assertion green while the mock went
 * back to reporting a successful load of nothing.
 *
 * Same move, same reason, as plugin/scripts/monitor-timeout.mjs (#1385).
 */

/** A UI workflow's node list, when this object carries one. */
function nodeArray(v) {
  return Array.isArray(v?.nodes) ? v.nodes : undefined;
}

/**
 * An API-format prompt: `{ "1": { class_type, inputs }, "2": {…} }`. Recognised only when
 * EVERY key is numeric and every value looks like a node — a workflow object with two
 * unrelated keys must not be mistaken for one, or the refusal stops meaning anything.
 */
function nodeIdMap(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries = Object.entries(v);
  if (!entries.length) return undefined;
  if (!entries.every(([k, node]) => /^\d+$/.test(k) && node && typeof node === "object")) {
    return undefined;
  }
  return entries.map(([id, node]) => ({ id: Number(id), type: node.class_type ?? node.type, ...node }));
}

/** A SHAPE, never the payload: a workflow can carry prompts and paths, and this string
 *  goes into a transcript. */
export function describeShape(value) {
  if (value === null || value === undefined) return "nothing";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value);
  return `an object with keys [${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ", …" : ""}]`;
}

/**
 * The workflow identity this mock tab holds.
 *
 * It lives HERE, not in the smoke script. When the executors were extracted it stayed
 * behind in the script's lexical scope, and ES modules do not share that — so
 * `workflow_list` threw a ReferenceError and answered `ok:false` on every call. Nothing
 * caught it: the new tests never called `workflow_list`, and the one smoke run afterwards
 * happened not to reach it. An extraction is a behaviour change until something proves
 * otherwise (codex).
 */
export const MOCK_WORKFLOW_UUID = "11111111-1111-4111-8111-111111111111";

export function makeGraph() {
  let seq = 0;
  const nodes = new Map();
  const add = (type, title) => {
    const id = ++seq;
    nodes.set(id, {
      id, type, title: title || type, is_subgraph: false,
      widgets: { value: 0, text: "" },
      inputs: [{ name: "in0", type: "*", link: null }, { name: "model", type: "MODEL", link: null }],
      outputs: [{ name: "out0", type: "*", links: [] }, { name: "MODEL", type: "MODEL", links: [] }],
    });
    return nodes.get(id);
  };
  const brief = (n) => ({ id: n.id, type: n.type, title: n.title, is_subgraph: !!n.is_subgraph, widgets: n.widgets, inputs: n.inputs, outputs: n.outputs });
  const need = (id) => { const n = nodes.get(Number(id)); if (!n) throw new Error(`No node ${id}`); return n; };
  const EXEC = {
    graph_get_state: () => ({ viewing: { scope: "root" }, node_count: nodes.size, truncated: false, nodes: [...nodes.values()].map(brief) }),
    graph_add_node: ({ class_type, title }) => { if (!class_type) throw new Error("class_type required"); return { added: brief(add(class_type, title)) }; },
    graph_remove_node: ({ node_id }) => { const n = need(node_id); nodes.delete(Number(node_id)); return { removed: brief(n) }; },
    graph_clear: () => { const c = nodes.size; nodes.clear(); return { cleared: c }; },
    // #1384 — without this the preferred one-shot panel_load_workflow(pack:…) path cannot
    // complete, so the smoke could only reach the capability by the long route.
    graph_load: (m) => {
      // ACCEPT THE SHAPES A WORKFLOW ACTUALLY ARRIVES IN. Reading only `workflow.nodes`
      // meant a pack workflow that nests them elsewhere loaded ZERO nodes — and the mock
      // then honestly reported `node_count: 0` for a 16-node graph, which an agent
      // correctly read as the panel silently dropping its workflow and filed as a panel
      // defect (comfyui-mcp-panel#1068). The observation was right; the panel it was
      // observing was this file.
      const wf = m.workflow ?? m.graph ?? m.data ?? m;
      const incoming =
        nodeArray(wf) ??
        nodeArray(wf?.workflow) ??
        nodeArray(wf?.prompt) ??
        // AN API-FORMAT PROMPT IS A MAP KEYED BY NODE ID, and a real panel accepts one.
        // Refusing it made the smoke fail where the product passes — a harness false
        // NEGATIVE, which is the same class of lie as the false success this refusal was
        // added to stop, just pointed the other way (codex).
        nodeIdMap(wf?.prompt) ??
        nodeIdMap(wf);
      // REFUSE, do not report a successful load of nothing (codex). An API-format prompt
      // is an object keyed by node id, not an array, and falling through to `[]` cleared
      // the canvas and answered `node_count: 0` — a successful-looking load that loaded
      // nothing, which is the exact false success this harness exists to detect elsewhere.
      if (!incoming) {
        throw new Error(
          `graph_load: this SMOKE MOCK understands a UI workflow with a nodes[] array ` +
            `(at .nodes, .workflow.nodes or .prompt.nodes); it was handed ${describeShape(wf)}. ` +
            `Nothing was loaded and the canvas is unchanged.`,
        );
      }
      nodes.clear();
      for (const n of incoming) {
        const id = Number(n.id ?? nodes.size + 1);
        nodes.set(id, {
          id,
          type: n.type ?? "Unknown",
          title: n.title ?? n.type ?? "Unknown",
          widgets: {},
          inputs: [],
          outputs: [],
        });
      }
      return { loaded: { node_count: nodes.size } };
    },
    graph_connect: ({ from_node_id, to_node_id }) => ({ connected: { from: { node_id: from_node_id }, to: { node_id: to_node_id } } }),
    graph_disconnect: ({ node_id }) => ({ disconnected: { node_id } }),
    graph_set_widget: ({ node_id, widget, value }) => { const n = need(node_id); const p = n.widgets[widget]; n.widgets[widget] = value; return { set: { node_id, widget, previous: p, value } }; },
    graph_set_title: ({ node_id, title }) => { const n = need(node_id); const p = n.title; n.title = title; return { node_id, previous: p, title }; },
    graph_move_node: ({ node_id, pos }) => ({ moved: { node_id, to: pos } }),
    graph_canvas: ({ action }) => ({ canvas: { action } }),
    graph_run: ({ batch_count }) => ({ queued: true, batch_count: batch_count ?? 1 }),
    graph_get_errors: () => ({ last_execution_error: null, node_errors: null, note: "no errors" }),
    workflow_save: () => ({ saved: true }),
    workflow_save_as: ({ name }) => ({ saved_as: `workflows/${name}.json` }),
    workflow_new: () => ({ created: true }),
    workflow_open: ({ path }) => ({ opened: { path } }),
    // The ACTIVE record must carry a workflow_uuid (#1384). Without one the tab is
    // identity-less, so `rebindWorkflowFence` reports `no_uuid` and every graph WRITE stays
    // refused — the same class of refusal the report opened with, one fence further in.
    // The refusal is correct product behaviour: the mock was the thing lying, by claiming a
    // panel version new enough to stamp per-workflow identity while advertising none.
    workflow_list: () => ({
      active: {
        path: "workflows/current.json",
        filename: "current.json",
        key: "cur",
        workflow_uuid: MOCK_WORKFLOW_UUID,
      },
      workflows: [
        {
          path: "workflows/current.json",
          filename: "current.json",
          key: "cur",
          workflow_uuid: MOCK_WORKFLOW_UUID,
          active: true,
        },
      ],
      open: [],
    }),
    // COMMANDS THE ADVERTISED VERSION IMPLIES (comfyui-mcp-panel#1068). The hello claims a
    // panel new enough for the whole bridge set; throwing `unknown graph_outline` at an
    // agent that checked the version first is the mock lying again, and this time the agent
    // did the right thing with the lie — it treated a missing capability as a defect and
    // filed a report against the real panel.
    //
    // THEIR REPLY SHAPES ARE THE PRODUCT'S, not plausible-looking inventions (codex). A
    // reply the orchestrator has to reinterpret makes the smoke exercise a path no real
    // panel takes, which is a different kind of lie with the same cost.
    graph_outline: () => ({
      // ONE STRING. `panel_graph_outline` promises `outline` and bounds it by max_chars;
      // an object of nodes here would be reported as a panel that ignores the contract.
      outline:
        `root (${nodes.size} node(s))\n` +
        [...nodes.values()].map((n) => `  #${n.id} ${n.type} — ${n.title}`).join("\n"),
    }),
    graph_find_nodes: ({ query, types, title, limit }) => {
      const q = String(query ?? title ?? "").toLowerCase();
      const wanted = Array.isArray(types) ? types.map((t) => String(t).toLowerCase()) : [];
      const all = [...nodes.values()].filter((n) => {
        const hay = `${n.type} ${n.title}`.toLowerCase();
        return (!q || hay.includes(q)) && (!wanted.length || wanted.some((t) => n.type.toLowerCase().includes(t)));
      });
      // `matches`, plus the cap semantics the product tool relies on: a capped result is
      // explicitly NOT a complete match set, and a caller that cannot tell will treat a
      // truncated answer as exhaustive.
      const cap = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 40;
      return {
        matches: all.slice(0, cap).map(brief),
        total: all.length,
        truncated: all.length > cap,
      };
    },
    // `nodes_list` is DELIBERATELY NOT IMPLEMENTED. In the product it lists the custom-node
    // PACKS installed via the user's Manager — not canvas nodes, which is what a naive
    // reading of the name produces and what the first version of this returned. This mock
    // has no Manager and no packs, so any answer it gives is a fabricated Manager state: an
    // empty list says "nothing installed" and sends a dependency check off to install
    // things, and a populated one is simply invented. The unknown-command error names the
    // harness, which is the honest answer here.
    graph_select_nodes: ({ node_ids }) => ({ selected: node_ids }),
    set_todo: ({ items }) => ({ ok: true, count: (items || []).length }),
    ask_user: (m) => (m.options && m.options[0] && m.options[0].label) || "yes",
  };
  return { nodes, EXEC };
}

/**
 * The smoke's PASS/FAIL, as a function rather than an expression buried in a report.
 *
 * `builtOnCanvas` is part of it. It was printed as one of the four criteria and left out of
 * the verdict (codex), so a run that discovered the pack and applied NOTHING passed while
 * printing "built nodes on the live canvas: NO" — including the zero-node load this mock
 * used to produce.
 */
export function parityVerdict({ discovery, discoveredKrea2, appliedPack, builtOnCanvas }) {
  // `appliedPack` is required as well (codex). Without it an agent could read the Krea2
  // knowledge, drop one unrelated node on the canvas, and PASS — which demonstrates that
  // it can add a node, not that it used what it read.
  return Boolean(discovery && discoveredKrea2 && appliedPack && builtOnCanvas);
}
