/**
 * #1397 — the ComfyUI-Manager error body was captured and never shown.
 *
 * `panel_update_node` failed with "an opaque serialized ComfyUI-Manager
 * QueueTaskItem/OperationType exception and no actionable traceback". The body was
 * not missing: `managerFetch` stores it in the error's `details` as
 * `{ url, status, body }`. It simply never reached the human-readable message for
 * any status except 403. So the diagnosis existed, one layer down, and the reader
 * got `ComfyUI-Manager API 500 Internal Server Error for /v2/manager/queue/task`.
 *
 * For a Manager TASK failure the body is the whole point — it is where the
 * serialized Python exception, and often the actual cause (a missing dependency, in
 * the report), is written.
 *
 * ## Why it is bounded rather than passed through
 *
 * A Manager exception body can be a full traceback, and this repo has already paid
 * for a verbatim error payload: #664 carried tensor-sized `current_inputs` and
 * 41k-token tracebacks into a reply. An unbounded passthrough here would trade an
 * unreadable message for an unusable one.
 *
 * So: a head excerpt, whitespace-collapsed, with truncation MARKED. The mark matters
 * — a silently cut traceback reads as a complete one, and someone would conclude the
 * exception ended where the budget did.
 */

/**
 * Redact credential shapes before ANY of this body is shown.
 *
 * The excerpt is an ARBITRARY upstream payload reaching a user-visible error, and a
 * Manager failure is exactly where a credential can appear: a pack install that
 * fails to clone echoes the git remote, and a remote can carry
 * `https://user:token@host/...`. The rule in this project is that a secret never
 * appears in an error, a disclosure, a fixture or a commit — so this runs before the
 * cap, not after, and the redaction is on the SHAPE rather than on a list of known
 * key names, because the next credential will not be on the list.
 *
 * Deliberately narrow. Over-redaction makes the excerpt useless and this exists to
 * make an opaque failure readable; each pattern below is a shape that is a secret
 * essentially whenever it appears, not merely a word that often sits near one.
 */
function redactCredentials(text: string): string {
  return (
    text
      // scheme://user:secret@host — the git-remote case, and the one most likely here.
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@")
      // Authorization-style headers echoed into a traceback.
      .replace(/\b(bearer|token|apikey|api_key)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
      // `Basic` needs its OWN rule, because it is the one scheme name that is also an
      // ordinary English word. Two earlier attempts failed in opposite directions:
      // matching it like `bearer` redacted "Basic configuration missing for Deno
      // package"; keying on base64 SHAPE then missed short credentials (`Basic YTpi`
      // is `a:b`) and still ate "Basic ConfigVersion2026". Both were defects the
      // fixes themselves introduced.
      //
      // So discriminate on CONTEXT, not on the value: redact only where `basic`
      // follows an `Authorization`/`Proxy-Authorization` header. Prose does not say
      // "Authorization: Basic configuration". That admits ANY value, however short or
      // however word-like, which is what the shape rule could never do safely — and a
      // bare `Basic <blob>` with no header in sight stays readable.
      .replace(
        /\b((?:proxy-)?authoriz(?:ation|ed)?["']?\s*[=:]\s*["']?\s*basic)\s+\S+/gi,
        "$1 ***",
      )
      // token=… / api_key=… / access_token=… in a query string or a repr.
      // `authorization`, `cookie` and `session` join the key list for the same reason
      // the others are on it: each is a credential essentially whenever it carries a
      // value. A `Cookie: session=…` in a proxy's 401 body is a live session — as
      // reusable as the password that minted it.
      // The negative lookahead keeps this rule off the SCHEME NAME. Without it,
      // `Authorization: Bearer <tok>` — already reduced to `Bearer ***` by the rule
      // above — matched again with "Bearer" itself as the value, giving `*** ***` and
      // hiding WHICH auth scheme was in play. That is diagnostic information with no
      // secret in it, and a caller debugging a 401 wants it.
      .replace(/\b([a-z_]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|session))(["']?\s*[=:]\s*["']?)(?!(?:bearer|basic|digest|negotiate)\b)[A-Za-z0-9._~+/=-]{6,}/gi, "$1$2***")
  );
}

/** Characters of the Manager's body carried into the message. Enough for a Python
 *  exception's type and message line — which is the part that names the cause —
 *  without importing a traceback. */
export const MANAGER_BODY_EXCERPT_LIMIT = 600;

/**
 * A one-line, bounded excerpt of a Manager error body, or "" when there is nothing
 * worth showing.
 *
 * Returns "" for an empty/whitespace body so the caller can append unconditionally
 * without producing a dangling separator — an unreadable body must cost detail in
 * the text and never a wrong conclusion.
 */
export function managerBodyExcerpt(
  body: unknown,
  limit = MANAGER_BODY_EXCERPT_LIMIT,
): string {
  const raw =
    typeof body === "string"
      ? body
      : body === undefined || body === null
        ? ""
        : (() => {
            // A non-string body (already-parsed JSON) still carries the message.
            // Never let this throw: it is decorating an error that is already being
            // reported, and an error-path guard must not become the error.
            try {
              return JSON.stringify(body);
            } catch {
              return "";
            }
          })();
  // Collapse newlines and runs of whitespace: a traceback pasted verbatim into a
  // single-line error is harder to read than a dense one, and the caller may be
  // rendering this into a log line.
  //
  // Redaction runs BEFORE the cap. After it, a credential split across the truncation
  // boundary would keep its first half — a partial secret is still a leaked one.
  const flat = redactCredentials(raw.replace(/\s+/g, " ").trim());
  // No empty-string guard: an empty `flat` already falls through the ternary and is
  // returned as "". A mutation deleting one proved it changed nothing, and a line
  // that reads as a correctness gate while being dead is worse than its absence.
  if (flat.length <= limit) return flat;
  // `limit` counts UTF-16 code units, so the cut can land BETWEEN the two halves of a
  // surrogate pair (an emoji, or CJK extension-B). The orphaned half is not a
  // character: it serialises to U+FFFD, and a body that was merely long ends up
  // looking corrupted — which reads as "the tool mangled it" rather than "it was
  // truncated". Drop a trailing lone high surrogate so the excerpt always ends on a
  // whole code point. Costs at most one character of an already-bounded excerpt.
  let cut = flat.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}… [truncated]`;
}

/** The clause appended to a Manager failure message. Empty when the body is. */
export function managerBodyClause(body: unknown, limit = MANAGER_BODY_EXCERPT_LIMIT): string {
  const excerpt = managerBodyExcerpt(body, limit);
  return excerpt ? ` ComfyUI-Manager said: ${excerpt}` : "";
}
