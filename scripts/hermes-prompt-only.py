#!/usr/bin/env python3
"""Run one Hermes turn with a strict, empty tool allowlist.

Hermes one-shot validates CLI toolset names before constructing the agent and
does not currently expose a public "none" toolset. This adapter keeps the
normal one-shot execution and configured model/provider, while allowing one
reserved name through validation. At the agent layer that name resolves to no
tool schemas. Safe mode is set directly (not through the CLI flag) so plugins,
MCP servers, and shell hooks stay disabled without discarding the user's custom
model endpoint.
"""

from __future__ import annotations

import json
import os
import sys


PROMPT_ONLY_TOOLSET = "__comfyui_prompt_assist_no_tools__"


def _isolation_environment() -> None:
    os.environ["HERMES_SAFE_MODE"] = "1"
    os.environ["HERMES_IGNORE_RULES"] = "1"
    # The CLI --safe-mode path sets this to 1. We deliberately retain model,
    # provider, base_url, and credentials from the user's Hermes config.
    os.environ["HERMES_IGNORE_USER_CONFIG"] = "0"


def _verify() -> int:
    from toolsets import resolve_multiple_toolsets

    resolved_names = resolve_multiple_toolsets([PROMPT_ONLY_TOOLSET])
    report = {
        "enabled_toolsets": [PROMPT_ONLY_TOOLSET],
        "resolved_tool_names": resolved_names,
        "safe_mode": os.environ.get("HERMES_SAFE_MODE"),
        "ignore_user_config": os.environ.get("HERMES_IGNORE_USER_CONFIG"),
    }
    print(json.dumps(report, sort_keys=True))
    return 0 if not resolved_names else 1


def main() -> int:
    _isolation_environment()
    if sys.argv[1:] == ["--verify"]:
        return _verify()
    if sys.argv[1:]:
        sys.stderr.write("hermes prompt-only: unexpected command-line arguments\n")
        return 2

    prompt = sys.stdin.read()
    if not prompt.strip():
        sys.stderr.write("hermes prompt-only: prompt cannot be empty\n")
        return 2

    import hermes_cli.oneshot as oneshot

    original_validate = oneshot._validate_explicit_toolsets

    def validate_prompt_only(toolsets: object = None):
        normalized = oneshot._normalize_toolsets(toolsets)
        if normalized == [PROMPT_ONLY_TOOLSET]:
            return [PROMPT_ONLY_TOOLSET], None
        return original_validate(toolsets)

    oneshot._validate_explicit_toolsets = validate_prompt_only
    return oneshot.run_oneshot(prompt, toolsets=PROMPT_ONLY_TOOLSET)


if __name__ == "__main__":
    raise SystemExit(main())
