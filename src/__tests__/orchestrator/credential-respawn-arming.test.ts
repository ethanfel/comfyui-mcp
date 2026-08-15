// #1567 — the orphan check only runs for the CREDENTIAL respawn, and that is a single call
// in the secrets subscriber in index.ts.
//
// A line like that is invisible to behavioural tests: delete it and every unit test still
// passes, because the manager-level tests drive the method directly. The feature simply
// never fires in production. So this asserts the wiring at its source, and the mutation
// harness swaps the call back to the plain restart to prove the assertion is load-bearing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf-8");

describe("the credential respawn arms the orphan check (#1567)", () => {
  it("uses the credential-aware restart, scoped to the change's tab", () => {
    expect(SRC).toMatch(
      /manager\.restartAllForMcpEnvAfterCredentialChange\(change\.tabId \?\? null\)/,
    );
  });

  it("arms and restarts in ONE call, so a watch cannot outlive its save", () => {
    // Review, P1. A separate arm-then-restart left a window: a watch created by one call
    // and bound by a LATER restartAllForMcpEnv would attach itself to whatever tabs that
    // unrelated respawn happened to queue, then report a credential save that had nothing
    // to do with it. There is no separate arming entry point to misuse.
    expect(SRC).not.toMatch(/armCredentialRespawnOrphanWatch/);
  });

  it("is used on the SECRETS path only", () => {
    // The other restartAllForMcpEnv caller is the base_path recovery respawn (#296), which
    // is not a credential save. Using the credential-aware variant there would attach a
    // note claiming a credential "was saved earlier" to an unrelated restart — and would
    // hand an idle tab an agent turn it never asked for.
    const uses = (SRC.match(/restartAllForMcpEnvAfterCredentialChange\(/g) ?? []).length;
    expect(uses, "exactly one call site").toBe(1);
    const at = SRC.indexOf("manager.restartAllForMcpEnvAfterCredentialChange(");
    const before = SRC.slice(Math.max(0, at - 2000), at);
    expect(before, "it must sit inside the secrets subscriber").toMatch(/onComfyuiSecretsChanged/);
  });
});
