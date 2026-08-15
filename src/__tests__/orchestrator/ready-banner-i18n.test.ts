// The ready banner is a `say` frame a PERSON reads, so it must render in the
// destination panel's language — which means the locale the caller supplies has to
// reach `trFor`, on BOTH paths (the per-backend switch and the openai-provider
// registry's readyMessage). Asserting on the English text alone cannot see that:
// with no catalogs on disk every locale renders the same fallback, so a dropped
// `locale` argument would look perfectly healthy. Hence the i18n module is mocked
// and the (locale, key) pairs are observed directly.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface TrCall {
  locale: string;
  key: string;
  fallback: string;
  vars?: Record<string, string | number>;
}
const calls: TrCall[] = [];

vi.mock("../../i18n/index.js", () => ({
  // A sentinel rather than a real locale: an implementation that quietly hardcoded
  // "en" instead of consulting the process locale would still be caught.
  processLocale: () => "process-fallback",
  trFor: (locale: string, key: string, fallback: string, vars?: Record<string, string | number>) => {
    calls.push({ locale, key, fallback, vars });
    return `${locale}|${key}`;
  },
}));

import { readyBannerText, bannerCorrection } from "../../orchestrator/ready-banner.js";
import { OPENAI_KEY_PROVIDERS } from "../../services/openai-provider-registry.js";

beforeEach(() => {
  calls.length = 0;
});

describe("ready-banner i18n wiring", () => {
  it("passes the caller's locale to trFor on the per-backend switch path", () => {
    expect(readyBannerText("ollama", "llama3", "", "ko")).toBe("ko|banner.ready.ollama");
    expect(calls).toHaveLength(1);
    expect(calls[0].locale).toBe("ko");
    expect(calls[0].vars?.label).toBe("llama3");
    // The English source text stays at the call site, so a missing catalog degrades
    // to correct English rather than a raw key.
    expect(calls[0].fallback).toContain("comfyui-mcp agent ready");
    expect(calls[0].fallback).toContain("{label}");
  });

  it("passes the caller's locale through to a registry provider's readyMessage", () => {
    expect(readyBannerText("glm", "glm-5.2", "", "ja")).toBe("ja|banner.ready.glm");
    expect(calls[0].locale).toBe("ja");
    expect(calls[0].vars?.label).toBe("glm-5.2");
  });

  it("falls back to the process locale when the caller supplies none", () => {
    readyBannerText("codex", "gpt-5.5");
    readyBannerText("minimax", "MiniMax-M3");
    expect(calls.map((c) => c.locale)).toEqual(["process-fallback", "process-fallback"]);
  });

  // bannerCorrection re-renders the SAME banner for the same tab, so it must carry
  // the same locale — a correction arriving in a different language than the greeting
  // it replaces is the visible bug this guards.
  it("bannerCorrection forwards the locale to the re-rendered banner", () => {
    expect(
      bannerCorrection({
        backend: "claude",
        advertisedLabel: "claude-opus-5",
        resolvedModel: "claude-sonnet-4-5",
        locale: "fr",
      }),
    ).toBe("fr|banner.ready.claude");
    expect(calls[0].vars?.label).toBe("claude-sonnet-4-5");
  });

  it("the custom-endpoint banner still carries its base URL as a var", () => {
    readyBannerText("custom", "my-model", "http://localhost:8000/v1", "es");
    expect(calls[0].key).toBe("banner.ready.custom");
    expect(calls[0].vars?.url).toBe("http://localhost:8000/v1");
    expect(calls[0].fallback).toContain("{url}");
  });

  // Seventeen near-identical lines were keyed by hand; a copy-pasted key would make
  // two backends share one translation and no other test would notice.
  it("every backend renders under its own key", () => {
    const backends = [
      "codex", "chatgpt", "gemini", "antigravity", "pi", "grok", "ollama", "lmstudio",
      "llamacpp", "custom", "openrouter", "copilot", "claude",
      ...OPENAI_KEY_PROVIDERS.map((p) => p.id),
    ];
    for (const b of backends) readyBannerText(b, "label", "", "en");
    const keys = calls.map((c) => c.key);
    expect(keys).toHaveLength(backends.length);
    expect(new Set(keys).size).toBe(backends.length);
    expect(keys.every((k) => k.startsWith("banner.ready."))).toBe(true);
  });
});
