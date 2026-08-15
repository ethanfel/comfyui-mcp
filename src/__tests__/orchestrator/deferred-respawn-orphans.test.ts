// #1567 — a QUEUED tool-session respawn kills in-flight downloads, and the at-risk check
// that exists for exactly that (#1378) cannot see them.
//
// The save-time snapshot is taken before the emit, which is right for an APPLIED respawn:
// the emit IS the damage. For a SCHEDULED one the damage is `applyPendingRestarts`,
// arbitrarily many turns later. A reporter saved a token with nothing in flight (so the
// check correctly warned about nothing), started nine downloads (~48GB) over the next two
// turns, and lost all of them when the queued respawn landed — no warning at any point,
// then nine manual cancels and nine manual re-issues to recover.
//
// So the snapshot is re-taken AT THE RESPAWN. These pin both halves: the note itself, and
// that a genuinely deferred respawn actually reaches it — a helper nothing calls would
// leave the defect exactly where it was.
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

/** The downloads the respawn is about to orphan. Mocked at the MODULE boundary
 *  panel-agent imports across — `listDownloadJobs` is called from inside
 *  download-jobs.js, so mocking that would replace an export nobody reads. */
const atRisk = vi.hoisted(() => ({ jobs: [] as { id: string; filename: string; bytes: number }[] }));
vi.mock("../../services/download-jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/download-jobs.js")>();
  return { ...actual, downloadsAtRiskOfRespawn: () => atRisk.jobs };
});

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
let orphanedByDeferredRespawnNote: typeof import("../../services/panel-secrets.js").orphanedByDeferredRespawnNote;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
  ({ orphanedByDeferredRespawnNote } = await import("../../services/panel-secrets.js"));
});

class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  turnTexts: string[] = [];
  /** Which run() (i.e. which agent, i.e. which tab) each turn arrived on. Needed to tell
   *  "the right tab got the note" from "some tab did" — without it, a watch that leaks to
   *  whichever tab restarts first looks identical to a correctly scoped one. */
  turns: { run: number; text: string }[] = [];
  autoComplete = true;
  // A LIST, not a single slot: the multi-tab test holds two turns open at once, and one
  // field means the first tab's resolver is overwritten and never settles — the whole
  // test then times out on a harness bug rather than a finding.
  private held: (() => void)[] = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    const myRun = this.runCount;
    yield { type: "session", sessionId: "sess-x" };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
      this.turns.push({ run: myRun, text: turn.text });
      if (!this.autoComplete) {
        await new Promise<void>((resolve) => {
          this.held.push(resolve);
        });
      }
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  /** Release every held turn. */
  release(): void {
    const all = this.held;
    this.held = [];
    for (const r of all) r();
  }

  async interrupt(): Promise<void> {
    this.release();
  }

  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** Same construction as restart-coalesce.test.ts — the backend arrives via
 *  `makeBackend`, not as a `backend` field. */
const makeManager = (backend: AgentBackend) =>
  new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: () => {},
    onTurn: () => {},
    makeBackend: () => backend,
  } as never);

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("orphanedByDeferredRespawnNote (#1567)", () => {
  it("says nothing when nothing is in flight", () => {
    expect(orphanedByDeferredRespawnNote([])).toBeNull();
  });

  it("names the transfers and points at the partials", () => {
    const note = orphanedByDeferredRespawnNote([
      { id: "a", filename: "flux-dev.safetensors", bytes: 4_000_000_000 },
    ]);
    expect(note).toContain("flux-dev.safetensors");
    expect(note).toMatch(/partial/i);
    expect(note).toMatch(/re-issu/i);
  });

  it("does NOT repeat the from-zero prediction as a certainty", () => {
    // The reporter disproved it for this case: their downloads started AFTER the save, so
    // cache identity never moved and re-issuing resumed at 4%/1%/2%. ~11GB was recoverable.
    // `atRiskNote`'s "will NOT resume … starts from 0%" is right only when the credential
    // changes MID-transfer, which is not knowable from here — so neither outcome is claimed.
    const note = orphanedByDeferredRespawnNote([
      { id: "a", filename: "m.safetensors", bytes: 1 },
    ]) as string;
    expect(note).toMatch(/resume/i);
    expect(note).not.toMatch(/will NOT resume/i);
    // It must still admit the other case rather than promising a resume.
    expect(note).toMatch(/0%|restarts from/i);
  });
});

describe("a DEFERRED respawn reaches the note (#1567)", () => {
  it("tells the resumed session what it just killed", async () => {
    atRisk.jobs = [
      { id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 },
      { id: "j2", filename: "wan22.safetensors", bytes: 13_550_000_000 },
    ];
    const backend = new RecordingBackend();
    backend.autoComplete = false; // hold the first turn open → the tab is BUSY
    const manager = makeManager(backend);
    const tab = "tab-1567";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);

    // BUSY, so this respawn is genuinely DEFERRED — the path whose damage the save-time
    // snapshot cannot see. It reports "scheduled", not "applied".
    const tally = manager.restartAllForMcpEnvAfterCredentialChange(tab);
    expect(tally.scheduled, "the respawn must be queued, not applied").toBe(1);
    expect(tally.applied).toBe(0);

    backend.autoComplete = true;
    backend.release(); // turn done → the queued respawn fires HERE

    await waitFor(() => backend.runCount >= 2);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));

    const note = backend.turnTexts.find((t) => t.includes("flux-dev.safetensors")) as string;
    expect(note, "both orphaned transfers must be named").toContain("wan22.safetensors");
    expect(note).toMatch(/partial/i);
  });

  it("an UNARMED respawn says nothing, even with transfers in flight", async () => {
    // Review, P1. The first version hooked EVERY mcp-env restart. `applyPendingRestarts`
    // also serves retargets (#1429) and the base_path recovery respawn — neither is a
    // credential save, so the note would have claimed one "was saved earlier", and
    // `retargetAllForMcpEnv` deliberately gives an IDLE tab no turn at all. Only an armed
    // credential respawn may speak.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const tab = "tab-1567-unarmed";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    manager.restartAllForMcpEnv(); // NOT armed — e.g. a retarget or base_path recovery

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    await new Promise((r) => setTimeout(r, 120));

    expect(backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors"))).toHaveLength(0);
  });

  it("reports ONCE, not once per tab", async () => {
    // Review, P1. The download list is global and a credential respawn replaces every
    // tab's comfyui child — so the list is the right SET, but N tabs restarting would each
    // have announced the same transfers, N times.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    manager.send("tab-a", "hello");
    manager.send("tab-b", "hello");
    await waitFor(() => backend.runCount >= 2 && backend.turnTexts.length >= 2);

    // A Settings-slot save: no particular tab.
    expect(manager.restartAllForMcpEnvAfterCredentialChange(null).scheduled).toBe(2);

    backend.autoComplete = true;
    backend.release(); // releases BOTH held turns
    await waitFor(() => backend.runCount >= 4);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));
    await new Promise((r) => setTimeout(r, 120)); // let a second copy arrive if it would

    expect(
      backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors")),
      "exactly one tab carries it",
    ).toHaveLength(1);
  });

  it("goes to the tab it was armed for, not whichever restarts first", async () => {
    // Consuming the watch once is not enough on its own: without the tab check the FIRST
    // tab to restart takes it, so the note lands in a conversation that did not save the
    // credential. The transfers really are dying, so the text is true — it is just being
    // told to the wrong person, which is how a report gets ignored.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    // tab-a is created (and therefore restarts) FIRST; the credential belongs to tab-b.
    manager.send("tab-a", "hello from a");
    await waitFor(() => backend.runCount >= 1);
    manager.send("tab-b", "hello from b");
    await waitFor(() => backend.runCount >= 2 && backend.turnTexts.length >= 2);

        expect(manager.restartAllForMcpEnvAfterCredentialChange("tab-b").scheduled).toBe(2);

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 4);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));
    await new Promise((r) => setTimeout(r, 120));

    // Exactly one turn carries it…
    const carrying = backend.turns.filter((t) => t.text.includes("flux-dev.safetensors"));
    expect(carrying).toHaveLength(1);
    // …and it must be tab-b's respawned agent, not tab-a's. Tabs restart in insertion
    // order, so the runs are: 1 = tab-a, 2 = tab-b, 3 = tab-a respawned, 4 = tab-b
    // respawned. A watch that ignores the tab hands the note to run 3.
    expect(carrying[0].run, "the note belongs to the tab the credential was saved on").toBe(4);
  });

  it("an armed watch that nothing can deliver does NOT survive to a later restart", async () => {
    // Review, P1. Consuming on delivery alone leaks: a save with no managed tabs queues
    // nothing, so nothing ever consumes the watch, and the next unrelated mcp-env respawn
    // — a retarget, a base_path recovery — would present a stale "a credential was saved
    // earlier" note about transfers it had no part in killing.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 }];
    const backend = new RecordingBackend();
    const manager = makeManager(backend);

    // Armed with NO tabs alive: nothing to queue, nothing to deliver it.
        expect(manager.restartAllForMcpEnvAfterCredentialChange(null).live).toBe(0);

    // A completely unrelated restart, later, on a tab that did not exist at save time.
    backend.autoComplete = false;
    manager.send("tab-later", "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    manager.restartAllForMcpEnv(); // e.g. a retarget — never armed
    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    await new Promise((r) => setTimeout(r, 120));

    expect(backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors"))).toHaveLength(0);
  });

  it("a watch whose tab disappears does not wait around for an unrelated respawn", async () => {
    // Review, P1, second half. The tab the watch names can be retired before its queued
    // restart ever runs, so nothing reaches the delivery site to consume it. Without a
    // release on removal the watch would sit armed and attach to whatever respawn came
    // next — presenting a stale "a credential was saved earlier" note in a conversation
    // that had nothing to do with it.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    // Armed with NO tab — a Settings-slot save. This is the case that actually leaks: a
    // tab-scoped watch is already refused by the tab check, so it would pass this test
    // whether or not removal released anything. A null watch matches ANY tab, so only the
    // release keeps it from landing on a stranger.
    manager.send("tab-doomed", "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    expect(manager.restartAllForMcpEnvAfterCredentialChange(null).scheduled).toBe(1);

    // The tab goes away before its queued restart can run.
    manager.retire("tab-doomed");
    expect(manager.liveKeys()).not.toContain("tab-doomed");

    // A later, unrelated respawn on a different tab must stay quiet.
    manager.send("tab-other", "hello again");
    await waitFor(() => backend.runCount >= 2);
    manager.restartAllForMcpEnv();
    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 3);
    await new Promise((r) => setTimeout(r, 120));

    expect(backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors"))).toHaveLength(0);
  });

  it("a watch is not kept alive by tabs it will never be delivered to", async () => {
    // Review, round 3. Releasing only on the DROPPED path leaves the set non-empty forever:
    // a save on tab-a with tab-b also busy gives awaiting={a,b}; retiring a trims it to
    // {b}; b then restarts successfully, matches nothing, and released nothing. The watch
    // survives until a RECREATED tab-a restarts and collects a warning about a save from
    // before it existed.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);

    manager.send("tab-a", "hello a");
    await waitFor(() => backend.runCount >= 1);
    manager.send("tab-b", "hello b");
    await waitFor(() => backend.runCount >= 2 && backend.turnTexts.length >= 2);

    // The credential is saved on tab-a; both tabs are busy, so both are queued.
    expect(manager.restartAllForMcpEnvAfterCredentialChange("tab-a").scheduled).toBe(2);

    manager.retire("tab-a"); // the named tab goes away before its restart runs
    backend.autoComplete = true;
    backend.release(); // tab-b restarts, matches nothing, and must clear the last hold
    await waitFor(() => backend.runCount >= 3);

    // tab-a comes back later and does an ordinary, unrelated env respawn.
    backend.autoComplete = false;
    manager.send("tab-a", "hello again");
    await waitFor(() => backend.turnTexts.includes("hello again"));
    manager.restartAllForMcpEnv();
    backend.autoComplete = true;
    backend.release();
    await new Promise((r) => setTimeout(r, 150));

    expect(
      backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors")),
      "no warning about a save that predates this tab",
    ).toHaveLength(0);
  });

  it("two saves on one busy tab share the coalesced restart and report ONCE", async () => {
    // Review raised this as a possible leak: the second save's watch "adopts" the restart
    // the first save queued. That is not a defect, and this pins why rather than leaving it
    // to be rediscovered.
    //
    // `restartAllForMcpEnv` COALESCES — a tab with a pending restart does not get a second
    // one. So the queued restart is the vehicle for both saves: it rebuilds the child with
    // an env carrying both changes, and it is the moment both are waiting for. The note
    // describes the transfers that actually die at that moment, which is the same set for
    // either save. One restart, one note, and no watch left over.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 4_000_000_000 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const tab = "tab-two-saves";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);

    expect(manager.restartAllForMcpEnvAfterCredentialChange(tab).scheduled).toBe(1);
    expect(
      manager.restartAllForMcpEnvAfterCredentialChange(tab).scheduled,
      "coalesced, not a second restart",
    ).toBe(1);

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));
    await new Promise((r) => setTimeout(r, 120));

    expect(backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors"))).toHaveLength(1);
    expect(backend.runCount, "exactly one respawn happened").toBe(2);

    // And nothing is left armed: a later unrelated respawn stays quiet.
    backend.autoComplete = false;
    manager.send(tab, "again");
    await waitFor(() => backend.turnTexts.includes("again"));
    manager.restartAllForMcpEnv();
    backend.autoComplete = true;
    backend.release();
    await new Promise((r) => setTimeout(r, 150));
    expect(backend.turnTexts.filter((t) => t.includes("flux-dev.safetensors"))).toHaveLength(1);
  });

  it("stays silent when the respawn orphans nothing", async () => {
    // The direction that fails quietly: a note pushed unconditionally would still pass the
    // test above, while costing a real agent turn on every env respawn. A nudge is a turn,
    // not a log line.
    atRisk.jobs = [];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const tab = "tab-1567-quiet";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
        expect(manager.restartAllForMcpEnvAfterCredentialChange(tab).scheduled).toBe(1);

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    await new Promise((r) => setTimeout(r, 120)); // give a spurious nudge time to arrive

    expect(backend.turnTexts.filter((t) => /rebuild is happening NOW/i.test(t))).toHaveLength(0);
  });

  it("does not swallow an existing retry nudge", async () => {
    // The #164 payload still has to arrive; the orphan note is appended, not substituted.
    atRisk.jobs = [{ id: "j1", filename: "flux-dev.safetensors", bytes: 1 }];
    const backend = new RecordingBackend();
    backend.autoComplete = false;
    const manager = makeManager(backend);
    const tab = "tab-1567-both";

    manager.send(tab, "hello");
    await waitFor(() => backend.runCount >= 1 && backend.turnTexts.length >= 1);
    // A per-request retry nudge is queued FIRST (#164), then the credential respawn lands
    // on top of it — the real ordering, since the secrets subscriber restarts silently and
    // nudges the requesting tab separately. The orphan note must join that nudge, not
    // replace it.
    manager.restartAllForMcpEnv("RETRY the download");
    manager.restartAllForMcpEnvAfterCredentialChange(tab);

    backend.autoComplete = true;
    backend.release();
    await waitFor(() => backend.runCount >= 2);
    await waitFor(() => backend.turnTexts.some((t) => t.includes("flux-dev.safetensors")));

    const delivered = backend.turnTexts.find((t) => t.includes("flux-dev.safetensors")) as string;
    expect(delivered).toContain("RETRY the download");
  });
});
