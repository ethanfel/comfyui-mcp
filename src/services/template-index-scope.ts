/**
 * #1454 — an incomplete template list read as a complete one.
 *
 * `list_templates` consults exactly one source: the connected ComfyUI's
 * `/api/workflow_templates`. That endpoint reports what packs REGISTER, and a pack
 * can ship example workflows on disk without registering them — the reporter had
 * `ComfyUI-LTXVideo/example_workflows/2.5/*.json` sitting there while the pack did
 * not appear at all, and fell back to searching the filesystem by hand.
 *
 * Nothing in the reply said that was possible. `source_count: 4` reads as "there are
 * four", so a caller concludes the workflow they want does not exist rather than
 * that this index cannot see it.
 *
 * ## What this does NOT do
 *
 * It does not scan the disk. Merging a local `custom_nodes/*∕example_workflows` walk
 * is the fuller fix and the one the reporter asked for, but it is new filesystem I/O
 * on a read path, gated on the target being local, with its own dedup and ordering
 * rules — a capability addition rather than a correction, and not a freeze-window
 * change.
 *
 * What it corrects is the CLAIM. The tool cannot know whether the server registered
 * everything, so it stops implying it did and names where the unregistered ones live.
 * That converts an invisible gap into a visible one with a next step, which is the
 * difference between the reporter's experience and a two-minute check.
 */

/** The note that must accompany every template index. Short on purpose: it rides on
 *  every successful listing, and a paragraph there is skipped rather than read. */
export const TEMPLATE_INDEX_SCOPE_NOTE =
  `This index is what the connected ComfyUI REGISTERS via /api/workflow_templates. A pack ` +
  `can ship example workflows on disk WITHOUT registering them — those are invisible here, ` +
  `so an absent pack is not evidence it has no templates (#1454). If one you expect is ` +
  `missing, look for custom_nodes/<pack>/example_workflows/**/*.json on the ComfyUI host ` +
  `and load it with the workflow-loading tool by path.`;

/**
 * Should the scope note be attached?
 *
 * Always, on a successful listing — including a listing with sources in it. The gap is
 * not "the list is empty", it is "the list is what one authority knows", and that is
 * equally true when the endpoint answered with plenty. Gating it on an empty result
 * would hide it in exactly the reporter's case: 4 sources, 53 templates, and the one
 * they wanted absent.
 */
export function templateIndexScopeNote(): string {
  return TEMPLATE_INDEX_SCOPE_NOTE;
}
