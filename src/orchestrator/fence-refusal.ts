// WHY the fence-adoption validator refused, in words the caller can act on.
//
// Extracted from the validator callback in index.ts so it is reachable by tests:
// while it lived inline, the only way to assert the wording was to build a fake
// bridge and check that it returned what the fake was told to return — a
// tautology that would have passed with the logic deleted.
//
// #1077 — the validator has three gates and all of them used to return a bare
// `false`, so a permanently-wedged session was told only "the adoption was
// REFUSED". Naming the gate is the fix; naming it WRONGLY is worse than not
// naming it, which is what the first version of this did.
//
// `canReach()` and `tabServerOrigin()` both swallow whatever `resolveTarget`
// throws, so a turn issued from SEVERAL workflows at once (routing ambiguity,
// #1001) is indistinguishable at those call sites from a dead tab and from a
// connection carrying no Origin. It therefore inherited the structural
// no-Origin story: "refreshing will not help, stop using the relay backend".
// For an ambiguous turn that is wrong on every count — the tabs are connected,
// the Origin exists, nothing is structural, and it clears on the next
// single-origin message. The cause is typed and was simply being discarded.

/** What `UiBridge.resolveFailure()` reports: why a tab id does not resolve, or
 *  undefined when it does. */
export type ResolveFailure = "ambiguous" | "unresolved" | undefined;

/** The turn's target is ambiguous — say so, and say it is self-clearing. */
function ambiguousTurn(tabId: string, what: string): string {
  return (
    `this turn was issued from SEVERAL workflows at once, so ${what} for "${tabId}" — the tabs ` +
    `are connected and fine. This clears itself: target a workflow explicitly ` +
    `(panel_set_workflow_target with a path, or panel_open_workflow), or let the next ` +
    `single-origin message settle it. Do NOT reconnect or refresh.`
  );
}

/** Gate 1: the routed tab did not resolve at all. */
export function unreachableReason(tabId: string, failure: ResolveFailure): string {
  if (failure === "ambiguous") return ambiguousTurn(tabId, "there is no single target to fence");
  return `the routed tab (${tabId}) is no longer reachable, so there is nothing to fence`;
}

/** Gate 2: it resolved, but not to a live panel tab. */
export function noPanelTabReason(tabId: string): string {
  return `${tabId} does not resolve to a live panel tab (a scope address whose tab has gone away)`;
}

/**
 * Gate 3: the workflow identity did not validate.
 *
 * ORDER MATTERS. An ambiguous turn also yields no origin, so it must be checked
 * BEFORE the structural no-Origin case, or it borrows a remedy that cannot help
 * it and is told its problem is permanent.
 */
/**
 * The remedy for "this connection has no server-observed Origin" (panel#1065).
 *
 * Shared, because it was NOT shared and the two copies drifted. #1077/#1240 gave
 * the relay path the origin it already knows from COMFYUI_URL, and updated the
 * refusal below to say so. The OTHER surface rendering this same refusal — the
 * `rejected` branch of describeFenceRebind in panel-tools.ts — kept the pre-fix
 * text, which told the user to abandon the relay backend and to "report it: the
 * relay protocol has to forward the browser's handshake Origin for this path to
 * work at all".
 *
 * A user on 0.50.114 — a version that HAS the fix — followed that instruction and
 * filed panel#1065 quoting it back. The stale sentence manufactured its own bug
 * report, and told someone to downgrade a working setup on the way.
 */
export const NO_ORIGIN_REMEDY =
  // The gate's OWN semantics come first, because they dissolve the fear the old
  // wording created and the reporter's stated obstacle at once. Measured, not
  // assumed: workflowIdentityParts requires an origin to EXIST, both call sites
  // take only `.uuid`, and `identity.origin` is never read again — so the value
  // is a scope, not a claim to be checked against the browser.
  `What this gate checks is PRESENCE, not agreement: the identity needs SOME origin to be ` +
  `scoped to, and nothing ever compares it against the browser's — so the value does not have ` +
  `to match where the panel is served from. ` +
  // Two causes, named separately (codex review, P1). The predicate that selects this
  // remedy is generic, and a blanket "set COMFYUI_URL" sends a direct/LAN/pairing or
  // non-browser caller to a change that CANNOT add a handshake origin, leaving them
  // fenced with nothing left to try.
  `On a RELAY connection the origin is derived from COMFYUI_URL, so an unset or unparseable ` +
  `COMFYUI_URL is the usual cause and setting it to any valid URL supplies one; you do not have ` +
  `to leave the relay backend, which has supplied its own origin since 0.50.67. ` +
  `On any other path the connection never presented an Origin header at all — a non-browser ` +
  `client, or a proxy that strips it — and what fixes that is reaching the orchestrator from the ` +
  `browser panel itself. ` +
  `Refreshing the tab will not change either case. Reads and non-graph tools keep working ` +
  `meanwhile — they do not need the fence.`;

export function identityReason(
  tabId: string,
  origin: string | undefined,
  workflowUuid: unknown,
  failure: ResolveFailure,
): string {
  if (!origin && failure === "ambiguous") {
    return ambiguousTurn(tabId, "no single tab's identity could be read");
  }
  if (!origin) {
    // The relay case USED to land here and was told, correctly at the time, that
    // its problem was permanent. It no longer is: the relay path now supplies the
    // origin it already knows from COMFYUI_URL, so a relay session adopts fences
    // like any other. Naming a fixed cause as the "known case" would send a
    // reader to change a backend that is no longer the reason (#1077).
    return (
      `this tab's connection carries no server-observed Origin, and the workflow identity is ` +
      `bound to one — so the fence cannot be adopted for it. This means the connection reached ` +
      `the orchestrator by a path that neither observed nor was told the panel's origin. ` +
      NO_ORIGIN_REMEDY
    );
  }
  // #1255 — this used to end "a malformed uuid, or one bound to a different
  // origin", which describes a comparison the code does not perform.
  // workflowIdentityParts uses the origin as a PRESENCE gate: it requires one to
  // exist, and never compares it against a previously bound value (nothing in
  // the repo has ever read `identity.origin` -- both call sites take `.uuid`).
  // Reaching here with an origin present therefore means the UUID failed its
  // shape check, full stop.
  //
  // The old wording sent a reader hunting for an origin mismatch that cannot
  // happen -- it cost a whole investigation and a closed-unmerged PR before the
  // mechanism was checked rather than believed. A refusal must describe the
  // check it actually ran.
  return (
    `the workflow identity did not validate: the uuid ${String(workflowUuid)} is not a ` +
    `well-formed workflow uuid. (The origin ${origin} was present and accepted -- this gate ` +
    `requires an origin to exist, it does not compare it against a previously bound one.)`
  );
}
