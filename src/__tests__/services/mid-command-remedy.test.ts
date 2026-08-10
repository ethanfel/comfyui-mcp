// #952 (panel) — an interactive question card was told to go and check the
// render queue.
//
// `panel_ask` was interrupted by a tab disconnect and the OUTCOME UNKNOWN error
// ended with the only remedy this path had: check `queue action:"list"` /
// `get_image (action:"list_outputs")`. Neither can observe whether a question is
// on a human's screen. The reporter said so plainly, and they were right.
//
// The panel-side trace on that issue supplies the fact that makes this more than
// wording: for THIS trigger a blind retry really does duplicate the card. The
// dedupe ledger is keyed by the socket's bridge epoch; a reconnect mints a new
// one; the retry lands in a different scope, `lookupRetry` misses, and it fails
// open and re-executes. Failing open is correct for a read or an idempotent
// write. For a question it means a second card in front of a person, and there
// is no way to withdraw the first.

import { describe, expect, it } from "vitest";

import {
  isInteractiveCommand,
  midCommandDisconnectMessage,
  midCommandVerifyClause,
} from "../../services/mid-command-remedy.js";

const ASK = { short: "wf:728f6", cmd: "ask_user" };
const RUN = { short: "wf:728f6", cmd: "graph_run" };

describe("the disconnect remedy fits what was interrupted (#952)", () => {
  it("an ask card is NOT sent to the render queue — the reporter's complaint", () => {
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).not.toMatch(/queue action:"list"/);
    expect(msg).not.toMatch(/list_outputs/);
  });

  it("…and says the thing that is actually true of it", () => {
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/card may already be on screen/);
    // The fact from the panel trace: a retry is not merely unverifiable, it
    // duplicates after a reconnect because suppression is keyed to the dead
    // socket. Stated as the consequence the user sees.
    expect(msg).toMatch(/retry\s+suppression is keyed to the socket that dropped/);
    expect(msg).toMatch(/user may see two/);
  });

  it("does NOT promise the answer will arrive — it will not (codex)", () => {
    // An earlier draft said "if the user answers the card already up, the answer
    // still arrives". Checked against the panel: `redactSensitiveReply` replaces
    // an ask_user/request_secret reply that cannot cross the dropped connection
    // with a payload-free failure, deliberately, and tells the caller to ask
    // again on the current connection. Waiting is not a recovery, and advising it
    // would have parked the agent forever.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/will NOT reach you/);
    expect(msg).not.toMatch(/Prefer to wait/);
    expect(msg).not.toMatch(/still arrives/);
  });

  it("names a route that works, since it forbids the obvious move", () => {
    // A refusal with no alternative is how an agent ends up retrying anyway.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/Re-issue the question on the current connection/);
    expect(msg).toMatch(/ask it in conversation/);
    // …and warns about the consequence the panel trace established.
    expect(msg).toMatch(/user may see two/);
  });

  it("a SECRET is never routed through the conversation (codex)", () => {
    // The card exists so the value reaches the panel through a masked input,
    // unseen by the agent and unrecorded in chat. "Just ask them for it" would
    // defeat exactly that, and this message is read by an agent that will act
    // on it.
    const msg = midCommandDisconnectMessage({ short: "wf:1", cmd: "request_secret" });
    expect(msg).toMatch(/Re-issue panel_request_secret on the current connection/);
    expect(msg).toMatch(/never ask the user to paste a secret into the conversation/);
    expect(msg).not.toMatch(/ask it in conversation/);
  });

  it("does NOT invent a recovery that does not exist", () => {
    // There is no pending-card query, and `retry_of` does not survive the
    // reconnect this message is about. Both are open design questions on the
    // issue; promising either would send the caller to something that fails.
    const msg = midCommandDisconnectMessage(ASK);
    expect(msg).toMatch(/there is no pending-card query/);
    expect(msg).not.toMatch(/retry_of/);
  });

  it("request_secret is interactive too — same human, same duplicate", () => {
    expect(isInteractiveCommand("request_secret")).toBe(true);
    expect(midCommandDisconnectMessage({ short: "wf:1", cmd: "request_secret" })).toMatch(
      /card may already be on screen/,
    );
    // …and says it ONCE. The lead sentence and the clause both used to open with
    // it, which read as though two separate facts were being reported.
    const msg = midCommandDisconnectMessage({ short: "wf:1", cmd: "request_secret" });
    expect(msg.match(/may already be (on screen|SHOWING)/g)?.length).toBe(1);
  });

  it("the two interactive commands differ ONLY in the route they are given", () => {
    // Same facts, different safe action. If these ever collapse to one string,
    // one of them is being given the other's advice.
    const ask = midCommandDisconnectMessage(ASK);
    const secret = midCommandDisconnectMessage({ short: ASK.short, cmd: "request_secret" });
    expect(ask).not.toBe(secret);
    for (const m of [ask, secret]) {
      expect(m).toMatch(/will NOT reach you/);
      expect(m).toMatch(/user may see two/);
    }
  });

  it("every OTHER command keeps the queue/output check — it is real evidence there", () => {
    const msg = midCommandDisconnectMessage(RUN);
    expect(msg).toMatch(/queue action:"list"/);
    expect(msg).toMatch(/list_outputs/);
    expect(msg).toMatch(/ComfyUI may already be rendering/);
    expect(msg).not.toMatch(/card may already be on screen/);
  });

  it("still reports OUTCOME UNKNOWN and the tab, whichever branch it takes", () => {
    // The parts callers and the existing detectors key on must not move: several
    // call sites match /disconnected mid-command|OUTCOME UNKNOWN/.
    for (const ctx of [ASK, RUN]) {
      const msg = midCommandDisconnectMessage(ctx);
      expect(msg, ctx.cmd).toMatch(/disconnected mid-command \("/);
      expect(msg).toMatch(/OUTCOME UNKNOWN/);
      expect(msg).toContain(ctx.short);
      expect(msg).toContain(ctx.cmd);
    }
  });

  it("an unknown or malformed command is treated as NON-interactive", () => {
    // Fail toward the existing behaviour: the queue/output advice is merely
    // unhelpful for something else, while claiming "a card may be on screen"
    // about a write would be false.
    for (const cmd of ["", "   ", "graph_add_node", "ask_user_extra"]) {
      expect(isInteractiveCommand(cmd), cmd).toBe(false);
    }
    expect(midCommandVerifyClause("graph_add_node")).toMatch(/queue action:"list"/);
  });
});

describe("WIRING: the bridge uses it (#952)", () => {
  it("the mid-command disconnect path builds its message here", async () => {
    // The helper is worthless if the bridge keeps its own hardcoded string, and
    // the branch is inside a long method that no unit test constructs.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../services/ui-bridge.ts", import.meta.url), "utf-8");
    expect(src).toContain('import { midCommandDisconnectMessage } from "./mid-command-remedy.js"');
    expect(src).toContain("midCommandDisconnectMessage({ short, cmd })");
    // …and the old hardcoded remedy is gone from the mutating branch.
    expect(src).not.toMatch(
      /OUTCOME UNKNOWN: the command was already sent, so the panel may have applied it/,
    );
  });
});
