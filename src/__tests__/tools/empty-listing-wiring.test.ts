// #1420 — the WIRING: `download_model action:"status"` with no selector must
// actually return the honest text, not merely have it available in a module.
//
// The message tests next door assert the wording. They would all pass with the
// bare `No downloads are being tracked.` still on the tool, which is the sentence
// that cost a reporter ~24 GB of assumed-lost transfer and a wrong statement to
// their user.

import { describe, expect, it, vi } from "vitest";

// The record store is a REAL directory (~/.comfyui-mcp/download-records by
// default), and its path is resolved once at module load. So this has to be
// redirected BEFORE the module graph loads — hence vi.hoisted — or the test both
// reads the developer's own records and fails whenever any of them exist, which is
// exactly how it failed in the full suite while passing alone.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  process.env.COMFYUI_MCP_DATA_DIR = mkdtempSync(join(tmpdir(), "cmcp-1420-"));
});

import { registerModelManagementTools } from "../../tools/model-management.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function downloadTool(): ToolHandler {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, ...rest: unknown[]) => {
      handlers.set(name, rest.find((a) => typeof a === "function") as ToolHandler);
    },
  };
  registerModelManagementTools(server as never);
  return handlers.get("download_model")!;
}

describe("#1420 status with no selector answers honestly", () => {
  it("does NOT answer with the bare sentence", async () => {
    const res = await downloadTool()({ action: "status" });
    const text = res.content[0].text;
    expect(text).not.toBe("No downloads are being tracked.");
  });

  it("scopes the claim, forbids the wrong conclusion, and names the checks", async () => {
    const res = await downloadTool()({ action: "status" });
    const text = res.content[0].text;
    // The three things that had to reach the caller, asserted on what the TOOL
    // returns rather than on what the helper can produce.
    expect(text).toContain("THIS session's record store");
    expect(text).toContain("DO NOT conclude");
    expect(text).toContain("If this session has the ComfyUI sidebar panel");
    expect(text).toContain("corrupting move");
  });

  it("is not an error — nothing failed, the answer is just not proof", async () => {
    const res = await downloadTool()({ action: "status" });
    expect(res.isError).toBeFalsy();
  });
});

describe("#1420 the SIBLING branch gives the same route advice", () => {
  // codex round 2, P1: with only the empty-listing branch fixed, a same-session
  // Manager transfer looked up BY ID was still told that re-issuing adopts — two
  // branches of one tool disagreeing about the move that can corrupt a file.
  it("an id that matches nothing carries the Manager caveat too", async () => {
    const res = await downloadTool()({ action: "status", id: "0123456789abcdef" });
    const text = res.content[0].text;
    expect(text).toContain("No download matching");
    expect(text).toContain("Do NOT re-issue a transfer that was dispatched to ComfyUI-Manager");
    expect(text).toContain("(#1197)");
    expect(text).toContain("If you cannot tell which route was used, ask before re-issuing");
  });

  it("scopes its adoption claim to a LOCAL transfer, as the empty branch does", async () => {
    const res = await downloadTool()({ action: "status", id: "0123456789abcdef" });
    expect(res.content[0].text).toContain("in-flight LOCAL download adopts it");
  });

  it("offers the tray conditionally, as the empty branch does (codex round 3)", async () => {
    // A headless MCP caller has no tray at all; one branch conditioning it while the
    // other did not is the same disagreement in a quieter form.
    const res = await downloadTool()({ action: "status", id: "0123456789abcdef" });
    const text = res.content[0].text;
    expect(text).toContain("If this session has the ComfyUI sidebar panel");
    expect(text).toContain("without a panel there is no equivalent read");
  });

  it("the RECONNECT advice is conditional too — the third instance, found one per round", async () => {
    // Rounds 2, 3 and 4 each found one more unconditional tray instruction. A regex
    // "no unguarded mention anywhere" property was written to catch the next one and
    // then REMOVED: the first match it finds is the `tray_id` in an unrelated
    // sentence, so it passed against a reverted fix. It is asserted per sentence
    // instead, which is less elegant and actually fails when the guard is dropped.
    const res = await downloadTool()({ action: "status", id: "0123456789abcdef" });
    const text = res.content[0].text;
    expect(text).toContain("across a reconnect, confirm first — via the tray if this session has the panel");
    expect(text).not.toContain("across a reconnect, confirm via the tray first");
  });
});
