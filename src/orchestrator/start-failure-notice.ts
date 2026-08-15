/**
 * PER-TAB start-failure notice (issue #250, extracted for testability — issue
 * #255 review finding 5): when a tab's agent backend rejects at
 * prepare()/first-connect (an invalid API key 401ing on an OpenAI-dialect
 * provider, an unreachable endpoint), the orchestrator degrades THAT tab only.
 * This module builds the exact bridge frames the orchestrator pushes:
 *
 *   1. an honest `say` naming the provider, with check-your-key guidance
 *      (hint selected via the OpenAI-key provider registry when the backend is
 *      a registered key provider, with openrouter/custom/generic fallbacks);
 *   2. a degraded `ack` so the panel shows the real state;
 *   3. `turn: done` — the user_message path already pushed turn:"working", and
 *      the panel clears its thinking spinner ONLY on turn:"done"; without this
 *      the degraded tab sits on a live spinner for the 120s safety timeout
 *      (adversarial review of #253, finding 1).
 *
 * The manager reports failures under the COMPOSITE agent key
 * (`panelTabId::backend`); frames must go to the PANEL tab, so the composite
 * key is split here on its LAST separator (a panel tab id never contains "::";
 * backend names never do).
 *
 * The `say` is HUMAN-facing and names panel controls ("Settings → Custom
 * endpoint", "the API Keys card"), so it renders in the DESTINATION TAB's panel
 * language rather than the process's. There is usually more than one destination
 * — #884's conversation spans every tab on the failed backend, and those panels
 * can be in different languages — so the sentence also lives on its own in
 * `startFailureSay()`, which the orchestrator calls once per recipient. `locale`
 * defaults to English throughout, so every existing caller and test keeps its
 * exact current output. The `ack` and `turn` frames beside it are machine state
 * and stay untranslated.
 */
import { trFor } from "../i18n/index.js";
import { openAiKeyProvider } from "../services/openai-provider-registry.js";

export const AGENT_KEY_SEP = "::";

/** The panel tab id half of a composite agent key (the whole key when bare). */
export function panelTabOfKey(key: string): string {
  const i = key.lastIndexOf(AGENT_KEY_SEP);
  return i >= 0 ? key.slice(0, i) : key;
}

/** The backend half of a composite agent key (`fallback` when bare). */
export function backendOfKey(key: string, fallback: string): string {
  const i = key.lastIndexOf(AGENT_KEY_SEP);
  return i >= 0 ? key.slice(i + AGENT_KEY_SEP.length) : fallback;
}

/** Check-your-credentials guidance for a backend that failed to start, in `locale`.
 *  The provider label and env-var name are interpolated, never translated: they are the
 *  literal strings the user has to find in the API Keys card and in their shell. */
export function startFailureHint(backend: string, locale = "en"): string {
  const reg = openAiKeyProvider(backend);
  if (reg) {
    return trFor(
      locale,
      "say.start_failure.hint.key_provider",
      "Check your {provider} API key in the API Keys card ({env}), then Disconnect → Connect to retry.",
      { provider: reg.slotLabel, env: reg.envKeys[0] },
    );
  }
  if (backend === "openrouter") {
    return trFor(
      locale,
      "say.start_failure.hint.openrouter",
      "Check your OpenRouter API key in the API Keys card (OPENROUTER_API_KEY), then Disconnect → Connect to retry.",
    );
  }
  if (backend === "custom") {
    return trFor(
      locale,
      "say.start_failure.hint.custom",
      "Check the base URL and API key in Settings → Custom endpoint, then Disconnect → Connect to retry.",
    );
  }
  return trFor(
    locale,
    "say.start_failure.hint.generic",
    "Check the provider's credentials/login, then Disconnect → Connect to retry.",
  );
}

export interface StartFailureNotice {
  /** The PANEL tab the frames must be pushed to (composite key split). */
  panelTab: string;
  /** The backend half of the composite key (names the provider in the say). */
  backend: string;
  /** Bridge frames, in push order: say → degraded ack → turn done. */
  frames: Array<Record<string, unknown>>;
}

/**
 * The HUMAN-facing bubble for a start failure, in `locale`.
 *
 * Exported separately from the notice below because the conversation this is announced to
 * can span several tabs whose panels are in DIFFERENT languages: the orchestrator renders
 * this once per recipient, while the `ack`/`turn` frames beside it are machine state and fan
 * out unchanged. This IS the sentence — `buildStartFailureNotice` calls it too rather than
 * holding a second copy, so the delivered text and the tested text cannot drift apart.
 */
export function startFailureSay(backend: string, message: string, locale = "en"): string {
  // ⚠️ outside the translated span — a status marker, not prose, and the same in every
  // language. `message` is the provider's own error text and is passed through verbatim;
  // trFor interpolates in ONE pass, so a `{hint}`-looking sequence inside it stays literal.
  return `⚠️ ${trFor(
    locale,
    "say.start_failure.notice",
    "The {backend} agent could not start: {message} — {hint}",
    { backend, hint: startFailureHint(backend, locale), message },
  )}`;
}

/**
 * Build the per-tab degradation frames for a start failure on `key`.
 *
 * The `say` here is ENGLISH, deliberately and always. The orchestrator does not deliver this
 * copy of it — it re-renders the sentence per recipient through `startFailureSay`, because one
 * conversation can span panels in different languages. A `locale` parameter on this function
 * would therefore be exercised only by its own tests, pinning a path production never takes;
 * the two could then drift apart with everything still green.
 */
export function buildStartFailureNotice(
  key: string,
  message: string,
  defaultBackend: string,
): StartFailureNotice {
  const backend = backendOfKey(key, defaultBackend);
  return {
    panelTab: panelTabOfKey(key),
    backend,
    frames: [
      { type: "say", text: startFailureSay(backend, message) },
      { type: "ack", ok: false, kind: "degraded" },
      { type: "turn", state: "done" },
    ],
  };
}
