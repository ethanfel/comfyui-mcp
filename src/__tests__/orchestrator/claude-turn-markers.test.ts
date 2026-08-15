// #728 r4 — the Claude backend's turn markers must be TRUE turn attribution,
// not a per-result output counter. The SDK's input pump and output reader are
// independent streams, and a turn's result can go MISSING (the panel's
// no-result fallback then releases the next turn) or arrive LATE — a counter
// that increments per result lags behind the panel's per-dispatch mirror in
// exactly those cases, stamping the NEXT turn's valid events with the abandoned
// turn's marker so PanelAgent dead-letters them (the r3 result-only wedge,
// Claude edition).
//
// The fix stamps from the #745 per-turn trace FIFO: a RESULT carries the trace
// it pops (the oldest in-flight — its OWN turn, even when late); every other
// message carries the NEWEST in-flight trace (the turn currently producing
// output). Pattern follows claude-empty-turn.test.ts: the optional Agent SDK is
// mocked, the backend is driven through run(), and the canonical AgentEvents
// are collected and asserted on.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../orchestrator/agent-backend.js";
import { waitFor } from "../helpers/wait-for.js";

// Keep the durable turn registry (#886) hermetic per test file — the backend
// writes it on every submission, and the fixed INIT session id would otherwise
// share one real-tmpdir file across files.
process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = mkdtempSync(join(tmpdir(), "claude-turn-markers-registry-"));

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

describe("Claude backend turn markers (#728 r4)", () => {
  it("stamps a result with its OWN turn and stream events with the newest in-flight turn", async () => {
    // A is interrupted mid-flight and produces NO result yet (the panel's
    // no-result fallback has already released the gate); B is submitted. While
    // A's result is still missing:
    //   • B's valid stream event must stamp with B's marker (2) — a per-result
    //     counter would stamp it 1 (A's), and PanelAgent would dead-letter B's
    //     legitimate work;
    //   • B's terminal pops/stamps B (a killed, superseded turn never delivers
    //     — the r10 contract), completing B's gate (no wedge);
    //   • A's LATE landing then pops its own parked trace, stamped with A's
    //     own marker (1) → PanelAgent dead-letters the straggler.
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
    await backend.interrupt(); // A interrupted mid-flight; no result arrives
    releaseTurnB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));

    // B's valid stream event WHILE A's result is still missing.
    hoisted.queue.push(assistantMsg("B working"));
    // B's terminal FIRST (per the r10 contract: a killed, superseded turn never
    // delivers, so B's success writes A off and pops/stamps B)…
    hoisted.queue.push(RESULT_SUCCESS);
    // …then A's LATE landing (error_during_execution in the SDK's real
    // vocabulary) — tolerated via its parked trace, stamped with A's own
    // marker, so PanelAgent dead-letters the abandoned turn's straggler.
    hoisted.queue.push(RESULT_INTERRUPTED);
    hoisted.queue.end();
    await done;

    // Session init is never stamped (unmarked = never dead-lettered).
    expect(events.find((e) => e.type === "session")?.turn).toBeUndefined();
    // B's stream event is attributed to B, NOT to the still-open abandoned turn.
    expect(events.find((e) => e.type === "assistant")).toMatchObject({ turn: 2 });
    // Each terminal is stamped with its OWN turn, in arrival order.
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, turn: 2 }); // B's terminal
    expect(results[1]).toMatchObject({ ok: true, turn: 1 }); // A's late landing
  });

  it("stamps a normal two-turn flow 1, 1, 2, 2 (run-relative, matching the panel mirror)", async () => {
    // Model the panel's turn gate: turn B is submitted only AFTER turn A's
    // result (production ordering — the gate releases the next batch on the
    // result), so each turn is the newest in-flight while it produces output.
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
    hoisted.queue.push(assistantMsg("reply A"));
    hoisted.queue.push(RESULT_SUCCESS);
    releaseTurnB(); // the result opens the panel's gate → B is submitted
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.push(assistantMsg("reply B"));
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done;

    const stamped = events
      .filter((e) => e.type === "assistant" || e.type === "result")
      .map((e) => `${e.type}:${e.turn}`);
    expect(stamped).toEqual(["assistant:1", "result:1", "assistant:2", "result:2"]);
  });

  it("permanent loss: B's terminal classifies/stamps as B when A's result never arrives (#728 r5)", async () => {
    // The r5 codex-gate finding: A is interrupted and its result NEVER arrives
    // (permanent loss). In the SDK's real result vocabulary an interrupted turn
    // ends with an error_during_execution result, so B's success terminal can
    // never be A's terminal — the oldest (interrupted) trace is skipped/parked
    // and B's terminal pops/stamps B's OWN trace. (Blind FIFO would pop A's
    // trace: B's terminal would be blessed by A's interrupt and stamped 1 —
    // blessed AND dead-lettered by the panel: a permanent wedge.)
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
    await backend.interrupt(); // A interrupted mid-flight; its result NEVER comes
    releaseTurnB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));

    // B's result-only terminal (EMPTY turn) arrives FIRST — classified by B's
    // OWN flags (ok:false + the synthetic empty-turn error, NOT A's interrupt
    // blessing) and stamped with B's marker, so the panel completes B's gate.
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: false, turn: 2 });
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("without producing a reply");
    expect(errors[0]).toMatchObject({ turn: 2 });

    // A's genuinely late INTERRUPTED landing then pops its own parked trace:
    // blessed (ok:true — the interrupt landing, not a failure) and stamped with
    // A's marker, so the panel dead-letters it as the abandoned turn's
    // straggler. B's classification stays untouched.
    hoisted.queue.push(RESULT_INTERRUPTED);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: true, turn: 1 });
    expect(errorsOf(events)).toHaveLength(1); // still only B's synthetic error
  });

  it("a newer interrupted turn's terminal does not re-consume a parked trace (#728 r6)", async () => {
    // The r6 codex-gate finding: with A parked (its result already declared
    // lost), a NEW interrupted turn C's interrupted terminal must pop/stamp
    // C's OWN trace — blindly popping the oldest (parked A) stamps A, so the
    // panel dead-letters C's real terminal and C wedges. Each trace lands at
    // most once; a landing with no unconsumed candidate fails closed.
    let releaseB!: () => void;
    let releaseC!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const gateC = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    async function* threeTurns() {
      yield { text: "turn A" };
      await gateB;
      yield { text: "turn B" };
      await gateC;
      yield { text: "turn C" };
    }
    const { backend, events, done } = await startBackend(threeTurns());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));

    // A is interrupted (its result will never come); B's success terminal
    // parks A and classifies/stamps B (the permanent-loss path).
    await backend.interrupt();
    releaseB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.push(RESULT_SUCCESS); // B's terminal → skip/park A
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ turn: 2 });

    // C is interrupted; C's interrupted terminal must pop/stamp C's OWN trace —
    // NOT the parked A.
    releaseC();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(3));
    await backend.interrupt(); // marks the newest unresolved trace — C
    hoisted.queue.push(RESULT_INTERRUPTED); // C's landing
    await waitFor(() => expect(resultsOf(events)).toHaveLength(2));
    expect(resultsOf(events)[1]).toMatchObject({ ok: true, turn: 3 });

    // A's OWN late landing still pops its parked trace — exactly once.
    hoisted.queue.push(RESULT_INTERRUPTED); // A's landing
    await waitFor(() => expect(resultsOf(events)).toHaveLength(3));
    expect(resultsOf(events)[2]).toMatchObject({ ok: true, turn: 1 });

    // A SECOND landing with no unconsumed candidate is anomalous → fail closed
    // (the #745 traceless rule): unverifiable, ok:false, never fabricated, and
    // UNMARKED so the panel still sees it.
    hoisted.queue.push(RESULT_INTERRUPTED);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(4);
    expect(results[3]).toMatchObject({ ok: false });
    expect(results[3].turn).toBeUndefined();
    expect(errorsOf(events).some((e) => /could not be matched|unverifiable/i.test(e.message))).toBe(true);
  });

  it("queued-input ordering: C's trace exists while A is unsettled — A's landing pops A, then C's pops C (#728 r8)", async () => {
    // The r8 codex-gate reframing: the SDK emits results in PROCESSING ORDER,
    // so a newer turn's trace can exist while the older turn is still settling
    // (queued input) — and the older turn's legitimate landing MUST still pop
    // the OLDEST live interrupted trace. (The r7 newest-preference assigned
    // A's legitimate landing to C — writing A off and fabricating C's
    // terminal — and its C-terminal-first ordering is impossible under this
    // contract, so that test is replaced by this valid one.)
    let releaseC!: () => void;
    const gateC = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    async function* twoTurns() {
      yield { text: "turn A" };
      await gateC;
      yield { text: "turn C" };
    }
    const { backend, events, done } = await startBackend(twoTurns());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));

    // A is interrupted; C's trace is then created while A is STILL unsettled,
    // and C is marked interrupted too (the SDK is still settling A).
    await backend.interrupt(); // marks A (newest at the time)
    releaseC();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    await backend.interrupt(); // marks C

    // A's legitimate interrupted result arrives FIRST (processing order) →
    // pops/stamps A, NOT C.
    hoisted.queue.push(RESULT_INTERRUPTED);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: true, turn: 1 });

    // C's own landing then pops C.
    hoisted.queue.push(RESULT_INTERRUPTED);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: true, turn: 2 });
    expect(errorsOf(events)).toHaveLength(0);
  });

  it("healthy newer turn's genuine error pops/stamps itself — not the killed older turn (#728 r10)", async () => {
    // The r10 codex-gate finding: A was interrupted (marked) and superseded by
    // healthy B; A's interrupt terminal is missing (a killed, superseded turn
    // never delivers). B's GENUINE error_during_execution must pop/stamp B —
    // popping A instead would bless a fabricated ok:true stamped 1 that the
    // panel dead-letters while B's gate stays held.
    let releaseB!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    async function* twoTurns() {
      yield { text: "turn A" };
      await gate;
      yield { text: "turn B" };
    }
    const { backend, events, done } = await startBackend(twoTurns());
    hoisted.queue.push(INIT);
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    await backend.interrupt(); // marks A; A's terminal will never arrive
    releaseB();
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));

    // B's GENUINE error lands first: A is written off (parked), B is popped —
    // classified by B's OWN flags (a genuine failure, NO blessing) and stamped
    // with B's marker, so the panel completes B's gate.
    hoisted.queue.push(RESULT_INTERRUPTED); // error_during_execution — B's genuine error
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: false, turn: 2 });
    expect(errorsOf(events)).toHaveLength(0); // a genuine error result carries no synthetic error

    // A's late interrupt landing (if it ever arrives) pops its own parked
    // trace: blessed via ITS mark (ok:true — the landing, not a failure) and
    // stamped with A's marker, so the panel dead-letters the straggler.
    hoisted.queue.push(RESULT_INTERRUPTED);
    hoisted.queue.end();
    await done;
    const results = resultsOf(events);
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ ok: true, turn: 1 });
    expect(errorsOf(events)).toHaveLength(0);
  });
});
