// #1077 Finding 2 — a scope repin that declines must say WHY.
//
// The reporter hit a fence refusal that repeated forever on a session with NO
// relay backend, so the Finding 1 fix (a relay socket carrying no Origin) does
// not explain it. They could not tell which internal branch returned false —
// "no log file, ~/.comfyui-mcp only has session/cache state" — and refreshed,
// closed and reopened the tab before tracing it to source.
//
// This does not claim to reproduce their session. What it does fix is the reason
// they could not diagnose it: `makeScopeRepinHandler` returned a bare
// `undefined` for FOUR different outcomes, and the caller collapsed that to
// `rebound: false`. A healthy pin correctly left alone and a permanent ambiguity
// were the same value.
//
// And one of those four cannot be escaped BY RETRYING. `mode:"current"` picks the
// active tab when it is eligible, or the sole eligible tab — otherwise nothing.
// So when the ACTIVE tab belongs to another backend's conversation and this one
// has two or more tabs, every retry refuses on identical inputs, and nothing in
// the reply hinted that naming a workflow is the way out.
//
// Deliberately NOT called permanent, which the first draft of this claimed: the
// active tab moves on the next `user_message`, so a message sent from one of this
// conversation's own tabs also clears it. Both ways out were invisible; the retry
// loop is the one a stuck caller actually sits in, which is what the report
// describes.

import { describe, expect, it } from "vitest";

import { makeScopeRepinHandler, TurnOriginTracker } from "../../orchestrator/turn-origins.js";

const SCOPE = "orchestrator::claude";

/** A bridge with the tabs and active-tab answer the case under test needs. */
function bridgeWith(opts: {
  tabs: Array<{ tab_id: string }>;
  active?: string;
  reachable?: (tabId: string) => boolean;
  headless?: (tabId: string) => boolean;
}) {
  return {
    tabs: () => opts.tabs,
    canReach: (t: string) => opts.reachable?.(t) ?? false,
    isHeadless: (t: string) => opts.headless?.(t) ?? false,
    resolveActiveScopeTab: () => opts.active,
  };
}

function handlerFor(opts: {
  bridge: ReturnType<typeof bridgeWith>;
  backendForTab: (t: string) => string;
  pin?: string;
}) {
  const tracker = new TurnOriginTracker({
    backendForTab: opts.backendForTab,
    backendOfKey: () => "claude",
    uuidOfTab: () => undefined,
    warn: () => {},
  });
  if (opts.pin) tracker.repinTo(SCOPE, opts.pin);
  return makeScopeRepinHandler({
    bridge: opts.bridge as never,
    tracker,
    scopeAgentKeyOf: () => SCOPE,
    backendForTab: opts.backendForTab,
    backendOfKey: () => "claude",
    info: () => {},
  });
}

describe("a declined repin says which branch declined it (#1077)", () => {
  it("THE STUCK ONE: active tab on another backend, several eligible here", () => {
    // Two tabs for this conversation, and the active tab belongs to codex's.
    // `mode:"current"` cannot name one, so this refuses identically every retry.
    const repin = handlerFor({
      bridge: bridgeWith({
        tabs: [
          { tab_id: "wf:workflows/alpha.json" },
          { tab_id: "wf:workflows/beta.json" },
          { tab_id: "wf:workflows/other.json" },
        ],
        active: "wf:workflows/other.json",
      }),
      backendForTab: (t) =>
        t === "wf:workflows/other.json" ? "codex" : "claude",
    });

    const out = repin(SCOPE);

    expect(typeof out, "must not be a bare undefined").toBe("object");
    expect(out).toMatchObject({ repinned: false });
    const reason = (out as { reason: string }).reason;
    expect(reason, "says how many tabs are eligible").toMatch(/2 eligible tabs/);
    expect(reason, "says the active tab is not one of them").toMatch(/is not among them/);
    // #934's lesson, which this reason repeated: `slice(0, 8)` renders EVERY
    // `wf:workflows/…` id as the literal "wf:workf", so a message naming two
    // different workflow tabs read as naming the same one twice.
    expect(reason, "the tab must be identifiable").toContain("other.json");
    expect(reason).not.toContain("wf:workf ");
    // The way out, which the old reply never mentioned.
    expect(reason).toMatch(/panel_set_workflow_target with a path|panel_open_workflow/);
  });

  it("RETRYING alone cannot change the answer", () => {
    // What made the reporter refresh, close and reopen the tab. Deliberately not
    // called "permanent": the active tab moves on the next user_message, so a
    // message from one of this conversation's own tabs clears it. It is the
    // RETRY that is futile, and that is the loop a stuck caller is in.
    const repin = handlerFor({
      bridge: bridgeWith({
        tabs: [
          { tab_id: "wf:workflows/alpha.json" },
          { tab_id: "wf:workflows/beta.json" },
          { tab_id: "wf:workflows/other.json" },
        ],
        active: "wf:other",
      }),
      backendForTab: (t) => (t === "wf:other" ? "codex" : "claude"),
    });

    expect(repin(SCOPE)).toEqual(repin(SCOPE));
  });

  it("a HEALTHY pin is left alone, and says so rather than looking broken", () => {
    // The outcome that is correct and used to be indistinguishable from failure.
    const repin = handlerFor({
      bridge: bridgeWith({
        tabs: [{ tab_id: "wf:a" }],
        active: "wf:a",
        reachable: () => true,
      }),
      backendForTab: () => "claude",
      pin: "wf:a",
    });

    const reason = (repin(SCOPE) as { reason: string }).reason;
    expect(reason).toMatch(/still reaches a live tab/);
    expect(reason, "and why that is deliberate").toMatch(/dead or ambiguous/);
  });

  it("NO tab on this backend is its own reason, not the ambiguity one", () => {
    const repin = handlerFor({
      bridge: bridgeWith({ tabs: [{ tab_id: "wf:other" }], active: "wf:other" }),
      backendForTab: () => "codex",
    });

    const reason = (repin(SCOPE) as { reason: string }).reason;
    expect(reason).toMatch(/no connected tab belongs to this conversation's backend/);
    expect(reason, "must not blame ambiguity when there is none").not.toMatch(/eligible tabs and/);
  });

  it("STILL repins when it can — the reasons must not replace the recovery", () => {
    // The half that matters most: this is a recovery path, and making it
    // explain itself must not make it stop working.
    const repin = handlerFor({
      bridge: bridgeWith({ tabs: [{ tab_id: "wf:a" }, { tab_id: "wf:b" }], active: "wf:b" }),
      backendForTab: () => "claude",
    });

    expect(repin(SCOPE), "the active eligible tab is chosen").toBe("wf:b");
  });

  it("repins onto the SOLE eligible tab even when the active one is foreign", () => {
    const repin = handlerFor({
      bridge: bridgeWith({
        tabs: [{ tab_id: "wf:a" }, { tab_id: "wf:other" }],
        active: "wf:other",
      }),
      backendForTab: (t) => (t === "wf:other" ? "codex" : "claude"),
    });

    expect(repin(SCOPE)).toBe("wf:a");
  });
});

// THE DELIVERY. Everything above passes with the reason never reaching a tool
// result — the call-site blindness this repo keeps getting caught by, and found
// here by mutation: deleting the line that appends it to the note killed nothing.
// A reason the user never sees fixes none of what Finding 2 reported.
describe("the refusal reaches the tool result (#1077)", () => {
  it("panel_set_workflow_target({mode:'current'}) reports WHY the pin did not move", async () => {
    const { buildPanelToolDefs, makePanelToolCtx } = await import(
      "../../orchestrator/panel-tools.js"
    );
    const { WorkflowTargetStore } = await import("../../services/workflow-target-store.js");

    const REASON =
      'this conversation has 2 eligible tabs and the active one (wf:other) is not among them, ' +
      'so "current" does not identify which to bind';

    const bridge = {
      send: async () => ({ ok: true, workflows: [] }),
      push: () => 1,
      // The scope pin must be PROVABLY dead, or panel-tools returns before the
      // repin is consulted at all — the recovery only fires for a dead pin.
      canReach: (t: string) => t !== "orchestrator::claude",
      isHeadless: () => false,
      tabs: () => [{ tab_id: "live-tab", title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => "live-tab",
      workflowUuidFor: () => ({ known: false, uuid: undefined }),
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
      // The bridge declines and says why — the shape this PR introduces.
      repinScopeToActive: () => ({ repinned: false, reason: REASON }),
    } as never;

    const ctx = makePanelToolCtx(bridge, "orchestrator::claude", new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;
    const res = await def.handler({ mode: "current" }, ctx);

    const text = res.content.map((c: { text?: string }) => c.text ?? "").join("\n");
    // Parse rather than substring-match the raw text: the note is JSON-encoded,
    // so the reason's own quotes arrive escaped and a naive `toContain` fails on
    // formatting rather than on the property being tested.
    const note = String(
      JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).note,
    );

    expect(note, "the reason must be in what the caller reads").toContain(REASON);
    expect(note, "and framed so it is not mistaken for the pin having moved").toMatch(
      /pin was NOT moved/,
    );
  });
});
