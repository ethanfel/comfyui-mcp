// #1300 — a bare status code cost a reporter four attempts.
//
// `download_model action:"download"` reported `Download failed: 404 ` and nothing
// else. The host had explained itself in the response body, and we discarded it;
// the CivitAI token hint existed but was gated on 401/403, and CivitAI answered
// the unauthenticated request with 404 (curl saw 401 for the same URL). So a
// missing-token failure and a wrong-URL failure arrived as the same sentence,
// and the one message that would have solved it on attempt one stayed silent.
//
// Both halves live here so the branches are testable without a network.

import { scrubSecretShapedText } from "../comfyui/json-guard.js";

/** Longest error body we will quote back. */
const MAX_BODY_CHARS = 400;
/** Bytes we are willing to READ before giving up on the explanation. The output
 *  cap alone is not a bound: `res.text()` drains the whole response first, so a
 *  huge or never-ending error body could hang the download or exhaust memory
 *  while we were busy improving its error message (codex). */
const MAX_BODY_BYTES = 8 * 1024;
/** And a clock, because a body can stall without ending. */
const BODY_READ_TIMEOUT_MS = 3_000;

interface ErrorBodySource {
  text?: () => Promise<string>;
  body?: {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>;
      cancel?: () => Promise<unknown> | unknown;
    };
  } | null;
}

/** Read at most MAX_BODY_BYTES from the stream, then STOP — and cancel, so the
 *  socket is not left draining a body nobody is going to read. */
async function readCapped(source: ErrorBodySource): Promise<string> {
  const reader = source.body?.getReader?.();
  if (!reader) {
    if (typeof source.text !== "function") return "";
    // No stream to cap; bound the wait instead, and let the body be collected.
    return await Promise.race([
      source.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), BODY_READ_TIMEOUT_MS)),
    ]);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + BODY_READ_TIMEOUT_MS;
  try {
    for (;;) {
      if (Date.now() > deadline) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        chunks.push(value);
        total += value.length;
        if (total >= MAX_BODY_BYTES) break;
      }
    }
  } finally {
    try {
      await reader.cancel?.();
    } catch {
      /* the response is already an error; cancelling is best effort */
    }
  }
  if (!chunks.length) return "";
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c.subarray(0, Math.min(c.length, total - at)), at);
    at += c.length;
    if (at >= total) break;
  }
  return new TextDecoder().decode(joined.subarray(0, Math.min(at, MAX_BODY_BYTES)));
}

/**
 * The server's own explanation, bounded and safe to show.
 *
 * SCRUBBED because an auth challenge is exactly the kind of body that echoes a
 * credential back, and this string lands in a tool result and the logs. Two
 * passes, because they catch different things:
 *
 *  1. the shared scrubber — every credential this process is configured with,
 *     plus any opaque run long enough to be one;
 *  2. the REQUEST URL's own query values (codex). A signed or pre-authenticated
 *     download URL carries its credential in the query string, and a host that
 *     reflects the request back would otherwise republish it. Those values are
 *     ours and we know them exactly, so they are redacted by identity rather
 *     than by shape.
 *
 * SCRUB THEN BOUND, in that order: truncating first could cut a secret in half
 * and leave 400 characters of it in the message.
 *
 * NEVER THROWS: a diagnostic that fails must not replace the status we already
 * have with an error about the diagnostic.
 */
export async function readErrorBody(source: ErrorBodySource, requestUrl?: string): Promise<string> {
  try {
    const raw = await readCapped(source);
    if (typeof raw !== "string" || !raw.trim()) return "";
    let out = scrubSecretShapedText(raw) ?? raw;
    out = redactUrlQueryValues(out, requestUrl);
    const scrubbed = out.replace(/\s+/g, " ").trim();
    if (!scrubbed) return "";
    return scrubbed.length > MAX_BODY_CHARS ? `${scrubbed.slice(0, MAX_BODY_CHARS)}…` : scrubbed;
  } catch {
    return "";
  }
}

/** Redact any query VALUE from our own request URL that the body echoed back, in
 *  raw and percent-encoded form. Short values are skipped: `type=UNet` is not a
 *  secret, and redacting it would destroy the diagnosis this exists to give. */
function redactUrlQueryValues(text: string, requestUrl?: string): string {
  if (!requestUrl) return text;
  let out = text;
  try {
    const url = new URL(requestUrl);
    for (const value of url.searchParams.values()) {
      if (!value || value.length < 12) continue;
      for (const form of new Set([value, encodeURIComponent(value)])) {
        out = out.split(form).join("«redacted»");
      }
    }
  } catch {
    /* an unparseable url contributes no known values */
  }
  return out;
}

/**
 * What to DO about it, keyed on the facts that decide the answer: the host,
 * whether a token is configured, and — where it is genuinely informative — the
 * status.
 *
 * WHY NOT GATE THE NO-TOKEN CASE ON THE STATUS. The hint this replaces fired only
 * on 401/403, and the reporter got a 404 — so it never appeared. CivitAI requires
 * a token for EVERY model download, which makes "no token is configured" worth
 * saying on any failing status from that host. Note what that sentence is: a
 * statement about OUR configuration, which we know for certain, not a claim about
 * what the server meant by its status, which we do not.
 *
 * WHEN A TOKEN IS SET the status matters, and ignoring it was its own wrong
 * answer (codex): a 401/403 with a token configured is precisely the signal for
 * an INVALID, expired or insufficient one, and telling that caller "probably not
 * an auth failure" would send them off exactly as the original bug did, one
 * layer along. Only a 404 gets the URL-form remedy — the case the reporter
 * actually established.
 */
export function downloadFailureHint(opts: {
  status: number;
  url: string;
  hasCivitaiToken: boolean;
}): string {
  let host = "";
  try {
    // A trailing dot is a legitimate spelling of the same FQDN (codex); strip it
    // for the comparison only.
    host = new URL(opts.url).hostname.replace(/\.$/, "");
  } catch {
    return ""; // an unparseable url earns no host-specific advice
  }
  if (!/(^|\.)civitai\.com$/i.test(host)) return "";

  if (!opts.hasCivitaiToken) {
    return (
      " — NOTE: no CIVITAI_API_TOKEN is configured, and CivitAI requires a token for ALL model " +
      "downloads, so that is the most likely cause whatever status came back (an unauthenticated " +
      "download answers 401 or 404 depending on the URL form). Set it in panel Settings › " +
      "“Set CivitAI token…”, or the env var; create one at civitai.com/user/account. Do NOT retry " +
      "other model ids first — they will fail the same way until a token is set."
    );
  }

  if (opts.status === 401 || opts.status === 403) {
    return (
      " — a CIVITAI_API_TOKEN is configured, and this status is what CivitAI returns for a token " +
      "that is INVALID, expired, or lacks access to this model (early-access and gated models " +
      "need entitlement, not just any token). Re-create the token at civitai.com/user/account and " +
      "set it again, and check whether this model requires purchase or early-access on its page."
    );
  }

  const isMetadataQuery = /[?&](type|format|fp|size)=/i.test(opts.url);
  const fileIdTip =
    opts.status === 404 && isMetadataQuery
      ? " This URL selects a file by METADATA (type/format/fp). CivitAI's own API returns that " +
        "form, but it can 404 even with a valid token when a version publishes several files — " +
        "address the file directly instead: " +
        "https://civitai.com/api/download/models/<versionId>?fileId=<fileId>, taking fileId from " +
        "that version's `files[]` in the CivitAI API."
      : "";
  return ` — a CIVITAI_API_TOKEN IS configured, so this is probably not an auth failure.${fileIdTip}`;
}
