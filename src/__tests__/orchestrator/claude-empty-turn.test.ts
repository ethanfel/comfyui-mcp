// #740 — the Claude backend must not drop blocking SDK informational messages
// (e.g. a UserPromptSubmit hook denying the prompt) and must never report a turn
// that produced NO assistant content as a successful turn. The SDK ends such a
// turn with a `result` whose subtype is STILL "success"; the adapter has to
// classify it truthfully and surface the reason.
//
// Pattern follows claude-spawn-env.test.ts: the optional Agent SDK is mocked,
// the backend is driven through run(), and the canonical AgentEvents are
// collected and asserted on.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";
import { waitFor } from "../helpers/wait-for.js";

// Keep the durable turn registry (#886) hermetic per test file — the backend
// writes it on every submission, and the fixed INIT session id would otherwise
// share one real-tmpdir file across files.
process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = mkdtempSync(join(tmpdir(), "claude-empty-turn-registry-"));

const hoisted = vi.hoisted(() => ({
  /** A push-based async message source — stands in for the live SDK query stream. */
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
  onInterrupt: null as null | (() => void),
  /** User turns the mock SDK pulled from the prompt channel (proves submission). */
  promptsSeen: 0,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: { prompt?: AsyncIterable<unknown> }) => {
    // The real SDK pulls user turns out of the prompt generator — drain it the
    // same way so the backend's turn tracking sees every submitted turn.
    void (async () => {
      for await (const _ of arg.prompt ?? []) hoisted.promptsSeen += 1;
    })();
    const iter = hoisted.queue.iterate();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {
        hoisted.onInterrupt?.();
      },
      setModel: async () => {},
    });
  },
}));

beforeEach(() => {
  hoisted.queue.reset();
  hoisted.onInterrupt = null;
  hoisted.promptsSeen = 0;
});

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "00000000-1111-2222-3333-444444444444",
  model: "claude-test-1",
  apiKeySource: "none",
  skills: [],
};

const RESULT_SUCCESS = { type: "result", subtype: "success" };

/** The interrupt landing in the SDK's REAL result vocabulary (#728 r9: an
 *  interrupted turn ends with an error_during_execution result — there is no
 *  "interrupted" result subtype). */
const RESULT_INTERRUPTED = { type: "result", subtype: "error_during_execution" };

function assistantMsg(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", id: "msg-1", content: [{ type: "text", text }] },
    uuid: "a-1",
    session_id: INIT.session_id,
    parent_tool_use_id: null,
  };
}

function informational(extra: Record<string, unknown>) {
  return {
    type: "system",
    subtype: "informational",
    content: "UserPromptSubmit operation blocked by hook: memory-worker unavailable",
    level: "warning",
    uuid: "i-1",
    session_id: INIT.session_id,
    ...extra,
  };
}

async function* channel() {
  yield { text: "hi" };
}

/** Drive one backend session over the given script; resolve with the events.
 *  The turn is SUBMITTED before the script's messages are pushed — production
 *  ordering (the SDK pulls the user prompt before any turn message exists),
 *  which per-turn state tracking relies on. */
async function runScript(script: unknown[]): Promise<AgentEvent[]> {
  const { events, done } = await startBackend(channel());
  await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
  for (const m of script) hoisted.queue.push(m);
  hoisted.queue.end();
  await done;
  return events;
}

/** Start a live backend over a caller-controlled channel (for multi-turn flows). */
async function startBackend(channelGen: AsyncGenerator<{ text: string }>) {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const ev of backend.run({ channel: channelGen as never })) events.push(ev);
  })();
  return { backend, events, done };
}

const resultsOf = (events: AgentEvent[]) => events.filter((e) => e.type === "result");
const errorsOf = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");

describe("Claude backend #740 — blocking SDK informational messages", () => {
  it("surfaces the hook-block reason and fails the turn (prevent_continuation)", async () => {
    const events = await runScript([
      INIT,
      informational({ prevent_continuation: true }),
      RESULT_SUCCESS,
    ]);
    // The user receives the block reason…
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("UserPromptSubmit operation blocked by hook");
    // …exactly one terminal result is emitted, and it is a FAILED one…
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "result", ok: false, subtype: "success" });
    // …and no successful/empty assistant turn was produced.
    expect(events.some((e) => e.type === "assistant")).toBe(false);
  });

  it("honors the camelCase preventContinuation wire spelling too", async () => {
    const events = await runScript([
      INIT,
      informational({ preventContinuation: true }),
      RESULT_SUCCESS,
    ]);
    expect(errorsOf(events)).toHaveLength(1);
    expect(resultsOf(events)).toHaveLength(1);
    expect(resultsOf(events)[0]).toMatchObject({ ok: false });
  });

  it("a blocking turn does not leak its failure into the NEXT turn", async () => {
    // Two REAL turns (turn identity: each needs its own submission + trace).
    let releaseTurnB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurnB = resolve;
    });
    async function* twoTurns() {
      yield { text: "turn A" };
      await gate;
      yield { text: "turn B" };
    }
    const { events, done } = await startBackend(twoTurns());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    // Turn A is hook-blocked and fails…
    hoisted.queue.push(informational({ prevent_continuation: true }));
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: false });
    // …and turn B then recovers and classifies cleanly on its own flags.
    releaseTurnB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.push(assistantMsg("recovered"));
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: true });
  });
});

describe("Claude backend #740 — an empty turn is never a success", () => {
  it("a result/success with no assistant content is reported as a failure", async () => {
    const events = await runScript([INIT, RESULT_SUCCESS]);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("without producing a reply");
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, subtype: "success" });
  });

  it("a normal turn (assistant text + result/success) still reports success", async () => {
    const events = await runScript([INIT, assistantMsg("Hello!"), RESULT_SUCCESS]);
    expect(errorsOf(events)).toHaveLength(0);
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
    const said = events.filter((e) => e.type === "assistant");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ text: "Hello!" });
  });

  it("a non-blocking informational does not fail or replace the turn", async () => {
    const events = await runScript([
      INIT,
      informational({}), // no prevent_continuation → execution continues
      assistantMsg("still answered"),
      RESULT_SUCCESS,
    ]);
    expect(errorsOf(events)).toHaveLength(0);
    expect(resultsOf(events)).toHaveLength(1);
    expect(resultsOf(events)[0]).toMatchObject({ ok: true });
  });

  it("slash-command output (local_command_output) counts as turn content", async () => {
    const events = await runScript([
      INIT,
      {
        type: "system",
        subtype: "local_command_output",
        content: "Context: 12k / 200k",
        uuid: "l-1",
        session_id: INIT.session_id,
      },
      RESULT_SUCCESS,
    ]);
    expect(errorsOf(events)).toHaveLength(0);
    expect(resultsOf(events)).toHaveLength(1);
    expect(resultsOf(events)[0]).toMatchObject({ ok: true });
  });

  it("an empty result right after a MID-TURN interrupt() is the interrupt landing, not a failure", async () => {
    const { backend, events, done } = await startBackend(channel());
    hoisted.onInterrupt = () => {
      hoisted.queue.push(RESULT_SUCCESS);
      hoisted.queue.end();
    };
    hoisted.queue.push(INIT);
    // Wait until the turn is actually IN FLIGHT (submitted to the SDK)…
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    // …then stop it: the aborted empty result stays a clean ok:true.
    await backend.interrupt();
    await done;
    expect(errorsOf(events)).toHaveLength(0);
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
  });
});

describe("Claude backend — interruptPending is strictly turn-scoped (#745 review)", () => {
  it("an interrupt() while NO turn is in flight does not bless a later empty turn", async () => {
    let releaseTurnB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurnB = resolve;
    });
    async function* twoTurns() {
      yield { text: "turn A" };
      await gate; // hold turn B until the test says the session is idle
      yield { text: "turn B" };
    }
    const { backend, events, done } = await startBackend(twoTurns());
    hoisted.queue.push(INIT);
    // Turn A goes in flight, produces content, and completes successfully.
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.push(assistantMsg("A reply"));
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: true });
    // Idle now: turn A's result is consumed and turn B is not yet submitted.
    // This interrupt must leave NO state behind.
    await backend.interrupt();
    releaseTurnB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    // Turn B ends genuinely empty → still a failure with the synthetic error.
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false });
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("without producing a reply");
  });

  it("a mid-turn interrupt's blessing is consumed by its OWN result, not the next turn's", async () => {
    let releaseTurnB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurnB = resolve;
    });
    async function* twoTurns() {
      yield { text: "turn A" };
      await gate;
      yield { text: "turn B" };
    }
    const { backend, events, done } = await startBackend(twoTurns());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    // Interrupt turn A in flight → its aborted empty result stays ok:true…
    await backend.interrupt();
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: true });
    // …but the blessing dies with that result: turn B's empty result still fails.
    releaseTurnB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: false });
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("without producing a reply");
  });

  it("a superseded interrupted turn never delivers — the first result classifies to the NEWER turn (#728 r10)", async () => {
    let releaseTurnB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurnB = resolve;
    });
    async function* twoTurns() {
      yield { text: "turn A" };
      await gate;
      yield { text: "turn B" };
    }
    const { backend, events, done } = await startBackend(twoTurns());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    // Turn A is interrupted mid-flight and produces NO result; the panel's
    // no-result fallback releases the gate and turn B is submitted. Per the
    // r10 contract, a killed turn SUPERSEDED by a newer submission never
    // delivers — so the FIRST result after the supersession is the newer
    // turn's own, even as error_during_execution (A is written off/parked;
    // pre-r10 this stream was attributed to A — that premise is rejected).
    await backend.interrupt();
    releaseTurnB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.push(RESULT_INTERRUPTED); // classifies as B's genuine error
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: false, turn: 2 });
    expect(errorsOf(events)).toHaveLength(0); // genuine error result — no synthetic error
    // A's genuinely late landing, if it ever arrives, is then tolerated via
    // its parked trace: blessed ok:true (the interrupt landing, not a failure),
    // stamped with A's own marker — and turn B's classification untouched.
    hoisted.queue.push(RESULT_INTERRUPTED);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: true, turn: 1 });
    expect(errorsOf(events)).toHaveLength(0);
  });

  it("an interrupt's blessing does not survive a session restart, and a stray result from the dead session fails closed", async () => {
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    // Session 1: turn A goes in flight and is interrupted; the session then
    // dies with NO result for A — the self-restart loop re-calls run() on the
    // SAME backend instance (as PanelAgent does).
    const events1: AgentEvent[] = [];
    const done1 = (async () => {
      for await (const ev of backend.run({ channel: channel() as never })) events1.push(ev);
    })();
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    await backend.interrupt();
    hoisted.queue.end();
    await done1;
    // Session 2.
    hoisted.queue.reset();
    hoisted.promptsSeen = 0;
    const events: AgentEvent[] = [];
    const done2 = (async () => {
      for await (const ev of backend.run({ channel: channel() as never })) events.push(ev);
    })();
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    // Turn B ends genuinely empty → failure + the synthetic error (no leak of
    // session 1's blessing across the restart boundary).
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: false });
    expect(errorsOf(events)).toHaveLength(1);
    // A STRAY late result from the dead session must still FAIL CLOSED —
    // ok:false, never a forwarded success (#745 r3). But turn A WAS submitted
    // before session 1 died, so the report must not claim the opposite: the
    // stray is RECOGNIZED as a submitted turn's late landing and disclosed as
    // "completed but unverified", not "matched to no submitted turn" (#886).
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done2;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: false });
    const errors = errorsOf(events);
    expect(errors).toHaveLength(2); // turn B's synthetic error + the stray's recognized one
    expect(errors[1].message).toMatch(/completing late/i);
    expect(errors[1].message).toMatch(/NOT counting it as a success/i);
    expect(errors[1].message).not.toMatch(/could not be matched/i);
    expect(errors[1].unverifiedCompletion).toBe(true);
  });

  it("a result/success with NO matching turn fails closed (unverifiable) instead of forwarding ok:true", async () => {
    const { events, done } = await startBackend(channel());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    // One submission, TWO results: the second has no trace. A normal successful
    // turn ALWAYS has a trace (stamped at submission), so traceless is
    // anomalous by construction — it must not fabricate a success (#745 r3).
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: false }); // genuinely empty turn
    expect(results[1]).toMatchObject({ ok: false }); // traceless → unverifiable
    const errors = errorsOf(events);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toContain("without producing a reply");
    expect(errors[1].message).toMatch(/unverifiable/i);
  });

  it("overflow eviction poisons classification — NO result across an evicted-turn gap is fabricated as ok:true", async () => {
    async function* seventeenTurns() {
      for (let i = 1; i <= 17; i++) yield { text: `turn ${i}` };
    }
    const { events, done } = await startBackend(seventeenTurns());
    hoisted.queue.push(INIT);
    // The 17th submission overflows the 16-trace bound and evicts trace #1.
    await waitFor(() => expect(hoisted.promptsSeen).toBe(17));
    // Every turn's result arrives late. Turn 1's result crosses the evicted
    // gap (poisoned → unverifiable); turn 17's own result ends up traceless
    // (fail closed). NOTHING may be forwarded as ok:true.
    for (let i = 0; i < 17; i++) hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(17);
    expect(results.some((r) => r.type === "result" && r.ok === true)).toBe(false);
    expect(errorsOf(events).some((e) => /unverifiable/i.test(e.message))).toBe(true);
  });

  it("an evicted-turn gap poisons the SESSION — later results never recover ok:true, content included", async () => {
    async function* seventeenTurns() {
      for (let i = 1; i <= 17; i++) yield { text: `turn ${i}` };
    }
    const { events, done } = await startBackend(seventeenTurns());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(17)); // 17th submission evicts trace #1
    // Turn 1's late result crosses the evicted gap → FIFO alignment is
    // UNRECOVERABLE → the session is poisoned terminally.
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: false });
    // Content streaming in afterward accrues to a MISMATCHED trace — it is not
    // proof of its own turn's success and must NOT rescue classification:
    // every later result in this session fails closed too (#745 r4).
    hoisted.queue.push(assistantMsg("late content from a mismatched turn"));
    for (let i = 0; i < 16; i++) hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(17);
    expect(results.some((r) => r.type === "result" && r.ok === true)).toBe(false);
    const errors = errorsOf(events);
    expect(errors).toHaveLength(17);
    expect(errors.every((e) => /unverifiable/i.test(e.message))).toBe(true);
  });

  it("a genuine run() restart clears the poison — the first new turn classifies normally", async () => {
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    // Session 1: overflow the trace bound and trip the gap → poisoned.
    async function* seventeenTurns() {
      for (let i = 1; i <= 17; i++) yield { text: `turn ${i}` };
    }
    const events1: AgentEvent[] = [];
    const done1 = (async () => {
      for await (const ev of backend.run({ channel: seventeenTurns() as never })) events1.push(ev);
    })();
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(17));
    hoisted.queue.push(RESULT_SUCCESS); // crosses the evicted gap → poison
    hoisted.queue.end();
    await done1;
    expect(resultsOf(events1)).toHaveLength(1);
    expect(resultsOf(events1)[0]).toMatchObject({ ok: false });
    // Session 2 (the self-restart loop re-calls run() on the same backend): the
    // restart boundary is the ONLY poison reset — a normal successful turn must
    // classify ok:true again.
    hoisted.queue.reset();
    hoisted.promptsSeen = 0;
    const events: AgentEvent[] = [];
    const done2 = (async () => {
      for await (const ev of backend.run({ channel: channel() as never })) events.push(ev);
    })();
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.push(assistantMsg("hello again"));
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done2;
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
    expect(errorsOf(events)).toHaveLength(0);
  });

  it("a run() restart after a FULLY DRAINED poisoned session does not falsely re-poison the first new turn", async () => {
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    // Session 1: overflow, trip the gap (poisoned), then drain EVERY result so
    // the trace FIFO ends EMPTY — no dead traces remain at the boundary.
    async function* seventeenTurns() {
      for (let i = 1; i <= 17; i++) yield { text: `turn ${i}` };
    }
    const events1: AgentEvent[] = [];
    const done1 = (async () => {
      for await (const ev of backend.run({ channel: seventeenTurns() as never })) events1.push(ev);
    })();
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(17));
    for (let i = 0; i < 17; i++) hoisted.queue.push(RESULT_SUCCESS); // gap → poison → all fail closed; FIFO drains to empty
    hoisted.queue.end();
    await done1;
    expect(resultsOf(events1)).toHaveLength(17);
    expect(resultsOf(events1).some((r) => r.type === "result" && r.ok === true)).toBe(false);
    // Session 2 (restart boundary): the result sequence must advance past the
    // drained session's turn ids even with an EMPTY FIFO — otherwise the first
    // new turn re-crosses the old gap and falsely re-poisons (#745 r5).
    hoisted.queue.reset();
    hoisted.promptsSeen = 0;
    const events: AgentEvent[] = [];
    const done2 = (async () => {
      for await (const ev of backend.run({ channel: channel() as never })) events.push(ev);
    })();
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.push(assistantMsg("back to normal"));
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done2;
    const results = resultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true });
    expect(errorsOf(events)).toHaveLength(0);
  });
});
