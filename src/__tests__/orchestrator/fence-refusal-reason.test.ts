// #1077 — a refused fence adoption that cannot say which gate refused it.
//
// The orchestrator's validator has THREE independent gates: the routed tab is
// unreachable, it does not resolve to a live panel tab, or the workflow identity
// did not validate. Every one returned a bare `false`, so the tool could only
// report "The adoption was REFUSED" and offer one remedy — refresh the tab.
//
// That is unactionable in general and WRONG in one specific case. Identity is
// bound to the connection's server-observed Origin, and a relay-backend
// connection had none: `attachRelayConnection(sock)` called `handleConnection(sock)`
// with no origin argument, and the relay protocol does not forward the browser's
// handshake Origin. So `workflowIdentityParts()` could never validate, the fence
// could NEVER be adopted, and no amount of refreshing changed it. The reporter
// refreshed repeatedly and closed and reopened the tab before tracing it to source.
//
// THE RELAY HALF IS NOW FIXED and the wording moved with it: the Origin identifies
// where the panel page is SERVED FROM, which is the ComfyUI the session already
// points at, so `setupRelayBridge` supplies it from COMFYUI_URL and no relay
// protocol change was needed. What remains here is the diagnosis for a connection
// that genuinely has no origin from any source.
//
// They also had no orchestrator log to read, which is why the reason has to reach
// the TOOL RESULT and not just stderr.

import { describe, expect, it } from "vitest";
import { UiBridge } from "../../services/ui-bridge.js";
import { NO_ORIGIN_REMEDY, identityReason, unreachableReason } from "../../orchestrator/fence-refusal.js";
import { workflowIdentityParts } from "../../orchestrator/session-store.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";

/** The bridge is the seam: the orchestrator injects the validator, and the tool
 *  layer reads back the reason. Driving it here keeps the test on the contract
 *  rather than on either side's internals. */
function bridgeWithValidator(
  refresh: (tabId: string, uuid: string) => boolean | { ok: true } | { ok: false; reason: string },
): UiBridge {
  const b = new UiBridge(0);
  b.setTabWorkflowUuidResolver(() => undefined, refresh);
  return b;
}

const UUID = "11111111-2222-4333-8444-555555555555";

describe("a refused adoption records WHY", () => {
  it("exposes the validator's reason to the caller", () => {
    const b = bridgeWithValidator(() => ({
      ok: false,
      reason: "the routed tab (wf:x) is no longer reachable, so there is nothing to fence",
    }));

    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(false);
    expect(b.lastFenceRefusal("wf:x")).toMatch(/no longer reachable/);
  });

  it("keeps reasons per-tab, so one wedged tab cannot explain another", () => {
    const b = bridgeWithValidator((tabId) =>
      tabId === "wf:a" ? { ok: false, reason: "reason for A" } : { ok: true },
    );

    b.refreshWorkflowUuid("wf:a", UUID);
    b.refreshWorkflowUuid("wf:b", UUID);

    expect(b.lastFenceRefusal("wf:a")).toBe("reason for A");
    expect(b.lastFenceRefusal("wf:b")).toBeUndefined();
  });

  it("clears the reason once an adoption succeeds — it must not outlive its state", () => {
    let refuse = true;
    const b = bridgeWithValidator(() => (refuse ? { ok: false, reason: "temporarily wedged" } : { ok: true }));

    b.refreshWorkflowUuid("wf:x", UUID);
    expect(b.lastFenceRefusal("wf:x")).toBe("temporarily wedged");

    refuse = false;
    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(true);
    expect(b.lastFenceRefusal("wf:x")).toBeUndefined();
  });

  // Backward compatibility: the resolver may be a plain boolean (tests register
  // one, and an older injection would too). It must keep working, just without a
  // reason to report.
  it("still accepts a plain boolean validator", () => {
    const b = bridgeWithValidator(() => false);

    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(false);
    expect(b.lastFenceRefusal("wf:x")).toBeUndefined();

    const ok = bridgeWithValidator(() => true);
    expect(ok.refreshWorkflowUuid("wf:x", UUID)).toBe(true);
  });

  it("reports false when no validator is registered at all", () => {
    const b = new UiBridge(0);
    expect(b.refreshWorkflowUuid("wf:x", UUID)).toBe(false);
  });
});

// The half that matters to the person reading the tool result.
describe("the refusal message names the gate and matches the remedy to it", () => {
  const setTarget = () =>
    buildPanelToolDefs().find((d) => d.name === "panel_set_workflow_target")!;

  /** A panel that answers workflow_list with a corroborated live identity, so the
   *  rebind reaches the ADOPT step — which is the step being refused. */
  function ctxRefusing(reason: string): PanelToolCtx {
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "workflow_list") {
          return {
            active: {
              path: "workflows/a.json",
              filename: "a.json",
              key: "wf:workflows/a.json",
              routing_key: "wf:workflows/a.json",
              workflow_uuid: UUID,
            },
            active_confirmed: true,
            workflows: [
              {
                path: "workflows/a.json",
                filename: "a.json",
                key: "wf:workflows/a.json",
                routing_key: "wf:workflows/a.json",
                active: true,
                persisted: true,
              },
            ],
          };
        }
        return { ok: true };
      },
      push: () => 1,
      canReach: () => true,
      isHeadless: () => false,
      tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
      resolveActiveTabId: () => "tab-1",
      workflowUuidFor: () => ({ known: true, uuid: "99999999-8888-4777-a666-555555555555" }),
      refreshWorkflowUuid: () => false, // the adoption is refused…
      lastFenceRefusal: () => reason, // …and this is why
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    return makePanelToolCtx(bridge, "tab-1", new WorkflowTargetStore());
  }

  const textOf = (res: { content: Array<{ text?: string }> }): string => res.content[0]!.text ?? "";

  it("quotes the reason instead of listing two causes and shrugging", async () => {
    const text = textOf(
      await setTarget().handler({ mode: "current" }, ctxRefusing("the routed tab (wf:x) is no longer reachable")),
    );

    expect(text).toMatch(/refused it because the routed tab \(wf:x\) is no longer reachable/);
    // The old text offered both causes and let the reader pick.
    expect(text).not.toMatch(/this bridge could not say which/);
  });

  // THE ONE THAT COST THE REPORTER THE SESSION. A structural refusal must not be
  // answered with "refresh the tab" — they did that, repeatedly, and closed and
  // reopened the tab too.
  it("does NOT tell the user to refresh when the gate is structural", async () => {
    const text = textOf(
      await setTarget().handler(
        { mode: "current" },
        ctxRefusing(
          "this tab's connection carries no server-observed Origin, and the workflow identity is bound to one",
        ),
      ),
    );

    // Its intent is unchanged: a structural gate must not be answered with a
    // refresh. Its WORDING moved to the shared NO_ORIGIN_REMEDY (panel#1065),
    // because the copy asserted here had gone stale — it still told the user to
    // abandon the relay backend and to report a protocol gap that #1240 closed,
    // which is how panel#1065 came to be filed, quoting this exact sentence.
    expect(text).toMatch(/Refreshing the tab will not change either case/i);
    expect(text).toContain(NO_ORIGIN_REMEDY);
    // The advice that cost a working setup must be gone, not merely reworded.
    expect(text).not.toMatch(/COMFYUI_MCP_TUNNEL_BACKEND=relay/);
    expect(text).not.toMatch(/forward the browser'?s handshake Origin/i);
    // The real remedy has to be the one they are actually given — and it has to be
    // true for a NON-relay caller too, so it names both causes rather than one.
    expect(text).toMatch(/On a RELAY connection/);
    expect(text).toMatch(/On any other path/);
    // The generic remedy must be suppressed, not merely preceded.
    expect(text).not.toMatch(/Ask the user to manually refresh/);
  });

  it("falls back to the generic remedy when the bridge cannot say why", async () => {
    const bridge = {
      ...(ctxRefusing("x").bridge as unknown as Record<string, unknown>),
      lastFenceRefusal: undefined, // an older bridge
    } as unknown as PanelToolCtx["bridge"];

    const text = textOf(
      await setTarget().handler(
        { mode: "current" },
        makePanelToolCtx(bridge, "tab-1", new WorkflowTargetStore()),
      ),
    );

    expect(text).toMatch(/this bridge could not say which/);
    expect(text).toMatch(/Ask the user to manually refresh/);
  });
});

// #1077 follow-up — a defect in the diagnostic added for #1077 itself.
//
// `canReach()` and `tabServerOrigin()` BOTH swallow whatever resolveTarget
// throws, so a turn issued from several workflows at once (routing ambiguity,
// #1001) reaches the validator looking identical to (a) a dead tab and (b) a
// connection carrying no server-observed Origin.
//
// (b) is the damaging one: its remedy says the failure is STRUCTURAL, that
// refreshing cannot help, and that the relay backend is the known cause. For an
// ambiguous turn all three are wrong — the tabs are connected, the Origin
// exists, and it clears on the next single-origin message.
//
// These drive the REAL reason builders. An earlier version of this block built a
// fake bridge and asserted it returned what the fake was told to return, which
// would have passed with the logic deleted.
describe("the refusal reasons distinguish an AMBIGUOUS turn", () => {
  const TAB = "orchestrator::claude";
  const UUID = "621187be-2fa9-49cd-b6af-7402895c89b9";

  it("gate 1: names the ambiguity instead of claiming the tab is gone", () => {
    const r = unreachableReason(TAB, "ambiguous");

    expect(r).toMatch(/SEVERAL workflows at once/);
    expect(r).toMatch(/tabs are connected and fine/);
    expect(r).toMatch(/Do NOT reconnect or refresh/);
    expect(r).not.toMatch(/no longer reachable/);
  });

  it("gate 1: still reports a genuinely dead tab as unreachable", () => {
    const r = unreachableReason(TAB, "unresolved");

    expect(r).toMatch(/no longer reachable/);
    expect(r).not.toMatch(/SEVERAL workflows/);
  });

  // THE ONE THAT MATTERS. Ambiguity also yields no origin, so order decides
  // whether it inherits the relay story.
  it("gate 3: an ambiguous turn does NOT borrow the structural relay remedy", () => {
    const r = identityReason(TAB, undefined, UUID, "ambiguous");

    expect(r).toMatch(/SEVERAL workflows at once/);
    expect(r).not.toMatch(/structural/);
    expect(r).not.toMatch(/relay/i);
    expect(r).not.toMatch(/refreshing the tab will not change it/);
  });

  it("gate 3: a genuine no-Origin connection says refreshing will not help", () => {
    const r = identityReason(TAB, undefined, UUID, undefined);

    expect(r).toMatch(/no server-observed Origin/);
    expect(r).toMatch(/[Rr]efreshing the tab will not/);
    // ...and names something the reader can actually check.
    expect(r).toMatch(/COMFYUI_URL/);
  });

  it("gate 3: no longer blames the relay backend, which is FIXED", () => {
    // The relay path now supplies the origin it already knows from COMFYUI_URL
    // (#1077), so a relay session adopts fences like any other. Telling a reader
    // to stop using that backend would send them to change the one thing that is
    // no longer the reason — a remedy that is worse than none, because it looks
    // specific.
    const r = identityReason(TAB, undefined, UUID, undefined);

    expect(r).not.toMatch(/COMFYUI_MCP_TUNNEL_BACKEND/);
    expect(r).not.toMatch(/can never be adopted/);
  });

  it("gate 3: an origin that IS present reports a validation failure, not absence", () => {
    const r = identityReason(TAB, "https://x.trycloudflare.com", "not-a-uuid", undefined);

    expect(r).toMatch(/did not validate/);
    expect(r).toMatch(/not-a-uuid/);
    expect(r).not.toMatch(/no server-observed Origin/);
  });
});

// #1255 — a refusal must describe the check it actually ran.
//
// identityReason's last branch used to end "a malformed uuid, or one bound to a
// different origin". workflowIdentityParts never compares origins: it requires
// one to be PRESENT, and nothing in the repo has ever read `identity.origin`
// (both call sites take `.uuid`). So the second half named a mechanism that does
// not exist.
//
// That is not a cosmetic complaint. Reasoning from that sentence produced a
// filed issue, a written fix and 7 tests before anyone checked whether the
// comparison existed; the PR closed unmerged. Prose in the codebase gets read as
// evidence about the codebase, so a message that overstates is a defect.
describe("identityReason describes the check it actually performs (#1255)", () => {
  const reason = () =>
    identityReason("wf:x", "http://127.0.0.1:8188", "not-a-uuid", undefined);

  it("does not claim the identity may be bound to a DIFFERENT origin", () => {
    expect(reason()).not.toMatch(/bound to a different origin/i);
  });

  it("names the uuid as the thing that failed", () => {
    const text = reason();
    expect(text).toContain("not-a-uuid");
    expect(text).toMatch(/not a well-formed workflow uuid/i);
  });

  it("says the origin was ACCEPTED, so a reader does not go hunting there", () => {
    const text = reason();
    expect(text).toContain("http://127.0.0.1:8188");
    expect(text).toMatch(/present and accepted/i);
    expect(text).toMatch(/does not compare it against a previously bound one/i);
  });

  it("owns its own premise: a present origin IS accepted by the gate", () => {
    // The message asserts the origin was accepted and is not compared. Nothing
    // in this file held that claim to the CODE -- a reviewer showed that adding
    // a real origin comparison to workflowIdentityParts leaves all of these
    // green, so the sentence could silently become false again. This pins it:
    // a well-formed uuid with a present origin must produce an identity.
    expect(
      workflowIdentityParts({
        workflowUuid: "11111111-2222-4333-8444-555555555555",
        origin: "http://127.0.0.1:8188",
      }),
    ).toBeDefined();
  });

  it("still routes an AMBIGUOUS turn to its own branch, unchanged", () => {
    // The no-origin branches are correct and must not be disturbed by this.
    expect(identityReason("wf:x", undefined, "u", "ambiguous")).toMatch(/no single tab/i);
    expect(identityReason("wf:x", undefined, "u", undefined)).toMatch(/no server-observed Origin/i);
  });
});
