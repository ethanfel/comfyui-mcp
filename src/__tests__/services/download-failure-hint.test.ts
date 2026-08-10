// #1300 — one file took four attempts, because the failure said only
// `Download failed: 404 `.
//
// What the reporter had to do by hand, because the tool would not say it:
//
//   1. download with the metadata-query URL   -> bare 404
//   2. re-read the CivitAI API, retry canonical downloadUrl -> bare 404
//   3. curl the same URL by hand              -> 401, no token configured
//   4. set a token, retry                     -> STILL 404 (genuine; URL form)
//   5. switch to ?fileId=…                    -> 206, downloads
//
// Two defects, and the first is why the second was never reached: the response
// body was discarded, and the CivitAI token hint was gated on 401/403 while the
// server answered 404.

import { describe, expect, it } from "vitest";

import {
  downloadFailureHint,
  readErrorBody,
} from "../../services/download-failure-hint.js";

const CIVITAI = "https://civitai.com/api/download/models/3155593";
const METADATA_URL = `${CIVITAI}?type=UNet&format=SafeTensor&fp=int8`;
const FILEID_URL = `${CIVITAI}?fileId=3036509`;

describe("the CivitAI hint fires on the status the reporter actually got (#1300)", () => {
  it("names the missing token on a 404 — the case that was silent", () => {
    // The whole defect in one assertion. The old hint required 401/403; CivitAI
    // answered 404, so the message that solves this never appeared.
    const hint = downloadFailureHint({ status: 404, url: METADATA_URL, hasCivitaiToken: false });
    expect(hint).toMatch(/no CIVITAI_API_TOKEN is configured/);
    expect(hint).toMatch(/civitai\.com\/user\/account/);
  });

  it("still fires on 401 and 403", () => {
    for (const status of [401, 403]) {
      expect(
        downloadFailureHint({ status, url: CIVITAI, hasCivitaiToken: false }),
        `status ${status}`,
      ).toMatch(/no CIVITAI_API_TOKEN is configured/);
    }
  });

  it("does NOT send you back to auth when a token IS set — the reporter's attempt 4", () => {
    const hint = downloadFailureHint({ status: 404, url: METADATA_URL, hasCivitaiToken: true });
    expect(hint).toMatch(/IS configured, so this is probably not an auth failure/);
    expect(hint).not.toMatch(/Set it in panel Settings/);
  });

  it("BUT a 401/403 WITH a token means the token is bad — not 'probably not auth'", () => {
    // Ignoring the status here would repeat the original bug one layer along:
    // an invalid, expired or unentitled token produces exactly this status, and
    // steering that caller away from auth is the same wrong answer (codex).
    for (const status of [401, 403]) {
      const hint = downloadFailureHint({ status, url: METADATA_URL, hasCivitaiToken: true });
      expect(hint, `status ${status}`).toMatch(/INVALID, expired, or lacks access/);
      expect(hint).not.toMatch(/probably not an auth failure/);
    }
  });

  it("the fileId remedy is for a 404 only, not for 429 or 5xx", () => {
    for (const status of [429, 500, 503]) {
      const hint = downloadFailureHint({ status, url: METADATA_URL, hasCivitaiToken: true });
      expect(hint, `status ${status}`).not.toMatch(/selects a file by METADATA/);
    }
  });

  it("a trailing-dot FQDN is the same host", () => {
    // `civitai.com.` is a legitimate spelling; WHATWG URL keeps the dot (codex).
    expect(
      downloadFailureHint({
        status: 404,
        url: "https://civitai.com./api/download/models/1",
        hasCivitaiToken: false,
      }),
    ).toMatch(/no CIVITAI_API_TOKEN/);
  });

  it("with a token, a METADATA-query url gets the fileId remedy they found", () => {
    // Established by their curl, not inferred: `?type=…&format=…&fp=…` 404s even
    // with a valid token when a version publishes several files.
    const hint = downloadFailureHint({ status: 404, url: METADATA_URL, hasCivitaiToken: true });
    expect(hint).toMatch(/selects a file by METADATA/);
    expect(hint).toMatch(/\?fileId=<fileId>/);
  });

  it("with a token, a fileId url does NOT get that remedy — it is already the fix", () => {
    const hint = downloadFailureHint({ status: 404, url: FILEID_URL, hasCivitaiToken: true });
    expect(hint).not.toMatch(/selects a file by METADATA/);
  });

  it("says nothing about CivitAI for other hosts", () => {
    for (const url of [
      "https://huggingface.co/x/resolve/main/model.safetensors",
      "https://example.com/model.safetensors",
      // Not a civitai.com host, however it is spelled.
      "https://civitai.com.evil.example/api/download/models/1",
    ]) {
      expect(downloadFailureHint({ status: 404, url, hasCivitaiToken: false }), url).toBe("");
    }
  });

  it("subdomains of civitai.com still count", () => {
    expect(
      downloadFailureHint({
        status: 404,
        url: "https://cdn.civitai.com/api/download/models/1",
        hasCivitaiToken: false,
      }),
    ).toMatch(/no CIVITAI_API_TOKEN/);
  });

  it("an unparseable url earns no host-specific advice, and does not throw", () => {
    expect(() =>
      downloadFailureHint({ status: 404, url: "not a url", hasCivitaiToken: false }),
    ).not.toThrow();
    expect(downloadFailureHint({ status: 404, url: "not a url", hasCivitaiToken: false })).toBe("");
  });
});

describe("the server's own explanation is carried back (#1300)", () => {
  it("quotes the body, which is what distinguishes 401-needs-token from a real 404", async () => {
    const b = await readErrorBody({ text: async () => '{"error":"Unauthorized"}' });
    expect(b).toContain("Unauthorized");
  });

  it("collapses whitespace so a multi-line body stays one readable line", async () => {
    const b = await readErrorBody({ text: async () => "line one\n\n   line two\t" });
    expect(b).toBe("line one line two");
  });

  it("is BOUNDED — an error path must not be fed an unbounded body", async () => {
    // Realistic prose, not one long run: a single opaque 5000-char run is
    // REDACTED by the scrubber before the bound is reached, which would have made
    // this pass without the truncation ever running.
    const long = "the server rejected this request because ".repeat(200);
    const b = await readErrorBody({ text: async () => long });
    expect(b.length).toBeLessThanOrEqual(401);
    expect(b.endsWith("…")).toBe(true);
  });

  it("a long opaque run is REDACTED rather than truncated — order matters", async () => {
    // Scrub-then-bound, not bound-then-scrub: truncating first could cut a secret
    // in half and leave the first 400 characters of it in the message.
    const b = await readErrorBody({ text: async () => "x".repeat(5000) });
    expect(b).not.toContain("x".repeat(64));
  });

  it("SCRUBS — an auth challenge is exactly what echoes a credential back", async () => {
    // A token-shaped run must not survive into a tool result or the logs.
    const secretish = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    const b = await readErrorBody({ text: async () => `{"error":"bad token ${secretish}"}` });
    expect(b).not.toContain(secretish);
  });

  it("never throws, whatever the response does", async () => {
    expect(await readErrorBody({})).toBe("");
    expect(
      await readErrorBody({
        text: async () => {
          throw new Error("socket closed");
        },
      }),
    ).toBe("");
    expect(await readErrorBody({ text: async () => "   " })).toBe("");
  });

  it("does not invent a body when there is none", async () => {
    expect(await readErrorBody({ text: async () => "" })).toBe("");
  });

  it("REDACTS a credential the host echoed back from our own query string", async () => {
    // A signed download URL carries its credential in the query, and a host that
    // reflects the request would otherwise republish it (codex). These values are
    // ours, so they are redacted by identity, not by shape.
    const token = "sk-live-abcdefghijklmnop";
    const url = `https://civitai.com/api/download/models/1?token=${token}`;
    const b = await readErrorBody({ text: async () => `{"error":"bad token ${token}"}` }, url);
    expect(b).not.toContain(token);
  });

  it("…and in percent-encoded form", async () => {
    const value = "abc/def+ghi=jkl mno";
    const url = `https://civitai.com/api/download/models/1?sig=${encodeURIComponent(value)}`;
    const b = await readErrorBody(
      { text: async () => `{"echo":"${encodeURIComponent(value)}"}` },
      url,
    );
    expect(b).not.toContain(encodeURIComponent(value));
  });

  it("does NOT redact short query values — type=UNet is the diagnosis, not a secret", async () => {
    const url = "https://civitai.com/api/download/models/1?type=UNet&format=SafeTensor";
    const b = await readErrorBody({ text: async () => '{"error":"no file for type UNet"}' }, url);
    expect(b).toContain("UNet");
  });

  it("STOPS READING at the byte cap — the output bound is not a read bound", async () => {
    // res.text() drains the whole response first, so a huge or never-ending error
    // body could hang the download while we improved its message (codex).
    let delivered = 0;
    const reader = {
      read: async () => {
        delivered += 1024;
        return { done: false, value: new Uint8Array(1024).fill(65) };
      },
      cancel: async () => undefined,
    };
    const b = await readErrorBody({ body: { getReader: () => reader } });
    expect(delivered, "must stop near the cap, not read forever").toBeLessThanOrEqual(16 * 1024);
    expect(b.length).toBeLessThanOrEqual(401);
  });

  it("cancels the stream it stopped reading", async () => {
    let cancelled = false;
    const reader = {
      read: async () => ({ done: false, value: new Uint8Array(4096).fill(66) }),
      cancel: async () => {
        cancelled = true;
      },
    };
    await readErrorBody({ body: { getReader: () => reader } });
    expect(cancelled, "a body nobody will read must not be left draining").toBe(true);
  });
});

// The wiring: the failure path must actually call both, or none of the above
// reaches a caller.
describe("WIRING: the download failure path uses them (#1300)", () => {
  it("reads the body and appends the hint", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../services/download-cache.ts", import.meta.url),
      "utf-8",
    );
    const at = src.indexOf("if (!res.ok) {");
    expect(at, "the failure branch moved").toBeGreaterThan(-1);
    const branch = src.slice(at, at + 1200);
    // The request URL is passed so a reflected query credential is redacted.
    expect(branch).toContain("await readErrorBody(res, currentUrl)");
    expect(branch).toContain("downloadFailureHint({");
    expect(branch).toContain("hasCivitaiToken: Boolean(config.civitaiApiToken)");
    // The status is still reported — the body and hint are additions, not a
    // replacement for the fact the caller already had.
    expect(branch).toMatch(/Download failed: \$\{res\.status\}/);
  });

  it("does not log the token itself anywhere in the hint module", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../services/download-failure-hint.ts", import.meta.url),
      "utf-8",
    );
    // Only PRESENCE may cross this boundary, never the value.
    expect(src).not.toMatch(/civitaiApiToken\s*\)/);
    expect(src).toContain("hasCivitaiToken");
  });
});
