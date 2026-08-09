// Review finding 1 — the diagnosis redacted the FAILING url and then, three
// clauses later, printed the CONFIGURED BASE url verbatim in its own advice:
//
//   http://host:8188/«redacted»/system_stats answered 500 with …
//   … The check is that http://host:8188/AbCdEf0123456789AbCdEf0123456789/system_stats returns JSON …
//
// Same string, redacted and then printed, inside one sentence.
//
// `parseComfyUIUrl` keeps only hostname and pathname, so the base can never
// carry userinfo or a query — but a PATH PREFIX is exactly the tunnel/gateway
// shape the path scrub was added for (a quick-tunnel or gateway route can be an
// opaque token), so the leak was real and bounded rather than theoretical.
//
// This lives in its OWN file because the assertion needs a base URL that
// actually carries a token, and the sibling suite's module mock returns a clean
// one — under which the test would pass whether or not the fix is present.

import { describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every const, so the token has to be hoisted too.
const { TOKEN } = vi.hoisted(() => ({ TOKEN: "AbCdEf0123456789AbCdEf0123456789" }));

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: `/${TOKEN}` },
  getComfyUIApiHost: () => "gateway.example",
  getComfyUIBasePath: () => `/${TOKEN}`,
  // A tunnel/gateway whose route prefix IS the credential.
  getComfyUIBaseUrl: () => `https://gateway.example/${TOKEN}`,
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { classifyNonJson } from "../../comfyui/json-guard.js";

describe("the diagnosis does not print the configured base URL raw", () => {
  it("redacts the token in its own 'the check is that …' advice", () => {
    const d = classifyNonJson({
      url: `https://gateway.example/${TOKEN}/internal/logs`,
      status: 500,
      contentType: "text/plain",
      body: "boom",
    });

    // The whole message, not just the url field: the advice clause is the part
    // that regressed, and it sits well after the url.
    expect(d.message).not.toContain(TOKEN);
    // …while still saying the thing it exists to say.
    expect(d.message).toContain("/system_stats returns JSON");
    expect(d.message).toContain("gateway.example");
  });
});
