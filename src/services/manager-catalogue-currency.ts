/**
 * panel#890 — a POPULATED ComfyUI-Manager catalogue proves nothing about its age.
 *
 * ## What was measured (the reporter's, on a network that genuinely blocks the registry)
 *
 * Manager raises `InvalidChannel` for the channel host and logs `Cannot connect to
 * comfyregistry`. It then answers `/customnode/getmappings?mode=cache` with HTTP 200,
 * 1,570,773 bytes, 5583 packs — served from the `extension-node-map.json` BUNDLED in
 * the Manager package, via `get_data_by_mode`'s except-branch.
 *
 * So the failure mode is not an empty list. It is a full one, of unknown age, byte-for-
 * byte indistinguishable from a current one. Manager does not report which source
 * answered.
 *
 * ## Why the existing caveats do not cover it
 *
 * #1136 added `catalogue_unavailable` (the list came back EMPTY) and
 * `mappings_unavailable` (the lookup threw and we caught it). Both key on an OBSERVED
 * failure. A bundled fallback presents as success, so neither fires — and `unresolved`
 * goes out with no caveat at all, reading as "these packs do not exist". That is the
 * exact collapse #1136 exists to prevent, surviving in the case Manager works hardest
 * to produce.
 *
 * ## What this deliberately does NOT say
 *
 * It does not claim the catalogue IS stale. Nothing here can observe that, and the
 * reporter named that trap in the issue: a staleness claim inferred from something the
 * panel cannot see would repeat the fault the original issue was filed about. This says
 * only what is true of every Manager-served catalogue — its currency is unverifiable
 * from here — and then hands over a check that can settle it.
 *
 * ## The nearest thing to a discriminator
 *
 * `search_custom_nodes` queries `api.comfy.org` DIRECTLY rather than through Manager,
 * so it is an INDEPENDENT source. It is not a clean two-way test, and an earlier
 * version of this said it was (codex round 7):
 *
 *   - `unresolved` holds node CLASS TYPES, not pack ids, and the registry indexes
 *     PACKS. So the entries cannot simply be looked up; the caller searches the class
 *     type or the pack they believe provides it.
 *   - A registry hit for a pack this catalogue omits SUGGESTS the catalogue is behind.
 *     It does not prove it — a Manager mapping can be absent for indexing reasons that
 *     have nothing to do with age — so it is offered as a reason to update, not a
 *     verdict.
 *   - Finding nothing settles nothing in either direction, and saying otherwise would
 *     be the same overclaim pointed the other way.
 *
 * Named rather than performed: this rides on a read that already has its answer, and
 * adding a network call to it would make every dependency scan slower for a case that
 * is usually fine.
 *
 * Spelled out with BOTH `action` and `query` (codex review). The tool is
 * action-parameterised and `query` is required for the search action, so a half-named
 * call costs a round trip to an error — inside a caveat whose entire job is to hand
 * over a check that works. (A review round reported that this tool has no `action`
 * parameter at all; measured twice against origin/main, it does — a required
 * `z.enum(["search","details"])`, with exactly one registration of the name.)
 */

/** The one sentence that must accompany an `unresolved` list from a Manager catalogue
 *  we could not date. Kept SHORT on purpose — it attaches to every miss, including the
 *  many that are ordinary, so a paragraph here becomes noise that gets skipped and then
 *  it protects nobody. */
export const MANAGER_CATALOGUE_CURRENCY_CAVEAT =
  `NOT proof these do not exist. This is the ComfyUI-Manager catalogue, and when Manager ` +
  `cannot reach the registry it serves a copy bundled in its own package — populated, ` +
  `HTTP 200, and indistinguishable from a current one; it does not report which source ` +
  `answered, so nothing here can date it (panel#890). These are node CLASS TYPES, not ` +
  `pack ids, and the registry indexes PACKS — so search the class type, or the pack you ` +
  `believe provides it, with search_custom_nodes action:"search" query:"<name>", which ` +
  `queries api.comfy.org directly rather than through Manager. A pack found there that ` +
  `this catalogue does not list SUGGESTS the catalogue is behind and is worth updating ` +
  `ComfyUI-Manager on the ComfyUI host for — it does not prove it, because a mapping can ` +
  `also be missing for indexing reasons, and finding nothing settles nothing either way.`;

/**
 * Should the currency caveat be attached?
 *
 * Only when there is something to mislead about (`unresolved` non-empty) AND no
 * STRONGER caveat already applies. `catalogue_unavailable` and `mappings_unavailable`
 * report an OBSERVED failure; this one reports the absence of evidence either way.
 * Emitting both would bury the observed fact under the generic one and read as two
 * separate problems.
 */
export function managerCatalogueCurrencyUnverified(opts: {
  unresolvedCount: number;
  catalogueUnavailable?: string;
  mappingsUnavailable?: string;
}): boolean {
  if (opts.unresolvedCount <= 0) return false;
  if (opts.catalogueUnavailable) return false;
  if (opts.mappingsUnavailable) return false;
  return true;
}
