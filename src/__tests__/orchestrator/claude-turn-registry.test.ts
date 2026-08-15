// #886 — the Claude backend's submitted-turn record must survive a session
// restart, and an unmatched result must be REPORTED honestly:
//
//   • run() (re)entry used to DROP the dead session's traces, so a late result
//     from it arrived "matching no submitted turn" — claiming the turn never
//     existed when only its record was lost (the "could not determine →
//     determined not" fold). The ids are now remembered (in memory across the
//     self-restart loop, and durably on disk across an orchestrator respawn),
//     so the stray is RECOGNIZED as a submitted turn's late landing.
//   • Recognition never upgrades classification: the result still fails closed
//     (ok:false). Only the report changes — "completed but unverified", with
//     the retry warning, instead of "could not be matched to any submitted
//     turn" framed as a turn failure.
//   • A traceless result with NO outstanding submission on record keeps the
//     original "could not be matched" report (that claim is then well-founded).
//
// Pattern follows claude-turn-markers.test.ts (mocked Agent SDK, backend driven
// through run()). The registry dir is redirected to a fresh mkdtemp per test.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, AgentEvent, BackendStartOptions, ModelChoice } from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import { waitFor } from "../helpers/wait-for.js";

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
  promptsSeen: 0,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (arg: { prompt?: AsyncIterable<unknown> }) => {
    void (async () => {
      for await (const _ of arg.prompt ?? []) hoisted.promptsSeen += 1;
    })();
    const iter = hoisted.queue.iterate();
    return Object.assign(iter, {
      supportedModels: async () => [],
      supportedCommands: async () => [],
      interrupt: async () => {},
      setModel: async () => {},
    });
  },
}));

let registryDir: string;

beforeEach(() => {
  hoisted.queue.reset();
  hoisted.promptsSeen = 0;
  registryDir = mkdtempSync(join(tmpdir(), "claude-turn-registry-test-"));
  process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = registryDir;
});

const RESULT_SUCCESS = { type: "result", subtype: "success" };

function init(sessionId: string) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-test-1",
    apiKeySource: "none",
    skills: [],
  };
}

function assistantMsg(sessionId: string, text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", id: "msg-1", content: [{ type: "text", text }] },
    uuid: "a-1",
    session_id: sessionId,
    parent_tool_use_id: null,
  };
}

async function* oneTurn(text = "hi") {
  yield { text };
}

async function startBackend(opts: { resume?: string; sessionId?: string } = {}) {
  const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
  const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const ev of backend.run({
      channel: oneTurn() as never,
      ...(opts.resume ? { resume: opts.resume } : {}),
    })) events.push(ev);
  })();
  return { backend, events, done };
}

const resultsOf = (events: AgentEvent[]) => events.filter((e) => e.type === "result");
const errorsOf = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");

/** Instance files for a session (excludes the shared tombstone file). */
const registryFiles = (sessionId: string) =>
  readdirSync(registryDir).filter(
    (n) => n.startsWith(`turn-registry-${sessionId}-`) && n.endsWith(".json") && !n.includes("tombstones"),
  );
const registryFile = (sessionId: string) => join(registryDir, registryFiles(sessionId)[0]);

describe("claude backend durable turn registry (#886)", () => {
  it("persists outstanding submissions; a NEW backend instance resuming the session recognizes a late result", async () => {
    const S1 = "11111111-1111-1111-1111-111111111111";
    // Process 1: a turn is submitted and its session dies with NO result.
    const first = await startBackend();
    hoisted.queue.push(init(S1));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.end();
    await first.done;
    // The submission was recorded durably — this is what a respawned
    // orchestrator reads back.
    expect(registryFiles(S1)).toHaveLength(1);
    const onDisk = JSON.parse(readFileSync(registryFile(S1), "utf8")) as {
      unresolved: number[];
    };
    expect(onDisk.unresolved).toEqual([1]);

    // Process 2 (a fresh backend instance — no in-memory state) resumes S1.
    hoisted.queue.reset();
    const second = await startBackend({ resume: S1 });
    hoisted.queue.push(init(S1));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    // The resumed session's own turn completes normally…
    hoisted.queue.push(assistantMsg(S1, "back again"));
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(second.events)).toHaveLength(1));
    expect(resultsOf(second.events)[0]).toMatchObject({ ok: true });
    // …then the pre-restart turn's result lands LATE: traceless in the live
    // FIFO, but RECOGNIZED via the durable record — "completed but
    // unverified", still ok:false (fail-closed is untouched).
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await second.done;
    const errors = errorsOf(second.events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/completing late/i);
    expect(errors[0].message).toMatch(/NOT counting it as a success/i);
    expect(errors[0].message).not.toMatch(/could not be matched/i);
    expect(errors[0].unverifiedCompletion).toBe(true);
    expect(resultsOf(second.events)[1]).toMatchObject({ ok: false });
    expect(resultsOf(second.events)[1].turn).toBeUndefined(); // unmarked — never gate-attributed
    // Recognition consumed the record: a fresh load of the session's registry
    // finds NOTHING outstanding (the dead instance's file lingers until GC,
    // but its tag is tombstoned — the record is spent either way).
    const { loadTurnRegistry } = await import("../../orchestrator/turn-registry.js");
    expect(loadTurnRegistry(S1).tags).toHaveLength(0);
  });

  it("in-memory carry across a run() restart on the SAME instance; a spent record cannot be re-claimed by a second stray", async () => {
    const S2 = "22222222-2222-2222-2222-222222222222";
    const S3 = "33333333-3333-3333-3333-333333333333";
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    // Session 1: turn in flight, no result, session dies.
    const events1: AgentEvent[] = [];
    const done1 = (async () => {
      for await (const ev of backend.run({ channel: oneTurn() as never })) events1.push(ev);
    })();
    hoisted.queue.push(init(S2));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.end();
    await done1;
    // Session 2 (no resume — recognition here is the in-memory carry; a NEW
    // session id proves the disk record is not the source).
    hoisted.queue.reset();
    const events: AgentEvent[] = [];
    const done2 = (async () => {
      for await (const ev of backend.run({ channel: oneTurn() as never })) events.push(ev);
    })();
    hoisted.queue.push(init(S3));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.push(assistantMsg(S3, "new session turn"));
    hoisted.queue.push(RESULT_SUCCESS); // new session's own turn
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    expect(resultsOf(events)[0]).toMatchObject({ ok: true });
    // First stray: recognized as the dead session's submitted turn.
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(2));
    const firstStray = errorsOf(events);
    expect(firstStray).toHaveLength(1);
    expect(firstStray[0].unverifiedCompletion).toBe(true);
    expect(firstStray[0].message).toMatch(/completing late/i);
    // Second stray: the record was spent — this one matches NOTHING on record
    // and must say so (the honest negative is now well-founded).
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done2;
    const errors = errorsOf(events);
    expect(errors).toHaveLength(2);
    expect(errors[1].message).toMatch(/could not be matched to any submitted turn/i);
    expect(errors[1].unverifiedCompletion).toBeUndefined();
    expect(resultsOf(events)[2]).toMatchObject({ ok: false });
  });

  it("a traceless result with NO outstanding submission on record keeps the plain fail-closed report", async () => {
    const S4 = "44444444-4444-4444-4444-444444444444";
    const { events, done } = await startBackend();
    hoisted.queue.push(init(S4));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.push(assistantMsg(S4, "reply"));
    hoisted.queue.push(RESULT_SUCCESS); // resolves the only submitted turn…
    hoisted.queue.push(RESULT_SUCCESS); // …so this one matches nothing, anywhere
    hoisted.queue.end();
    await done;
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/could not be matched to any submitted turn/i);
    expect(errors[0].unverifiedCompletion).toBeUndefined();
    expect(resultsOf(events)[1]).toMatchObject({ ok: false });
    // A fully-resolved session leaves NO registry file behind (absence IS the
    // clean state — a later resume must not read a stale record).
    expect(registryFiles(S4)).toHaveLength(0);
    // …but the resolved turn IS tombstoned ("outcome reported"), so a carried
    // replica of its record in another instance's file can never be revived as
    // an outstanding turn.
    const tomb = JSON.parse(
      readFileSync(join(registryDir, `turn-registry-${S4}-tombstones.json`), "utf8"),
    ) as { spent: string[] };
    expect(tomb.spent).toHaveLength(1);
    expect(tomb.spent[0]).toMatch(/:1$/);
  });

  it("a corrupt registry degrades recognition and SAYS it can't rule an outstanding turn out", async () => {
    const S5 = "55555555-5555-5555-5555-555555555555";
    writeFileSync(join(registryDir, `turn-registry-${S5}-deadbeef.json`), "{ not json", "utf8");
    const { events, done } = await startBackend({ resume: S5 });
    hoisted.queue.push(init(S5));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.push(assistantMsg(S5, "reply"));
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.push(RESULT_SUCCESS); // traceless stray
    hoisted.queue.end();
    await done;
    const errors = errorsOf(events);
    expect(errors).toHaveLength(1);
    // Neither the confident negative NOR the recognized wording: the record
    // itself is unreadable, so the report must hedge.
    expect(errors[0].message).toMatch(/could not be matched to any submitted turn/i);
    expect(errors[0].message).toMatch(/can't be ruled out/i);
    expect(errors[0].unverifiedCompletion).toBeUndefined();
    expect(resultsOf(events)[1]).toMatchObject({ ok: false });
  });

  it("two sequential processes each leaving turn 1 outstanding are TWO records — both late results recognized", async () => {
    const S6 = "66666666-6666-6666-6666-666666666666";
    // Process A: submits its turn 1, dies without a result.
    const a = await startBackend();
    hoisted.queue.push(init(S6));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.end();
    await a.done;
    // Process B (fresh instance): resumes S6, submits ITS turn 1, also dies
    // without a result. turnSeq restarted — both turns are locally "1".
    hoisted.queue.reset();
    const b = await startBackend({ resume: S6 });
    hoisted.queue.push(init(S6));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.end();
    await b.done;
    // Process C: resumes S6. Two turns are outstanding from two different
    // owners — owner-tagging must keep them distinct.
    hoisted.queue.reset();
    const c = await startBackend({ resume: S6 });
    hoisted.queue.push(init(S6));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(3));
    hoisted.queue.push(assistantMsg(S6, "C's own turn"));
    hoisted.queue.push(RESULT_SUCCESS); // C's turn resolves
    await waitFor(() => expect(resultsOf(c.events)).toHaveLength(1));
    // Two late landings from the two dead processes: BOTH must be recognized.
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await c.done;
    const errors = errorsOf(c.events);
    expect(errors).toHaveLength(2);
    expect(errors[0].unverifiedCompletion).toBe(true);
    expect(errors[1].unverifiedCompletion).toBe(true);
    expect(errors[1].message).toMatch(/completing late/i);
    expect(resultsOf(c.events).every((r, i) => i === 0 || r.ok === false)).toBe(true);
  });

  it("a same-instance restart re-reading its OWN registry file does not double-count the carry", async () => {
    const S8 = "88888888-8888-8888-8888-8888888888";
    const { ClaudeBackend } = await import("../../orchestrator/claude-backend.js");
    const backend = new ClaudeBackend({ mcpServers: {}, systemAppend: "" });
    // Run 1: turn in flight, no result, session dies — the run() entry carry
    // remembers it in memory AND the last save has it on disk (same owner).
    const events1: AgentEvent[] = [];
    const done1 = (async () => {
      for await (const ev of backend.run({ channel: oneTurn() as never })) events1.push(ev);
    })();
    hoisted.queue.push(init(S8));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.end();
    await done1;
    expect(registryFiles(S8)).toHaveLength(1);
    // Run 2 (SAME instance resuming S8 — the self-restart loop's shape): the
    // disk record is this instance's own; hydrating it on top of the in-memory
    // carry would count the one dead turn TWICE.
    hoisted.queue.reset();
    const events: AgentEvent[] = [];
    const done2 = (async () => {
      for await (const ev of backend.run({ channel: oneTurn() as never, resume: S8 })) events.push(ev);
    })();
    hoisted.queue.push(init(S8));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    hoisted.queue.push(assistantMsg(S8, "resumed turn"));
    hoisted.queue.push(RESULT_SUCCESS); // the resumed turn resolves
    await waitFor(() => expect(resultsOf(events)).toHaveLength(1));
    // One late landing from the dead run: recognized…
    hoisted.queue.push(RESULT_SUCCESS);
    await waitFor(() => expect(resultsOf(events)).toHaveLength(2));
    expect(errorsOf(events)[0]?.unverifiedCompletion).toBe(true);
    // …and a second stray must find NOTHING left — a phantom record would
    // falsely recognize it too.
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await done2;
    const errors = errorsOf(events);
    expect(errors).toHaveLength(2);
    expect(errors[1].message).toMatch(/could not be matched to any submitted turn/i);
    expect(errors[1].unverifiedCompletion).toBeUndefined();
  });

  it("an interrupt landing for the CURRENT turn pops its own trace — it never spends a remembered dead-turn record", async () => {
    const S7 = "77777777-7777-7777-7777-777777777777";
    // Process A leaves one turn outstanding; process B resumes.
    const a = await startBackend();
    hoisted.queue.push(init(S7));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(1));
    hoisted.queue.end();
    await a.done;
    hoisted.queue.reset();
    const b = await startBackend({ resume: S7 });
    hoisted.queue.push(init(S7));
    await waitFor(() => expect(hoisted.promptsSeen).toBe(2));
    // B's turn is interrupted: its error_during_execution landing is the
    // interrupt landing for B's OWN trace — blessed ok:true, NO "completed but
    // unverified" disclosure, and the remembered record is NOT consumed.
    await b.backend.interrupt();
    hoisted.queue.push({ type: "result", subtype: "error_during_execution" });
    await waitFor(() => expect(resultsOf(b.events)).toHaveLength(1));
    expect(resultsOf(b.events)[0]).toMatchObject({ ok: true });
    expect(errorsOf(b.events)).toHaveLength(0);
    // Proof the record survived: a genuine stray is still recognized.
    hoisted.queue.push(RESULT_SUCCESS);
    hoisted.queue.end();
    await b.done;
    const errors = errorsOf(b.events);
    expect(errors).toHaveLength(1);
    expect(errors[0].unverifiedCompletion).toBe(true);
  });
});

describe("turn-registry module (per-instance files + tombstones)", () => {
  it("persists the incomplete bit so a respawn hedges instead of asserting the confident negative", async () => {
    const { saveTurnRegistry, loadTurnRegistry } = await import("../../orchestrator/turn-registry.js");
    const S9 = "99999999-9999-9999-9999-999999999999";
    saveTurnRegistry(S9, "owner-a", [], ["owner-a:3"], true);
    const loaded = loadTurnRegistry(S9);
    expect(loaded.kind).toBe("ok");
    expect(loaded.incomplete).toBe(true);
    expect(loaded.tags).toEqual(["owner-a:3"]);
  });

  it("two live instances on one session never erase each other's records (no shared writer)", async () => {
    const { saveTurnRegistry, loadTurnRegistry } = await import("../../orchestrator/turn-registry.js");
    const SA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    saveTurnRegistry(SA, "owner-a", [1], [], false);
    saveTurnRegistry(SA, "owner-b", [1], [], false); // B's own file — A's record must survive
    let loaded = loadTurnRegistry(SA);
    expect(loaded.kind).toBe("ok");
    expect(loaded.tags.sort()).toEqual(["owner-a:1", "owner-b:1"]);
    // A resolves its turn: only A's file is rewritten — B's record survives.
    saveTurnRegistry(SA, "owner-a", [], [], false);
    loaded = loadTurnRegistry(SA);
    expect(loaded.tags).toEqual(["owner-b:1"]);
  });

  it("a tombstoned tag stays spent even though the dead owner's file still lists it", async () => {
    const { saveTurnRegistry, loadTurnRegistry, tombstoneTurn } = await import(
      "../../orchestrator/turn-registry.js"
    );
    const SB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    saveTurnRegistry(SB, "owner-a", [1], [], false);
    tombstoneTurn(SB, "owner-a:1");
    expect(loadTurnRegistry(SB).tags).toEqual([]);
  });

  it("a resolved turn's tombstone invalidates a concurrent resumer's carried replica of the same record", async () => {
    const { saveTurnRegistry, loadTurnRegistry, tombstoneTurn } = await import(
      "../../orchestrator/turn-registry.js"
    );
    const SC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    saveTurnRegistry(SC, "owner-a", [1], [], false); // A live with turn 1 outstanding
    const asB = loadTurnRegistry(SC); // B resumes while A is still live
    expect(asB.tags).toEqual(["owner-a:1"]);
    saveTurnRegistry(SC, "owner-b", [], asB.tags, false); // B's file carries the replica
    // A's turn resolves NORMALLY: A's own file empties, and the pop tombstones
    // the tag — the only thing that can invalidate B's carried replica.
    saveTurnRegistry(SC, "owner-a", [], [], false);
    tombstoneTurn(SC, "owner-a:1");
    expect(loadTurnRegistry(SC).tags).toEqual([]);
  });

  it("an unreadable registry DIRECTORY degrades — only ENOENT proves absence", async () => {
    const { loadTurnRegistry } = await import("../../orchestrator/turn-registry.js");
    const blocker = join(registryDir, "not-a-directory");
    writeFileSync(blocker, "x", "utf8");
    const saved = process.env.COMFYUI_MCP_TURN_REGISTRY_DIR;
    process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = blocker;
    try {
      const loaded = loadTurnRegistry("dddddddd-dddd-dddd-dddd-dddddddddddd");
      expect(loaded.kind).toBe("degraded");
      expect(loaded.tags).toEqual([]);
    } finally {
      process.env.COMFYUI_MCP_TURN_REGISTRY_DIR = saved;
    }
  });
});

describe("panel rendering of a completed-but-unverified disclosure (#886)", () => {
  /** A stub backend that emits the given error + result for the one turn. */
  function stubBackend(error: AgentEvent & { type: "error" }): AgentBackend {
    return {
      id: "claude",
      capabilities: CLAUDE_CAPABILITIES,
      async *run(opts: BackendStartOptions) {
        yield { type: "session", sessionId: "render-stub-session" };
        for await (const _ of opts.channel) {
          void _;
          yield error;
          yield { type: "result", ok: false, subtype: "success" };
        }
      },
      async interrupt() {},
      async listModels(): Promise<ModelChoice[]> {
        return [];
      },
    };
  }

  async function renderOnce(error: AgentEvent & { type: "error" }): Promise<string[]> {
    const { PanelAgent } = await import("../../orchestrator/panel-agent.js");
    const says: string[] = [];
    const agent = new PanelAgent(
      "tab-render-unverified",
      {
        mcpServers: {},
        systemAppend: "",
        model: "claude-test",
        onSay: (_tab: string, text: string) => {
          says.push(text);
        },
      } as never,
      stubBackend(error),
    );
    void agent.start();
    agent.send("do the thing");
    await waitFor(() => expect(says.length).toBeGreaterThanOrEqual(1));
    await agent.stop();
    return says;
  }

  it("a flagged disclosure renders as itself — never as a turn failure with a retry invitation", async () => {
    const says = await renderOnce({
      type: "error",
      message:
        'A result (reported as "success") arrived that matches no live turn, but a turn submitted ' +
        "before the session restarted never reported an outcome — this is most likely that turn " +
        "completing late. It may have finished real work, so I am NOT counting it as a success.",
      unverifiedCompletion: true,
    });
    expect(says).toHaveLength(1);
    expect(says[0]).toMatch(/^⚠️ A result \(reported as "success"\)/);
    expect(says[0]).not.toMatch(/turn failed/i);
    expect(says[0]).not.toMatch(/Nothing was lost/i);
    expect(says[0]).not.toMatch(/try again/i);
  });

  it("an UNFLAGGED backend error keeps the standard turn-failure frame (control)", async () => {
    const says = await renderOnce({ type: "error", message: "boom" });
    expect(says).toHaveLength(1);
    expect(says[0]).toMatch(/turn failed: boom/i);
    expect(says[0]).toMatch(/Nothing was lost/i);
  });
});
