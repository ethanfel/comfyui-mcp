// #1429 — a retarget that lands while a tab is MID-TURN cannot replace that tab's
// comfyui MCP child, so the rest of that turn is served by a child still pointed
// at the OLD target. These pin the two halves of telling the agent about it:
//
//   * a tab that DEFERRED gets the nudge (it really did spend a turn stale), and
//   * a tab that was IDLE does NOT (its respawn beat any tool call, so the nudge
//     would be a false alarm — and a nudge is a real agent TURN, not a log line,
//     so a spurious one costs the user a response about nothing).
//
// The second is the direction that fails silently: a retargetAllForMcpEnv that
// nudged unconditionally would still pass every "does the busy tab get told?"
// assertion.
//
// The rest come from adversarial review of the first cut, and each one produced
// something worse than silence: an A-to-B message delivered while the child is on
// C, a per-request retry nudge erased one step removed, and a nudge fired for a
// target that never actually moved.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import { retargetIsWorthNudging, staleTargetNudge } from "../../orchestrator/retarget-nudge.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

/** Same shape as restart-coalesce.test.ts's backend: records every run() and every
 *  turn text, and can hold a turn open so a tab stays BUSY. */
class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  turnTexts: string[] = [];
  autoComplete = true;
  private releaseTurn: (() => void) | null = null;

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    yield { type: "session", sessionId: "sess-x" };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
      if (!this.autoComplete) {
        await new Promise<void>((resolve) => {
          this.releaseTurn = resolve;
        });
        this.releaseTurn = null;
      }
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  release(): void {
    const r = this.releaseTurn;
    this.releaseTurn = null;
    r?.();
  }

  async interrupt(): Promise<void> {
    this.release();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

function makeManager(backend: AgentBackend) {
  return new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
  } as never);
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const OLD = "http://127.0.0.1:8188";
const NEW = "https://pod-8188.proxy.runpod.net";
const NUDGE = staleTargetNudge(OLD, NEW);

describe("#1429 retarget nudge reaches exactly the tabs that were stale", () => {
  it("a MID-TURN tab is told, when its deferred respawn finally lands", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false; // hold the first turn open → tab is BUSY
    const manager = makeManager(backend);

    manager.send("tab-busy", "render me something");
    await waitFor(() => backend.turnTexts.length >= 1);

    // The retarget arrives mid-turn: it can only be scheduled.
    const tally = manager.retargetAllForMcpEnv(OLD, NEW);
    expect(tally).toEqual({ live: 1, applied: 0, scheduled: 1 });
    // Nothing delivered YET — the turn is still running, and interrupting it to
    // deliver news is not the trade this makes.
    expect(backend.turnTexts).toHaveLength(1);

    backend.autoComplete = true;
    backend.release(); // turn-done → applyPendingRestarts fires the respawn + nudge

    await waitFor(() => backend.turnTexts.includes(NUDGE));
    expect(backend.turnTexts.filter((t) => t === NUDGE)).toHaveLength(1);
  });

  it("an IDLE tab is NOT told — its child was replaced before it could run anything", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = true; // turn completes at once → tab goes IDLE
    const manager = makeManager(backend);

    manager.send("tab-idle", "hello");
    await waitFor(() => backend.turnTexts.length >= 1);
    // Let the turn finish so the tab is genuinely idle, not merely un-started.
    await new Promise((r) => setTimeout(r, 50));

    const before = backend.turnTexts.length;
    const tally = manager.retargetAllForMcpEnv(OLD, NEW);
    // Applied on the spot — so there was never a stale window to report.
    expect(tally.scheduled).toBe(0);
    expect(tally.applied).toBe(1);

    // Give a wrongly-delivered nudge every chance to show up.
    await new Promise((r) => setTimeout(r, 150));
    expect(backend.turnTexts.slice(before)).not.toContain(NUDGE);
    expect(backend.turnTexts).not.toContain(NUDGE);
  });

  it("does NOT erase a per-request retry nudge already queued for that tab (#164)", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    manager.send("tab-both", "download that model");
    await waitFor(() => backend.turnTexts.length >= 1);

    // A per-request retry nudge is queued first (credentials arrived, #164) …
    expect(manager.restartForMcpEnv("tab-both", "RETRY the download")).toBe("scheduled");
    // … then a retarget lands on the same still-busy tab.
    manager.retargetAllForMcpEnv(OLD, NEW);

    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.turnTexts.includes("RETRY the download"));
    // The more specific nudge survives; the retarget did not overwrite it, and
    // the tab is not restarted twice to deliver both.
    expect(backend.turnTexts.filter((t) => t === "RETRY the download")).toHaveLength(1);
    expect(backend.turnTexts).not.toContain(NUDGE);
  });

  it("two retargets in one turn report A-to-C — never the obsolete A-to-B", async () => {
    // codex finding: keeping the FIRST retarget's message tells the agent it is
    // on B while its respawned child is on C. Wrong information is worse than
    // none — it invites the agent to reason about infrastructure that moved on.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const A = "http://127.0.0.1:8188";
    const B = "https://pod-b.proxy.runpod.net";
    const C = "https://pod-c.proxy.runpod.net";

    manager.send("tab-abc", "render");
    await waitFor(() => backend.turnTexts.length >= 1);

    manager.retargetAllForMcpEnv(A, B); // stranded on A
    manager.retargetAllForMcpEnv(B, C); // still stranded on A — now heading to C

    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.turnTexts.length >= 2);
    const delivered = backend.turnTexts[backend.turnTexts.length - 1];
    // The ORIGIN is what the turn actually used, and C is where it is now.
    expect(delivered).toBe(staleTargetNudge(A, C));
    expect(backend.turnTexts).not.toContain(staleTargetNudge(A, B));
    expect(delivered).not.toContain(B);
  });

  it("a ROUND TRIP says nothing — the child never left the target it is on (#1443)", async () => {
    // Found by the independent review of 0.51.4. Whether to nudge was decided from
    // the INCOMING pair, while the message was composed from the PRESERVED origin,
    // so A→B→A produced staleTargetNudge(A, A): a real agent turn asserting the
    // target changed from A to A, for a tab whose child was correct throughout.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const A = "http://127.0.0.1:8188";
    const B = "https://pod-b.proxy.runpod.net";

    manager.send("tab-round-trip", "render");
    await waitFor(() => backend.turnTexts.length >= 1);

    manager.retargetAllForMcpEnv(A, B); // stranded on A
    manager.retargetAllForMcpEnv(B, A); // …and back. Nothing moved for this tab.

    backend.autoComplete = true;
    backend.release();
    await new Promise((r) => setTimeout(r, 200));

    expect(backend.turnTexts.some((x) => x.includes("target changed"))).toBe(false);
    expect(backend.turnTexts).not.toContain(staleTargetNudge(A, A));
  });

  it("a round trip does not strand the marker for a LATER real move", async () => {
    // The round trip clears the marker; a genuine move afterwards must still report
    // from where that turn actually is, not from a stale origin.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const A = "http://127.0.0.1:8188";
    const B = "https://pod-b.proxy.runpod.net";
    const C = "https://pod-c.proxy.runpod.net";

    manager.send("tab-after-trip", "render");
    await waitFor(() => backend.turnTexts.length >= 1);

    manager.retargetAllForMcpEnv(A, B);
    manager.retargetAllForMcpEnv(B, A); // round trip: marker cleared
    manager.retargetAllForMcpEnv(A, C); // a real move, from A

    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.turnTexts.length >= 2);
    expect(backend.turnTexts[backend.turnTexts.length - 1]).toBe(staleTargetNudge(A, C));
  });

  it("a per-request nudge queued AFTER a retarget survives the NEXT retarget", async () => {
    // codex finding, one step removed from #164: the retarget marker has to be
    // cleared when a per-request nudge overwrites the queued value, or the next
    // retarget classifies that nudge as its own and takes it.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    manager.send("tab-order", "download that model");
    await waitFor(() => backend.turnTexts.length >= 1);

    manager.retargetAllForMcpEnv(OLD, NEW); // retarget nudge queued
    expect(manager.restartForMcpEnv("tab-order", "RETRY the download")).toBe("scheduled");
    manager.retargetAllForMcpEnv(NEW, "https://pod-z.proxy.runpod.net"); // must not steal it

    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.turnTexts.length >= 2);
    expect(backend.turnTexts.filter((x) => x === "RETRY the download")).toHaveLength(1);
  });

  it("a same-target reaffirmation that only differs textually nudges NOBODY", async () => {
    // codex finding: the previous target is the raw COMFYUI_URL, the event carries
    // the canonical base URL, so a trailing slash reads as a move. A busy tab must
    // not be charged a whole turn to hear about a target that did not change.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    manager.send("tab-canon", "render");
    await waitFor(() => backend.turnTexts.length >= 1);

    const tally = manager.retargetAllForMcpEnv("http://127.0.0.1:8188/", "http://127.0.0.1:8188");
    expect(tally.scheduled).toBe(1); // the respawn still happens…

    backend.autoComplete = true;
    backend.release();
    await new Promise((r) => setTimeout(r, 150));
    // …but nothing is said about a target that did not move.
    expect(backend.turnTexts.some((x) => x.includes("target changed"))).toBe(false);
  });

  it("a BROADCAST per-request nudge is not stolen by the next retarget either", async () => {
    // Round-2 self-review: restartForMcpEnv cleared the marker but its all-tabs
    // sibling did not, so the same theft was still reachable one call over.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    manager.send("tab-broadcast", "download that model");
    await waitFor(() => backend.turnTexts.length >= 1);

    manager.retargetAllForMcpEnv(OLD, NEW); // retarget nudge queued
    manager.restartAllForMcpEnv("RETRY the download"); // broadcast nudge replaces it
    manager.retargetAllForMcpEnv(NEW, "https://pod-z.proxy.runpod.net"); // must not steal it

    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.turnTexts.length >= 2);
    expect(backend.turnTexts.filter((x) => x === "RETRY the download")).toHaveLength(1);
  });

  it("a tab renamed mid-turn keeps its retarget classification", async () => {
    // Round-2 self-review: rebindAgent migrated the queued nudge but not the
    // marker that says what KIND it is, so after a rename the next retarget read
    // it as a per-request nudge and preserved an obsolete target.
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const A = "http://127.0.0.1:8188";
    const B = "https://pod-b.proxy.runpod.net";
    const C = "https://pod-c.proxy.runpod.net";

    manager.send("tab-before", "render");
    await waitFor(() => backend.turnTexts.length >= 1);

    manager.retargetAllForMcpEnv(A, B); // stranded on A, queued under the old key
    expect(manager.rebindAgent("tab-before", "tab-after")).toBe(true);
    manager.retargetAllForMcpEnv(B, C); // must still recompose to A->C

    backend.autoComplete = true;
    backend.release();

    await waitFor(() => backend.turnTexts.length >= 2);
    const delivered = backend.turnTexts[backend.turnTexts.length - 1];
    expect(delivered).toBe(staleTargetNudge(A, C));
    expect(backend.turnTexts).not.toContain(staleTargetNudge(A, B));
  });

  it("the plain (non-retarget) nudge still reaches an IDLE tab — #164 semantics unchanged", async () => {
    const backend = new RecordingBackend();
    backend.autoComplete = true;
    const manager = makeManager(backend);

    manager.send("tab-plain", "hello");
    await waitFor(() => backend.turnTexts.length >= 1);

    // No onlyWhenDeferred: this nudge means "the thing you just tried can be
    // retried NOW", which is exactly right for an idle tab.
    manager.restartAllForMcpEnv("RETRY");
    await waitFor(() => backend.turnTexts.includes("RETRY"));
  });
});

describe("#1429 nudge wording", () => {
  it("names BOTH addresses — 'the target moved' alone cannot be acted on", () => {
    const msg = staleTargetNudge("http://old:8188", "http://new:8188");
    expect(msg).toContain("http://old:8188");
    expect(msg).toContain("http://new:8188");
  });

  it("says the stale address is a likely cause of a failure in that turn", () => {
    // The reported symptom (#1415-shaped) is a confusing connection failure; an
    // agent that reads this must not conclude ComfyUI is down.
    expect(staleTargetNudge("a", "b").toLowerCase()).toContain("retry");
  });

  it("a first-ever target is a startup seed, not a move — nothing to nudge about", () => {
    expect(retargetIsWorthNudging(null, "http://127.0.0.1:8188")).toBe(false);
    expect(retargetIsWorthNudging(undefined, "http://127.0.0.1:8188")).toBe(false);
    expect(retargetIsWorthNudging("", "http://127.0.0.1:8188")).toBe(false);
  });

  it("a same-address reaffirmation is not a move either", () => {
    expect(retargetIsWorthNudging("http://127.0.0.1:8188", "http://127.0.0.1:8188")).toBe(false);
  });

  it("an actual switch IS worth nudging about", () => {
    expect(retargetIsWorthNudging("http://127.0.0.1:8188", "https://pod.proxy.net")).toBe(true);
  });
});

describe("#1429 same-target detection (the expensive direction is a FALSE move)", () => {
  const moved = (a: string, b: string) => retargetIsWorthNudging(a, b);

  it("trailing slash, case and default ports are not moves", () => {
    expect(moved("http://127.0.0.1:8188/", "http://127.0.0.1:8188")).toBe(false);
    expect(moved("http://LOCALHOST:8188", "http://localhost:8188")).toBe(false);
    expect(moved("http://example.com:80", "http://example.com")).toBe(false);
    expect(moved("https://example.com:443/", "https://example.com")).toBe(false);
  });

  it("a real move is still a move", () => {
    expect(moved("http://127.0.0.1:8188", "http://127.0.0.1:8189")).toBe(true);
    expect(moved("http://127.0.0.1:8188", "https://127.0.0.1:8188")).toBe(true);
    expect(moved("http://127.0.0.1:8188", "https://pod.proxy.net")).toBe(true);
  });

  it("a base path is part of the target", () => {
    expect(moved("http://h:8188/comfyapi", "http://h:8188")).toBe(true);
    expect(moved("http://h:8188/comfyapi/", "http://h:8188/comfyapi")).toBe(false);
  });

  it("unparseable input falls back to exact equality rather than guessing", () => {
    expect(moved("not a url", "not a url")).toBe(false);
    expect(moved("not a url", "http://127.0.0.1:8188")).toBe(true);
  });
});
