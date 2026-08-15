// #885 — a harness-cleared STALL must never reach the Claude agent as a bare
// user rejection. The Agent SDK has no mid-turn steer (Codex's turn/steer
// equivalent): a message pushed into the stream is queued by the CLI until the
// turn ENDS, which a frozen turn cannot do. So the backend holds the harness
// stall notice and prepends it — delimited as harness text, never the user's
// words — to the NEXT user turn, where it lands in the transcript right beside
// the interrupt's generic "the user doesn't want to proceed" payload. Without
// it the agent reads that payload at face value and tells the user "you
// cancelled" — a false statement about the user's own actions.
//
// Pattern follows claude-turn-markers.test.ts: the optional Agent SDK is
// mocked, the backend is driven through run(), and the SDK-bound user messages
// are captured verbatim for assertion. The final test drives the FULL loop —
// PanelAgent watchdog → recoverStalledTurn → bounded interrupt → next turn —
// with the real ClaudeBackend over the mock SDK.

import { describe, expect, it, beforeEach, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";
import { waitFor } from "../helpers/wait-for.js";

// SHORT idle window for the panel-level test — must be set before panel-agent
// is imported (TURN_IDLE_MS is read at module load).
const IDLE_MS = 120;
process.env.COMFYUI_MCP_TURN_IDLE_MS = String(IDLE_MS);
// Keep the durable turn registry (#886) hermetic — every submission persists it.
process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = mkdtempSync(join(tmpdir(), "claude-stall-notice-registry-"));

const hoisted = vi.hoisted(() => ({
  queue: new (class {
    private buf: unknown[] = [];
    private waiters: Array<() => void> = [];
    private closed = false;
    reset(): void {
      this.buf = [];
      this.closed = false;
    }
    push(m: unknown): void {
      this.buf.push(m);
      for (const w of this.waiters.splice(0)) w();
    }
    end(): void {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    }
    async *iterate(): AsyncGenerator<unknown> {
      for (;;) {
        while (this.buf.length) yield this.buf.shift();
        if (this.closed) return;
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      }
    }
  })(),
  /** The exact user-message texts the SDK pulled from the prompt channel. */
  prompts: [] as string[],
}));

function textOf(msg: unknown): string {
  const content = (msg as { message?: { content?: unknown } })?.message?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: { prompt?: AsyncIterable<unknown> }) => {
    void (async () => {
      for await (const m of arg.prompt ?? []) hoisted.prompts.push(textOf(m));
    })();
    const iter = hoisted.queue.iterate();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      // The real CLI ends an interrupted turn with an error_during_execution
      // result (the interrupt landing) — model that so the panel's gate opens.
      interrupt: async () => {
        hoisted.queue.push({ type: "result", subtype: "error_during_execution" });
      },
      setModel: async () => {},
    });
  },
}));

beforeEach(() => {
  hoisted.queue.reset();
  hoisted.prompts.length = 0;
});

let PanelAgent: typeof import("../../orchestrator/panel-agent.js").PanelAgent;
beforeAll(async () => {
  ({ PanelAgent } = await import("../../orchestrator/panel-agent.js"));
});

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "stall-notice-0000-1111-2222-333333333333",
  model: "claude-test-1",
  apiKeySource: "none",
  skills: [],
};

const RESULT_SUCCESS = { type: "result", subtype: "success" };

const NOTICE =
  "[harness stall notice] This turn stalled with no activity and was detected by the harness. " +
  "The user did NOT reject or cancel this tool call. Do not tell the user that they stopped it. " +
  "Inspect side effects if the call may have started; otherwise it is safe to retry the same call.";

function assistantMsg(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", id: "msg-1", content: [{ type: "text", text }] },
    uuid: "a-1",
    session_id: INIT.session_id,
    parent_tool_use_id: null,
  };
}

/** A channel that models the panel's turn gate: turn N+1 is not readable until
 *  the test releases it (production ordering — the gate holds the next batch
 *  until the in-flight turn settles). Without this the drain reads ahead and
 *  interrupt() would mark the WRONG (newest) trace. */
function gatedChannel(turns: string[]) {
  let allowed = 1;
  let wake: (() => void) | null = null;
  async function* channel() {
    for (let i = 0; i < turns.length; i++) {
      while (i >= allowed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      yield { text: turns[i] };
    }
  }
  return {
    channel,
    releaseNext: () => {
      allowed += 1;
      wake?.();
    },
  };
}

async function startBackend(channel: AsyncGenerator<{ text: string }>) {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const ev of backend.run({ channel: channel as never })) events.push(ev);
  })();
  return { backend, events, done };
}

const resultsOf = (events: AgentEvent[]) => events.filter((e) => e.type === "result");

describe("claude backend stall notice (#885)", () => {
  it("declines the steer (no mid-turn steer exists) and delivers the notice on the NEXT user turn, delimited as harness text", async () => {
    const gate = gatedChannel(["first turn", "second turn"]);
    const { backend, done } = await startBackend(gate.channel());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.prompts).toHaveLength(1));
    expect(hoisted.prompts[0]).toBe("first turn"); // no notice before any stall

    // The watchdog stalls the turn; the Claude SDK offers no mid-turn steer,
    // so the hook must decline (PanelAgent keeps the bounded interrupt
    // recovery) while HOLDING the notice for the next turn.
    await expect(backend.recoverStalledTurn(NOTICE)).resolves.toBe(false);
    await backend.interrupt(); // the fallback path lands the interrupt
    gate.releaseNext();
    await waitFor(() => expect(hoisted.prompts).toHaveLength(2));

    const delivered = hoisted.prompts[1];
    // The notice leads, is framed as harness text (never the user's words),
    // names the PREVIOUS turn, and the user's own text follows intact.
    expect(delivered).toContain(NOTICE);
    expect(delivered.indexOf(NOTICE)).toBeLessThan(delivered.indexOf("second turn"));
    expect(delivered).toMatch(/not part of the user's message/i);
    expect(delivered).toMatch(/PREVIOUS turn/);
    expect(delivered).toContain("second turn");
    hoisted.queue.end();
    await done;
  });

  it("delivers the notice exactly once — the turn after delivery is verbatim again", async () => {
    const gate = gatedChannel(["one", "two", "three"]);
    const { backend, events, done } = await startBackend(gate.channel());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.prompts).toHaveLength(1));
    await backend.recoverStalledTurn(NOTICE);
    await backend.interrupt();
    gate.releaseNext();
    await waitFor(() => expect(hoisted.prompts).toHaveLength(2));
    expect(hoisted.prompts[1]).toContain(NOTICE);
    // Turn two (carrying the notice) completes; turn three is clean. Wait for
    // the result to actually route before releasing — production ordering (the
    // panel's gate releases the next batch only on the result).
    hoisted.queue.push(assistantMsg("noted — retrying"));
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(2));
    gate.releaseNext();
    await waitFor(() => expect(hoisted.prompts).toHaveLength(3));
    expect(hoisted.prompts[2]).toBe("three");
    hoisted.queue.end();
    await done;
  });

  it("a genuine success landing for the stalled turn CLEARS the held notice — no rejection payload ever landed", async () => {
    const gate = gatedChannel(["one", "two"]);
    const { backend, events, done } = await startBackend(gate.channel());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.prompts).toHaveLength(1));
    await backend.recoverStalledTurn(NOTICE);
    // …but the "stalled" turn actually completed on its own (a success landing,
    // not an interrupt landing): the transcript has NO rejection payload, so
    // delivering the notice would correct a lie that was never told. Wait for
    // the result to route (production ordering) before the next turn shapes.
    hoisted.queue.push(assistantMsg("actually finished"));
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    gate.releaseNext();
    await waitFor(() => expect(hoisted.prompts).toHaveLength(2));
    expect(hoisted.prompts[1]).toBe("two");
    hoisted.queue.end();
    await done;
  });

  it("a genuine ERROR self-landing for the stalled turn also clears the held notice (the harness never cleared it)", async () => {
    const gate = gatedChannel(["one", "two"]);
    const { backend, events, done } = await startBackend(gate.channel());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.prompts).toHaveLength(1));
    await backend.recoverStalledTurn(NOTICE);
    // The turn failed on its own before the interrupt landed — a self-landing,
    // not a harness clear, so no rejection payload exists to correct.
    hoisted.queue.push(assistantMsg("partial work"));
    hoisted.queue.push({ type: "result", subtype: "error_max_turns" });
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    gate.releaseNext();
    await waitFor(() => expect(hoisted.prompts).toHaveLength(2));
    expect(hoisted.prompts[1]).toBe("two");
    hoisted.queue.end();
    await done;
  });

  it("full loop: a watchdog-stalled PanelAgent turn interrupts, and the next user message carries the notice to the SDK", async () => {
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const says: string[] = [];
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    const agent = new PanelAgent(
      "tab-stall-notice",
      {
        mcpServers: {},
        systemAppend: "",
        model: "claude-test",
        onSay: (_tab: string, text: string) => {
          says.push(text);
        },
      } as never,
      backend,
    );
    void agent.start();
    agent.send("run the long thing");
    // The mock SDK emits NOTHING for the turn → the idle watchdog trips.
    await waitFor(() => expect(says.join("\n")).toMatch(/stopped responding/i), {
      timeout: IDLE_MS * 20,
    });
    // The user was told the truth (a harness-cleared stall), NOT the
    // steer-success phrasing — this provider has no steer, and the message
    // must not claim one happened.
    expect(says.join("\n")).not.toMatch(/you did NOT cancel/i);

    agent.send("what happened?");
    await waitFor(() => expect(hoisted.prompts).toHaveLength(2), { timeout: IDLE_MS * 20 });
    const delivered = hoisted.prompts[1];
    // The property #885 asks for: the agent can no longer read the interrupt's
    // generic rejection payload as a user decision — the harness correction
    // sits right next to it in the transcript.
    expect(delivered).toMatch(/user did NOT reject or cancel/i);
    expect(delivered).toMatch(/safe to retry/i);
    expect(delivered).toMatch(/Do not tell the user that they stopped it/i);
    expect(delivered).toContain("what happened?");
    await agent.stop();
  });
});
