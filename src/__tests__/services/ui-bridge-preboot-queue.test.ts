// #1411 — A MESSAGE SENT BEFORE THE ORCHESTRATOR FINISHES STARTING IS NOT GONE.
//
// The bridge binds its port and accepts frames several seconds before the
// orchestrator installs `onPanelMessage` (measured: listening at T+0.0s, ready at
// T+3.7s). Every frame in that window used to be accepted, stamped, echoed into
// the panel transcript, and then dropped by an optional-call on a null handler —
// no queue, no ack, no error. The user watches their own message appear and
// nothing happen, which reads as the agent ignoring them.
//
// A real panel reaches this window whenever the orchestrator restarts with the
// sidebar open: a self-restart on rebuild, a crash restart, a machine waking.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer } from "node:net";
import { UiBridge } from "../../services/ui-bridge.js";
import type { PanelEvent } from "../../services/ui-bridge.js";

let bridge: UiBridge;

beforeEach(() => {
  bridge = new UiBridge(0); // no listen() — this is about the handler, not the port
});

afterEach(() => {
  bridge.onPanelMessage = null;
});

/** The private dispatch the socket handlers call. Reached directly so the test is
 *  about the queue rather than about WebSocket timing. */
function deliver(ev: PanelEvent): void {
  (bridge as unknown as { deliverPanelEvent: (e: PanelEvent) => void }).deliverPanelEvent(ev);
}

/** One turn of the event loop — where work produced DURING a drain is delivered. */
const tick = () => new Promise<void>((r) => setImmediate(() => r()));

const msg = (text: string): PanelEvent =>
  ({ type: "user_message", tab_id: "wf:a.json", text }) as unknown as PanelEvent;

describe("#1411 frames that arrive before the handler exists", () => {
  it("are DELIVERED once the handler is installed, not dropped", async () => {
    deliver(msg("the message the user typed during boot"));
    expect(bridge.preHandlerBacklog().held).toBe(1);

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => void seen.push((e as unknown as { text: string }).text);

    expect(seen).toEqual(["the message the user typed during boot"]);
    expect(bridge.preHandlerBacklog().held).toBe(0);
  });

  it("arrive in the order the panel SENT them — hello before message", async () => {
    // Reordering would hand the orchestrator a message for a tab it has not been
    // told about, which is a different bug than the one being fixed.
    deliver({ type: "hello", tab_id: "wf:a.json" } as unknown as PanelEvent);
    deliver(msg("first"));
    deliver(msg("second"));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const ev = e as unknown as { type: string; text?: string };
      seen.push(ev.type === "hello" ? "hello" : (ev.text ?? "?"));
    };

    expect(seen).toEqual(["hello", "first", "second"]);
  });

  it("are delivered ONCE — a second handler assignment does not replay them", async () => {
    deliver(msg("only once"));
    const first: string[] = [];
    bridge.onPanelMessage = (e) => void first.push((e as unknown as { text: string }).text);
    const second: string[] = [];
    bridge.onPanelMessage = (e) => void second.push((e as unknown as { text: string }).text);

    expect(first).toEqual(["only once"]);
    expect(second).toEqual([]); // the queue was emptied by the first assignment
  });

  it("do not queue at all once a handler exists — delivery stays synchronous", async () => {
    const seen: string[] = [];
    bridge.onPanelMessage = (e) => void seen.push((e as unknown as { text: string }).text);

    deliver(msg("live"));

    expect(seen).toEqual(["live"]);
    expect(bridge.preHandlerBacklog().held).toBe(0);
  });

  it("setting the handler to null does not drop what is already held", async () => {
    deliver(msg("held"));
    bridge.onPanelMessage = null; // the cleanup pattern used across the suite
    expect(bridge.preHandlerBacklog().held).toBe(1);

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => void seen.push((e as unknown as { text: string }).text);
    expect(seen).toEqual(["held"]);
  });

  it("one frame that THROWS does not strand the frames behind it", async () => {
    // The user's message must not be lost because an earlier hello blew up.
    deliver({ type: "hello", tab_id: "wf:a.json" } as unknown as PanelEvent);
    deliver(msg("must still arrive"));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const ev = e as unknown as { type: string; text?: string };
      if (ev.type === "hello") throw new Error("hello handler blew up");
      seen.push(ev.text ?? "?");
    };

    expect(seen).toEqual(["must still arrive"]);
  });
});

describe("#1411 frames that arrive DURING the drain (codex review, P1)", () => {
  it("land BEHIND what is still held, not in front of it", async () => {
    // Handling A can synchronously cause C to arrive — a hello handler that pushes,
    // a reply that loops back. Delivering C immediately would reorder A, B, C into
    // A, C, B, which is the ordering guarantee this queue exists to provide.
    deliver(msg("A"));
    deliver(msg("B"));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const text = (e as unknown as { text: string }).text;
      seen.push(text);
      if (text === "A") deliver(msg("C"));
    };

    // A and B were the pre-handler backlog, so they land synchronously. C was
    // produced BY the drain, so it is delivered on a later tick — bounded work per
    // pass (codex round 2), with the order preserved either way.
    expect(seen).toEqual(["A", "B"]);
    await tick();
    expect(seen).toEqual(["A", "B", "C"]);
    expect(bridge.preHandlerBacklog().held).toBe(0);
  });

  it("a handler that swaps ITSELF out mid-drain does not strand the next frame", async () => {
    // The nested assignment's own drain is suppressed by the re-entry guard, so the
    // outer loop has to be what finishes the job — otherwise the frame sits queued
    // indefinitely, which is the original bug with extra steps.
    deliver(msg("A"));

    const seen: string[] = [];
    const replacement = (e: unknown) =>
      void seen.push(`second:${(e as { text: string }).text}`);
    bridge.onPanelMessage = (e) => {
      const text = (e as unknown as { text: string }).text;
      seen.push(`first:${text}`);
      if (text === "A") {
        bridge.onPanelMessage = null;
        deliver(msg("B")); // held: there is no handler at this instant
        bridge.onPanelMessage = replacement as (ev: PanelEvent) => void;
      }
    };

    expect(seen).toEqual(["first:A"]);
    await tick(); // the replacement handler picks up what was queued mid-drain
    expect(seen).toEqual(["first:A", "second:B"]);
    expect(bridge.preHandlerBacklog().held).toBe(0);
  });
});

describe("#1411 a self-feeding handler cannot wedge the event loop", () => {
  it("does bounded work per pass, and still delivers everything in order", async () => {
    // codex round 2, P1: the drain loop can extend the queue it is draining, so an
    // unbounded loop lets a handler that emits one frame per frame it handles spin
    // forever — the assignment never returns and Node stops. The budget is the
    // backlog present when the pass started; the rest is rescheduled, never dropped.
    deliver(msg("seed"));

    const seen: string[] = [];
    let more = 5;
    bridge.onPanelMessage = (e) => {
      const text = (e as unknown as { text: string }).text;
      seen.push(text);
      if (more > 0) {
        more -= 1;
        deliver(msg(`echo${more}`));
      }
    };

    // The synchronous pass delivered only the pre-existing backlog and RETURNED.
    expect(seen).toEqual(["seed"]);
    for (let i = 0; i < 10 && bridge.preHandlerBacklog().held > 0; i++) await tick();

    expect(seen).toEqual(["seed", "echo4", "echo3", "echo2", "echo1", "echo0"]);
    expect(bridge.preHandlerBacklog().held).toBe(0);
  });
});

describe("#1411 nothing overtakes a frame that is still waiting (codex round 3)", () => {
  it("a live frame arriving BEFORE the continuation lands behind the queued one", async () => {
    // A,B are the backlog; handling A queues C, which the budget defers to the next
    // tick. A socket frame D arriving in that gap must NOT be delivered around C —
    // the panel sent C first, so A,B,D,C would be a reordering the queue exists to
    // prevent.
    deliver(msg("A"));
    deliver(msg("B"));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const text = (e as unknown as { text: string }).text;
      seen.push(text);
      if (text === "A") deliver(msg("C"));
    };
    expect(seen).toEqual(["A", "B"]); // pass over, C still queued

    deliver(msg("D")); // the socket keeps running while the continuation is pending
    expect(seen).toEqual(["A", "B"]); // …and D did not jump the queue

    for (let i = 0; i < 5 && bridge.preHandlerBacklog().held > 0; i++) await tick();
    expect(seen).toEqual(["A", "B", "C", "D"]);
  });

  it("a handler that calls stop() MID-DRAIN cannot leave a successor behind it", async () => {
    // codex round 4, P1: cancellation alone is not enough. When the handler calls
    // stop() while being drained, pendingDrain is still null at that moment, so
    // nothing is there to cancel — and the pass then scheduled its successor
    // afterwards, which ran after teardown.
    const port = await freePort();
    const live = new UiBridge(port);
    live.start();
    expect(await live.whenReady()).toBe(true);

    const raw = live as unknown as { deliverPanelEvent: (e: PanelEvent) => void };
    raw.deliverPanelEvent(msg("A"));

    const seen: string[] = [];
    live.onPanelMessage = (e) => {
      const text = (e as unknown as { text?: string }).text ?? "";
      seen.push(text);
      if (text === "A") {
        raw.deliverPanelEvent(msg("after-teardown")); // queued mid-drain
        void live.stop(); // …and the bridge goes down in the same breath
      }
    };

    // A frame that arrives after teardown has nowhere to go: it must not be held
    // (a leak) and must not be delivered later (a lie about a dead bridge).
    raw.deliverPanelEvent(msg("post-teardown"));
    expect(live.preHandlerBacklog().held).toBe(0);

    for (let i = 0; i < 5; i++) await tick();
    expect(seen).toEqual(["A"]);
  });

  it("stop() cancels a pending continuation instead of firing after teardown", async () => {
    const port = await freePort();
    const live = new UiBridge(port);
    live.start();
    expect(await live.whenReady()).toBe(true);

    const raw = live as unknown as { deliverPanelEvent: (e: PanelEvent) => void };
    // A must be BACKLOG, not a live delivery: only a drain pass can leave work for
    // a continuation, which is the thing being cancelled here.
    raw.deliverPanelEvent(msg("A"));

    const seen: string[] = [];
    live.onPanelMessage = (e) => {
      const text = (e as unknown as { text?: string }).text ?? "";
      seen.push(text);
      if (text === "A") raw.deliverPanelEvent(msg("after-stop")); // queued mid-drain
    };
    expect(seen).toEqual(["A"]);
    expect(live.preHandlerBacklog().held).toBe(1); // waiting on the continuation

    await live.stop();
    for (let i = 0; i < 5; i++) await tick();

    expect(seen).toEqual(["A"]); // the continuation was cancelled, not run after stop
  });
});

describe("#1411 the queue is BOUNDED, and says so", () => {
  it("refuses past the cap rather than growing without limit", async () => {
    // Nothing guarantees a handler is ever installed; an unbounded buffer would be
    // its own bug, quieter than the one being fixed.
    for (let i = 0; i < 250; i++) deliver(msg(`m${i}`));

    const { held, dropped } = bridge.preHandlerBacklog();
    expect(held).toBe(200);
    expect(dropped).toBe(50);
  });

  it("keeps the EARLIEST frames — the hello that identifies the tab is in them", async () => {
    deliver({ type: "hello", tab_id: "wf:a.json" } as unknown as PanelEvent);
    for (let i = 0; i < 250; i++) deliver(msg(`m${i}`));

    const seen: string[] = [];
    bridge.onPanelMessage = (e) => {
      const ev = e as unknown as { type: string; text?: string };
      seen.push(ev.type === "hello" ? "hello" : (ev.text ?? "?"));
    };

    expect(seen[0]).toBe("hello");
    expect(seen).toHaveLength(200);
    expect(seen).not.toContain("m199"); // refused, because the cap was already reached
  });

  it("is bounded by BYTES too — a frame count is not a resource bound", async () => {
    // codex review, P1: this is an INGRESS path that previously discarded, so
    // retaining 200 arbitrarily large frames would be new memory exposure.
    const big = "x".repeat(50_000);
    for (let i = 0; i < 40; i++) deliver(msg(big)); // ~2 MB offered, well under 200 frames

    const { held, dropped, bytes } = bridge.preHandlerBacklog();
    expect(held).toBeLessThan(200); // refused on BYTES, before the count cap
    expect(dropped).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(1_000_000);
  });

  it("gives the bytes back as frames are delivered", async () => {
    deliver(msg("x".repeat(1000)));
    expect(bridge.preHandlerBacklog().bytes).toBeGreaterThan(900);
    bridge.onPanelMessage = () => {};
    expect(bridge.preHandlerBacklog().bytes).toBe(0);
  });

  it("clears the refusal count once it has been reported", async () => {
    for (let i = 0; i < 210; i++) deliver(msg(`m${i}`));
    expect(bridge.preHandlerBacklog().dropped).toBe(10);

    bridge.onPanelMessage = () => {};
    expect(bridge.preHandlerBacklog().dropped).toBe(0);
  });
});

/** A free port, the way the sibling suite finds one. */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

describe("#1411 over a REAL socket — the wiring, not just the queue", () => {
  // The tests above reach deliverPanelEvent directly, so they would all still pass
  // if the socket handlers went back to `this.onPanelMessage?.(…)` and dropped
  // everything. This is the one that fails if they do.
  it("a user_message sent BEFORE the handler is installed still arrives", async () => {
    const port = await freePort();
    const live = new UiBridge(port);
    live.start();
    expect(await live.whenReady()).toBe(true);
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((r) => sock.on("open", () => r()));

      // Exactly the reported sequence: the panel connects and talks while the
      // orchestrator is still starting, so NO handler exists yet.
      sock.send(JSON.stringify({ type: "hello", tab_id: "wf:a.json", title: "a" }));
      sock.send(JSON.stringify({ type: "user_message", tab_id: "wf:a.json", text: "hello?" }));
      await new Promise((r) => setTimeout(r, 150));

      expect(live.preHandlerBacklog().held).toBeGreaterThan(0);

      // Boot finishes.
      const seen: Array<{ type: string; text?: string }> = [];
      live.onPanelMessage = (e) => void seen.push(e as unknown as { type: string; text?: string });

      const user = seen.find((e) => e.type === "user_message");
      expect(user, "the message the user typed during boot").toBeTruthy();
      expect(user!.text).toBe("hello?");
      // The hello matters as much: it is what tells the orchestrator this tab
      // exists, and a message delivered for a tab it was never told about is a
      // different bug. Its dispatch site is separate, so it needs its own
      // assertion — without this, reverting only that site passes everything.
      const hello = seen.find((e) => e.type === "hello");
      expect(hello, "the hello that identifies the tab").toBeTruthy();
      expect(seen.indexOf(hello!)).toBeLessThan(seen.indexOf(user!));
      sock.close();
    } finally {
      live.onPanelMessage = null;
      await live.stop?.();
    }
  });
});
