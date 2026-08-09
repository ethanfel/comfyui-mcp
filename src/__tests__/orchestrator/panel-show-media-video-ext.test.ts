// #811 — panel_show_media rejected a valid local ProRes .mov output even though
// this codebase already treats .mov as a video format everywhere else:
// get_image's action:"list_outputs" documents ".mp4/.webm/.mov/.mkv/.m4v/.avi",
// and upload_image's action:"video" accepts the identical set. panel_show_media's
// own VIDEO_EXTS was narrower — just {.mp4, .webm} — for no stated reason, an
// inconsistency verified against the source rather than assumed from the report.
//
// Widening the container-extension allowlist surfaced a SEPARATE, independent
// bug: the MIME type was built by naive `"video/" + ext.slice(1)`, which only
// ever worked for .mp4/.webm by coincidence (their extension equals their MIME
// subtype). Extended to .mov it would have produced the invalid `video/mov`
// instead of `video/quicktime` — and a wrong MIME can make a browser refuse to
// even ATTEMPT playback before the codec is ever considered. Both are fixed
// together and tested together, since testing the extension alone would have
// missed the MIME regression.
//
// SCOPE, stated plainly: this widens which CONTAINERS are accepted and fixes
// their MIME types. It does not and cannot guarantee every codec inside those
// containers is browser-decodable (a ProRes stream may still not play natively
// outside Safari) — that is a downstream browser limitation the panel's video
// path already degrades gracefully around, not something this fix claims to
// solve.
//
// The resolved item (with its dataUrl/mime) is never echoed back in the tool's
// OWN reply — it is dispatched onward via `ctx.call({cmd:"show_media", items})`
// to the panel. So verification captures the OUTBOUND call, mirroring
// panel-show-media-oversized.test.ts's own makeCtx/calls convention exactly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPanelToolDefs, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;

function makeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    bridge: { isHeadless: () => false } as unknown as PanelToolCtx["bridge"],
    tabId: "test-tab",
  } as PanelToolCtx;
  return { ctx, calls };
}

async function showMedia(items: Array<Record<string, unknown>>): Promise<{ res: ToolResult; calls: Forwarded[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  const { ctx, calls } = makeCtx();
  const res = (await def.handler({ items }, ctx)) as ToolResult;
  return { res, calls };
}

const textOf = (res: ToolResult): string => res.content.map((c) => ("text" in c ? c.text : "")).join("\n");

let root: string;
const paths: Record<string, string> = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cmcp-showmedia-videoext-"));
  mkdirSync(root, { recursive: true });
  for (const ext of [".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".txt"]) {
    const p = join(root, `clip${ext}`);
    writeFileSync(p, Buffer.alloc(64)); // well under the inline cap
    paths[ext] = p;
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("#811 previously-refused video containers are now accepted", () => {
  it.each([".mov", ".mkv", ".m4v", ".avi"])("%s is no longer refused", async (ext) => {
    const { res } = await showMedia([{ source: { path: paths[ext] }, caption: "c" }]);
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toMatch(/unsupported file type/);
  });
});

describe("#811 each container gets its REAL MIME type, not a slice-of-the-extension guess", () => {
  const cases: Array<[string, string]> = [
    [".mp4", "video/mp4"],
    [".webm", "video/webm"],
    [".mov", "video/quicktime"],
    [".mkv", "video/x-matroska"],
    [".m4v", "video/x-m4v"],
    [".avi", "video/x-msvideo"],
  ];

  it.each(cases)("%s -> %s", async (ext, mime) => {
    const { res, calls } = await showMedia([{ source: { path: paths[ext] } }]);
    expect(res.isError).toBeFalsy();

    const dispatched = calls.find((c) => c.cmd === "show_media");
    expect(dispatched, "no show_media command was dispatched to the panel").toBeTruthy();
    const items = dispatched!.items as Array<{ kind?: string; dataUrl?: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("video");
    expect(items[0].dataUrl).toBeTruthy();
    expect(items[0].dataUrl!.startsWith(`data:${mime};base64,`)).toBe(true);

    // Guard the OLD bug specifically: the naive form is only correct for
    // .mp4/.webm by coincidence, and must never appear for .mov/.mkv/.m4v/.avi.
    const naive = "data:video/" + ext.slice(1) + ";";
    if (mime !== "video/" + ext.slice(1)) {
      expect(items[0].dataUrl!.startsWith(naive)).toBe(false);
    }
  });
});

describe("#811 a genuinely unsupported type is still refused, and says so with the WIDER list", () => {
  it("refuses .txt and names the current allowed set", async () => {
    const { res } = await showMedia([{ source: { path: paths[".txt"] } }]);
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/unsupported file type ".txt"/);
    expect(text).toContain(".mov");
    expect(text).toContain(".mkv");
  });
});
