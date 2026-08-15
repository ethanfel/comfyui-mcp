# ComfyUI `/settings` read/write tools

**Status:** implemented (this PR)

> **Superseded surface (0.50.0 slice 7).** Both tools were folded into the
> action-parameterized `get_defaults` tool; the behaviour, the routes and the
> return shapes below are unchanged, only the names are.
> The read tool shipped as `get_comfyui_settings` and is today `get_defaults` with `action: "get_ui"`.
> The write tool shipped as `set_comfyui_setting` and is today `get_defaults` with `action: "set_ui"`.
> The headings below have been retitled to the live surface; everything else is
> the record of what was designed and built.

> **No gating.** The original draft gated the settings WRITE behind a `settings-writes` safety gate (spec PR #172). Safety gates were closed as **won't-do** (issue #168: single-user deployment reality, permissive-by-default is correct; ROADMAP Theme G archives the design). This PR ships the write **ungated** — its tool description states plainly that it modifies the ComfyUI user's persisted UI settings and that changes take effect on the next frontend load/refresh.

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `comfy_settings_get`/`comfy_settings_set`. We add filtering, previous-value capture for undo, and multi-user/version-drift handling.

## Motivation

ComfyUI's frontend persists per-user settings via `GET /settings`, `GET /settings/{id}`, `POST /settings/{id}` (served by the user manager). Our own generation-defaults store (`get_defaults` with `action: "get"`/`"set"`) is a separate SQLite store — unrelated. Agents currently cannot toggle e.g. `Comfy.Validation.Workflows` (whose strictness rejects some custom-node workflows), the link render mode, or `Comfy.PreviewMethod`; the panel agent has real use cases (diagnose "why does the user's UI reject this workflow", set preview method before long jobs).

## Tool API

### `get_defaults` `action: "get_ui"` — read-only, category `server`

```ts
{
  id: z.string().optional()
    .describe("Setting id, e.g. 'Comfy.Validation.Workflows'. Omit to list all settings."),
  filter: z.string().optional()
    .describe("Case-insensitive substring filter on setting ids when listing (e.g. 'preview')."),
}
```

With `id`: `{ id, value }` — value is the raw stored JSON, or an explicit "unset (frontend default applies)" note. Without `id`: a sorted `id: value` listing (filtered), with a caveat that unset keys use frontend defaults invisible to this API.

### `get_defaults` `action: "set_ui"` — write, category `server` (ungated)

```ts
{
  id: z.string().describe("Setting id, e.g. 'Comfy.Validation.Workflows'"),
  value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.any()), z.array(z.any())])
    .describe("New value. Stored as-is; booleans/numbers are NOT coerced from strings."),
}
```

Result: `{ id, previous, value }` — the old value is read first so the agent can report and undo. The description enumerates useful known ids — `Comfy.Validation.Workflows` (boolean), `Comfy.PreviewMethod` (`auto|latent2rgb|taesd|none`), `Comfy.LinkRenderMode` (0 straight / 1 linear / 2 spline / 3 hidden), `Comfy.UseNewMenu`, `Comfy.Sidebar.Location` — and notes that ids are frontend-defined: unknown ids are stored verbatim and ignored by the UI, and changes take effect on the next frontend load/refresh.

Gating: **none** (won't-do per issue #168). The tool description makes the write and its "takes effect on next frontend load/refresh" semantics explicit — that transparency, not a gate, is the safety mechanism for a single-user deployment.

## Implementation

### Client integration — `src/comfyui/client.ts`

Follow the exact `freeMemory`/`getLogs` pattern (`getClient().fetchApi(...)`, cloud-mode dispatch):

```ts
export async function getSettings(): Promise<Record<string, unknown>>       // GET /settings
export async function getSetting(id: string): Promise<unknown>              // GET /settings/{encodeURIComponent(id)}
export async function setSetting(id: string, value: unknown): Promise<void> // POST /settings/{id}, JSON body = raw value
```

- Cloud mode: `requireLocalMode("settings")` — Comfy Cloud exposes no per-user settings store; simplest correct behavior, revisit if that changes. Remote mode works (plain REST) and inherits `comfyuiFetch` auth headers.

### Version drift / error handling

- Multi-user ComfyUI (`--multi-user`) requires a `comfy-user` header; without it `/settings` can 404 or hit another user's store. Document that multi-user servers need `COMFYUI_AUTH_COMFY_USER` set (headers already injected by `comfyuiFetch`).
- 404 on the bare `/settings` route → clear error: "This ComfyUI version/config does not expose the user settings API (requires the standard frontend user manager)."
- `GET /settings/{id}` for an unset key returns empty body on some versions and `null` on others — treat empty/`null`/parse-failure uniformly as "unset (frontend default applies)".
- Older frontends store some values as strings (`"true"`) — pass through verbatim, never coerce; surface the raw stored type.

### Tool registration

As shipped: its own tool file registering two tools, appended at the end of `TOOL_GROUPS` under category `server` (registration order is observable — never insert mid-list). Errors via `errorToToolResult` (`src/utils/errors.ts`).

Since 0.50.0 slice 7 the two handlers live in `src/tools/defaults.ts` as the `get_ui`/`set_ui` branches of `get_defaults`, which keeps its own (earlier) registration slot. The `server` group entry is gone rather than empty.

## Test plan (vitest)

Covered by `src/__tests__/tools/defaults.test.ts` (pattern: `queue-management.test.ts` — `vi.mock` the client): list + filter rendering; single get incl. unset-key handling; set returns `{previous, value}`; 404 → friendly version-drift error; cloud mode throws `CLOUD_UNSUPPORTED`. Optional integration test under `COMFYUI_INTEGRATION=true`: get → set → restore round-trip on a scratch key.

## Rollout / compat

Additive. Ships ungated — safety gates were closed as won't-do (issue #168; ROADMAP Theme G archives the design). The tool description states that it modifies the ComfyUI user's persisted UI settings and takes effect on the next frontend load/refresh.
