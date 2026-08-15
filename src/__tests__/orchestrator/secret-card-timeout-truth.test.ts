// #1352 — a secret card that times out was reported as a possibly-frozen tab.
//
// `panel_request_secret` blocks up to 300s on a MASKED INPUT, and its catch relayed the
// bridge's generic no-reply message:
//
//   Panel tab … did not reply to "request_secret" within 300000 ms — the ComfyUI tab
//   may be backgrounded or frozen
//
// For every other command that is the right sentence. Here it accuses the tab of a
// fault it almost certainly does not have: the likely cause is that a human is still
// typing, having gone to a password manager or a billing console for the token. Same
// defect as #1332 — a mechanical outcome narrated as somebody's decision or a fault.
//
// AND IT HAS TO SAY WHAT HAPPENS TO A LATE VALUE, because that is the question the
// caller will have. MEASURED, not assumed: this card is sent as a raw `request_secret`
// command with NO ask_id, and the late-reply buffer (takeLateAskReply) is keyed BY ask
// id — so a value typed after the timeout has no route back to this call. Saying "it
// may still arrive" would leave the user waiting for a save that cannot happen.
//
// THE 300s BUDGET IS NOT TOUCHED. PANEL_TOOL_MCP_TIMEOUT_MS (315s) is sized above this
// card so an internal MCP client does not kill the request first (#325); moving one
// means moving the other, which is the design decision #1352 is really asking for.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  __panelAskTestHooks,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";

/** The bridge's real no-reply wording, which is what used to reach the caller. */
const REPLY_TIMEOUT = () =>
  new Error(
    `Panel tab ${TAB} did not reply to "request_secret" within 300000 ms — the ComfyUI tab ` +
      `may be backgrounded or frozen`,
  );

/** What the tool actually put on the wire, so the ask_id can be asserted rather than
 *  assumed — a double that ignores the command cannot tell whether one was sent. */
const sentCommands: Record<string, unknown>[] = [];

function bridge(fail: Error, lateAnswer?: { value: unknown }) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sentCommands.push(cmd);
      throw fail;
    },
    // #1352 — the grace poll asks the bridge for a late answer keyed by ask id. Supplying
    // one here is what distinguishes "nobody typed it" from "they typed it a moment late",
    // which are the two outcomes this tool now has to tell apart.
    takeLateAskReply: () => {
      if (!lateAnswer) return undefined;
      const v = lateAnswer.value;
      lateAnswer.value = undefined; // claimed once, like the real buffer
      return v;
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function requestSecret(fail: Error, lateAnswer?: { value: unknown }): Promise<string> {
  const ctx = makePanelToolCtx(bridge(fail, lateAnswer), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_request_secret");
  if (!def) throw new Error("panel_request_secret is not registered");
  const res: ToolResult = await def.handler(
    { mcp_server: "comfyui", label: "CivitAI token", key: "CIVITAI_API_TOKEN" } as never,
    ctx,
  );
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

describe("a timed-out secret card is described honestly (#1352)", () => {
  // #1352 gave this card the ask path's deadline + GRACE, and the grace is a real wait:
  // on a genuine no-answer the handler now polls for it before reporting. At the shipped
  // 240s + 45s that is far past any test budget, so drive it at millisecond scale — the
  // behaviour under test is the ORDER of events, not the size of the numbers.
  beforeEach(() => {
    sentCommands.length = 0;
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 20, pollMs: 2 });
  });
  afterEach(() => {
    __panelAskTestHooks.setAskTiming(null);
  });

  it("does not accuse the tab of being frozen, or the user of declining", async () => {
    const text = await requestSecret(REPLY_TIMEOUT());

    expect(text).not.toMatch(/backgrounded or frozen/);
    expect(text).toMatch(/does NOT mean the tab is frozen/);
    expect(text).toMatch(/does NOT mean the user declined/);
    // The likely truth, stated as likely.
    expect(text).toMatch(/very likely just time/);
  });

  it("states the outcome that matters: nothing was saved", async () => {
    const text = await requestSecret(REPLY_TIMEOUT());
    expect(text).toMatch(/NOTHING was saved/);
    expect(text).toMatch(/no credential was read/);
  });

  it("says the DEADLINE AND THE GRACE both elapsed — the claim that is true now", async () => {
    // This test used to assert that a late value is discarded, which was measured and
    // correct: the card carried no ask_id, so the id-keyed buffer could not match it.
    // #1352 gave it one and a grace poll, so reaching this message means BOTH windows
    // closed. The old sentence would now send someone away from a save that works.
    const text = await requestSecret(REPLY_TIMEOUT());

    expect(text).toMatch(/deadline AND the/);
    expect(text).toMatch(/grace/);
    expect(text).toMatch(/no path back to this call/);
    expect(text).toMatch(/call panel_request_secret again/);
    // …and it must not resurrect the retired claim.
    expect(text).not.toMatch(/discarded rather than saved/);
  });

  it("APPLIES a value that arrives during the grace, and says it was late", async () => {
    // The point of the change. The card deadline fires, the human is still typing, and the
    // answer lands a moment later — it is applied rather than thrown away.
    //
    // The value is deliberately one the tool will refuse to persist (whitespace), so this
    // test exercises the RECOVERY without writing a credential anywhere: what is asserted
    // is that the late answer reached the handler at all, which "No token entered" proves
    // and a timeout message would disprove.
    const text = await requestSecret(REPLY_TIMEOUT(), { value: "   " });

    expect(text).toMatch(/No token entered/);
    expect(text).not.toMatch(/no path back to this call/);
  });

  it("SENDS an ask_id, which is the only thing that makes a late answer recoverable", async () => {
    // The bridge buffers a late reply only for a command that carried an ask_id
    // (ui-bridge.ts, the askRidToId registration). Without one the grace poll above can
    // never find anything — and a test double that answers regardless would not notice,
    // which is exactly what mutation testing caught here.
    await requestSecret(REPLY_TIMEOUT());

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0].cmd).toBe("request_secret");
    expect(typeof sentCommands[0].ask_id).toBe("string");
    expect(String(sentCommands[0].ask_id).length).toBeGreaterThan(8);
  });

  it("a LATE arrival is announced as an arrival, never as a save", async () => {
    // The note prefixes EVERY outcome, failures included. A token that lands during the
    // grace and then fails to persist would otherwise be announced as applied by the very
    // message explaining that it was not — so the note states only WHEN it arrived and
    // leaves what happened to the rest of the result.
    const text = await requestSecret(REPLY_TIMEOUT(), { value: "   " });
    expect(text).toMatch(/arrived AFTER the/);
    expect(text).toMatch(/grace period/);
    expect(text).not.toMatch(/was still applied/);
    // …and this particular late value was NOT saved, which the result still says plainly.
    expect(text).toMatch(/No token entered/);
  });

  it("stops polling early enough to still SAVE what it accepts (codex P1)", async () => {
    // The card wait plus the grace fill the whole ask budget, and the enclosing tools/call
    // is killed shortly after it — so a token accepted at the very END of the grace had
    // only the leftover framework margin in which to be written and read back. A slow
    // store would then lose a credential the user DID supply in time.
    //
    // The rule this encodes: an answer arriving too late to be persisted SAFELY is not
    // accepted at all. Better to tell someone their token did not land than to take it and
    // lose it — they believe they supplied it either way.
    //
    // Driven at millisecond scale, where the 10s reserve consumes the whole grace, so the
    // poll gets a single attempt. An answer that only shows up after that is therefore NOT
    // taken — and with the reserve removed it would be, which is what makes this a test of
    // the reserve rather than of the recovery.
    let calls = 0;
    const slowBuffer = {
      get value() {
        // Absent for the first few polls, then present — a user still typing.
        return ++calls > 3 ? "sk-late" : undefined;
      },
      set value(_v: unknown) {
        /* claimed-once semantics are irrelevant here */
      },
    };
    __panelAskTestHooks.setAskTiming({ deadlineMs: 5, graceMs: 200, pollMs: 2 });
    const text = await requestSecret(REPLY_TIMEOUT(), slowBuffer as { value: unknown });

    // Not recovered: the reserve ended the poll before that answer appeared.
    expect(text).toMatch(/no path back to this call/);
    expect(text).not.toMatch(/arrived AFTER the/);
  });

  it("keeps the masked-input rule — never route a secret through the conversation", async () => {
    // #952's finding: suggesting the conversational route defeats the entire purpose of
    // this tool. A recovery path is exactly where that would slip back in.
    const text = await requestSecret(REPLY_TIMEOUT());
    expect(text).toMatch(/never be typed into the conversation/);
  });

  it("a NON-timeout failure keeps its own words", async () => {
    // The scope of this rewrite is one cause. A transport drop or a refusal must not be
    // narrated as "someone is still typing".
    const text = await requestSecret(new Error("Panel tab is not open"));

    expect(text).toMatch(/Panel tab is not open/);
    expect(text).not.toMatch(/very likely just time/);
    expect(text).not.toMatch(/no path back to this call/);
  });
});
