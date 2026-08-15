/**
 * The panel's STRUCTURED refusal, as the orchestrator is allowed to read it (#1529).
 *
 * ## Why this is not a string match
 *
 * `panel_set_widget` is refused while ComfyUI's backend is reconnecting, and the
 * refusal is correct — a mutation dispatched in that window lands on a canvas the
 * reconnect is about to rebuild. It is also SAFE TO RETRY, because the panel's gate
 * runs before the executor, so nothing was applied.
 *
 * The first attempt at this read that fact out of the refusal's wording and was
 * reverted as a P0. Acknowledged panel errors travel as arbitrary `msg.error` text,
 * so any sentence the gate writes is a sentence a genuine MID-WRITE failure can also
 * contain — and being wrong does not print a bad message, it RE-ISSUES A MUTATION
 * that already landed. The panel now states it structurally instead (panel 0.14.35,
 * comfyui-mcp-panel#1216), and this reads that field and nothing else.
 *
 * ## Fail closed, in every direction
 *
 * The whole value of this channel is that it authorises the one thing the retry path
 * otherwise refuses: re-issuing a MUTATING command on our own initiative. So it
 * accepts only a refusal that carries every claim it needs, exactly:
 *
 *   applied   === false           nothing ran
 *   stage     === "pre-executor"  and it could not have
 *   retryable === true            the panel says a retry is the right move
 *   code      ∈ the known set     it came from the gate this is about
 *
 * Anything missing, mistyped, or unrecognised answers `null`, and the caller behaves
 * exactly as it did before the field existed — which is also what happens against
 * every panel older than 0.14.35.
 */

/** The codes `graphMutationReconnectGate` publishes. An enumerated list, not a shape
 *  test: a code this side does not recognise must not authorise a retry, because the
 *  claim attached to it was written for a case we have not reasoned about. */
const RETRYABLE_REFUSAL_CODES = new Set(["backend-reconnecting", "post-reconnect-settling"]);

/**
 * The own-property test, CAPTURED AT MODULE LOAD (review, round 3).
 *
 * `Object.prototype.hasOwnProperty.call(x, k)` reads the method off the very
 * prototype the check exists to distrust, so a replacement returning `true` would
 * re-open the hole it closes. Binding the intrinsic once removes that, and exporting
 * it keeps the bridge from growing a second, weaker copy.
 *
 * This is defence against a mistake, not an adversary: a process that can rewrite
 * `Object.prototype` can call anything here directly, so the value is that the rule
 * stays true under a careless dependency rather than under an attacker.
 */
const OWN = Object.prototype.hasOwnProperty;
export function hasOwnField(target: unknown, key: string): boolean {
  return !!target && typeof target === "object" && OWN.call(target, key);
}

export interface PreExecutorRefusal {
  code: string;
  applied: false;
  stage: "pre-executor";
  retryable: true;
}

/**
 * Read a panel reply's `refusal` field, returning it only when it makes the full
 * pre-executor claim. Never throws: a malformed field is not a reason to fail a
 * command that already failed.
 */
export function readPanelRefusal(value: unknown): PreExecutorRefusal | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  // OWN PROPERTIES, at every hop (review, P0). An earlier version applied this rule
  // to the Error only, and read the claim's fields with plain lookups — so a
  // polluted `Object.prototype` carrying a valid-looking `applied`/`stage`/
  // `retryable` would let a claim that names none of them authorise a retry, and
  // the mutation this channel exists to protect gets re-issued after it landed.
  //
  // Inheritance is the wrong shape for a claim of provenance in either direction:
  // what matters is that THIS object states it, not that something up its chain
  // does.
  const own = (k: string): boolean => hasOwnField(r, k);
  if (!own("code") || !own("applied") || !own("stage") || !own("retryable")) return null;
  if (typeof r.code !== "string" || !RETRYABLE_REFUSAL_CODES.has(r.code)) return null;
  if (r.applied !== false) return null;
  if (r.stage !== "pre-executor") return null;
  if (r.retryable !== true) return null;
  // Rebuilt, not forwarded: nothing else riding the wire object reaches a caller
  // that is about to make a retry decision on it.
  return { code: r.code, applied: false, stage: "pre-executor", retryable: true };
}

/** The property the bridge attaches a validated refusal to. Namespaced because
 *  `code`/`cause` on an Error already mean other things to other catch blocks. */
export const PANEL_REFUSAL_PROP = "cmcpPanelRefusal";

/** Attach a validated refusal to the Error the bridge rejects with, so the retry
 *  path can key on the FIELD. `defineProperty`, not assignment: an assignment to a
 *  property that exists on the prototype as non-writable throws in strict mode, and
 *  that would replace a clear refusal with an unrelated TypeError (the same trap the
 *  panel side hit — comfyui-mcp-panel#1216). */
export function attachPanelRefusal(err: Error, refusal: PreExecutorRefusal): Error {
  try {
    Object.defineProperty(err, PANEL_REFUSAL_PROP, {
      value: refusal,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Decorating an error must never be able to fail the command harder than it
    // already failed.
  }
  return err;
}

/**
 * Does this error carry the panel's own statement that the executor never ran?
 *
 * OWN property only. An inherited `cmcpPanelRefusal` — from a polluted prototype, or
 * a library that decorates Error — would let an unrelated failure authorise a
 * mutation retry, which is the one outcome this channel exists to prevent.
 */
export function isPreExecutorRefusal(err: unknown): PreExecutorRefusal | null {
  if (!err || typeof err !== "object") return null;
  if (!hasOwnField(err, PANEL_REFUSAL_PROP)) return null;
  return readPanelRefusal((err as Record<string, unknown>)[PANEL_REFUSAL_PROP]);
}
