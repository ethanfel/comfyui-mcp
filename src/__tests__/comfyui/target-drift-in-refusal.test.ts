// #1175 — the restart refusal asserted "could not be identified" while the
// orchestrator was holding the evidence that would identify it.
//
// A reporter's ComfyUI was started by an external Windows launcher on a port
// that is not 8188. Their panel was connected and live graph reads worked, so a
// ComfyUI demonstrably existed — but the restart preflight probes only
// config.resolvedPort, found nothing, and reported that, which reads as "ComfyUI
// is not running" when it plainly was.
//
// describeTargetDrift is the comparison comfyuiFetch already makes on a
// transport error. This pins that it says the three things it must, so wiring it
// into the refusal turns "we found nothing" into "we looked at the wrong
// address, and here is the right one".

import { afterEach, describe, expect, it } from "vitest";
import { describeTargetDrift, setConnectedPanelOrigins } from "../../comfyui/fetch.js";

afterEach(() => setConnectedPanelOrigins(null));

describe("describeTargetDrift", () => {
  it("names the DIFFERENT origin a connected panel is actually on", () => {
    // The reporter's shape exactly: panel alive elsewhere, probe on 8188.
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8000"]);
    const text = describeTargetDrift("http://127.0.0.1:8188");
    expect(text).toContain("http://127.0.0.1:8000");
    expect(text).toMatch(/DIFFERENT address/);
    expect(text).toMatch(/COMFYUI_URL/);
  });

  it("RULES OUT drift when the panel is on the same origin", () => {
    // Worth stating: it stops the reader chasing an explanation that is excluded.
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
    const text = describeTargetDrift("http://127.0.0.1:8188");
    expect(text).toMatch(/NOT a wrong-address problem/);
    expect(text).toMatch(/firewall|container|interface/);
  });

  it("says NOTHING when no origin is known — an absent comparison is not a result", () => {
    setConnectedPanelOrigins(() => []);
    expect(describeTargetDrift("http://127.0.0.1:8188")).toBe("");
    setConnectedPanelOrigins(null);
    expect(describeTargetDrift("http://127.0.0.1:8188")).toBe("");
  });

  it("never lets a broken origin source replace the real error", () => {
    setConnectedPanelOrigins(() => {
      throw new Error("bridge exploded");
    });
    expect(describeTargetDrift("http://127.0.0.1:8188")).toBe("");
  });

  it("says nothing for an unparseable target rather than guessing", () => {
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8000"]);
    expect(describeTargetDrift("not a url")).toBe("");
  });
});

// THE WIRING. The helper cannot see whether the restart preflight appends it —
// the call-site blindness this suite keeps getting caught by. Read the source,
// the way the other prose gates in this repo do.
describe("the restart preflight appends the drift comparison (#1175)", () => {
  it("calls describeTargetDrift in the could-not-identify refusal", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../services/process-control.ts", import.meta.url),
      "utf-8",
    );
    const start = src.indexOf("the ComfyUI this restart would stop could not be identified");
    expect(start, "the refusal must still exist").toBeGreaterThan(-1);
    const branch = src.slice(start, start + 2200);
    expect(branch).toMatch(/describeTargetDrift\(/);
    // And it must remain a REFUSAL — naming the right address does not make
    // restarting an unidentified instance safe (#814).
    expect(src.slice(start - 400, start)).toMatch(/ok: false/);
  });
});
