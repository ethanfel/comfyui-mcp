import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { platform } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { config, isRemoteMode } from "../config.js";
import {
  installCustomNode,
  installModelViaManager,
  listInstalledNodes,
  type InstalledNode,
} from "./node-management.js";
import { targetsPanelPackExactly } from "./panel-pin-guard.js";
import {
  downloadModel,
  listLocalModels,
  liveListingHasEntry,
  liveListingHasBasename,
  isUnderLiveModelRoots,
  currentLiveModelsRoot,
  resolveExistingModelFile,
  managerModelDestination,
  MODEL_SUBDIRS,
  type ModelType,
} from "./model-resolver.js";
import { startDownloadJob, describePlacement, type DownloadJob } from "./download-jobs.js";
import { resolveModelsDir } from "./output-dir.js";
import {
  getSavedDefaultWorkspaceSync,
  resolveInstallInterpreter,
  resolveLiveComfyUIBase,
  type InstallInterpreterResolution,
} from "./workspace-env.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/** Grace window (ms) to await a manifest model download before handing back a
 *  background job handle. Keeps apply_manifest under the MCP tools/call timeout
 *  on large model packs (#362); small files still complete inline. */
function manifestDownloadGraceMs(): number {
  const raw = Number(process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

/** Overall wall-clock budget (ms) for the custom-node install phase. Node installs
 *  drive the ComfyUI-Manager queue, which can legitimately run for minutes on a
 *  big pack. Blocking apply_manifest until it drains blows past the MCP tools/call
 *  timeout (300s) and the caller sees a FALSE failure while the Manager keeps
 *  installing (#489). Bounding the phase well under that cap lets us hand back a
 *  "pending" result (poll the Manager queue) instead. Env-tunable; default 240s. */
function manifestNodeBudgetMs(): number {
  const raw = Number(process.env.COMFYUI_MCP_MANIFEST_NODE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 240_000;
}

/** Sentinel returned by raceDeadline when the wall-clock deadline wins. */
const BUDGET_TIMEOUT = Symbol("manifest-node-budget-timeout");

/**
 * Await `p` but never past the absolute `deadline` (Date.now() ms). Returns the
 * resolved value, or BUDGET_TIMEOUT if the deadline elapses first. Bounds EVERY
 * async wait in the custom-node phase (#489) — the install itself AND the
 * surrounding listInstalledNodes round-trips — so a slow Manager can never push
 * apply_manifest past the MCP tools/call timeout; it hands back "pending" instead.
 *
 * CAVEAT (single-threaded runtime): this bounds ASYNC work only. A SYNCHRONOUS
 * subprocess install unit — the git-clone / cm-cli fallback (execFileSync), like
 * pip — blocks the event loop, so the timer cannot preempt one already running;
 * each is instead bounded by its OWN execFileSync timeout. The race is what fixes
 * #489's actual case: the ASYNC Manager-queue polling that keeps running for
 * minutes. `p` must not reject (callers pass a pre-caught promise).
 */
async function raceDeadline<T>(
  p: Promise<T>,
  deadline: number,
): Promise<T | typeof BUDGET_TIMEOUT> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return BUDGET_TIMEOUT;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof BUDGET_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_TIMEOUT), remaining);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const IS_WIN = platform() === "win32";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const YAML_MAX_ALIAS_COUNT = 50;
const ASCII_CONTROL_RE = /[\x00-\x1F\x7F]/;
const WHITESPACE_RE = /\s/;

const modelTypeSchema = z.enum(MODEL_SUBDIRS);

export const manifestSchema = z
  .object({
    apt: z.array(z.string().min(1)).optional().default([]),
    pip: z.array(z.string().min(1)).optional().default([]),
    custom_nodes: z.array(z.string().min(1)).optional().default([]),
    models: z
      .array(
        z
          .object({
            url: z.string().url(),
            model_type: modelTypeSchema.optional(),
            filename: z.string().min(1).optional(),
            local_path: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional()
      .default([]),
  })
  .strict();

export type ComfyManifest = z.infer<typeof manifestSchema>;

export interface ApplyManifestOptions {
  manifest?: unknown;
  path?: string;
  /** #1568 — a bundled pack by NAME. Resolved against the RUNNING package root at apply
   *  time, so it cannot expire the way a captured path does. */
  pack?: string;
}

// ---------------------------------------------------------------------------
// #1568 — bundled pack manifests, resolved by name rather than by a path that expires
//
// `list_packs` hands out an absolute `manifest_path` built from the running package root.
// Under npx that root is `…/_npx/<hash>/node_modules/comfyui-mcp`, and the next respawn
// gets a different <hash> — so a path captured earlier stats ENOENT while the pack is
// still sitting there under its name.
//
// The lookup was never the broken part. `packsDir()` already derives from the current
// root; what goes stale is the string we publish and invite the caller to hand back.
// ---------------------------------------------------------------------------

/** A single safe path segment — a pack directory name with no traversal or separators.
 *  Mirrors skills-access.ts's SAFE_NAME, which guards the same directory. */
const SAFE_PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The bundled packs directory of the CURRENTLY RUNNING build. */
function bundledPacksDir(): string {
  return join(fileURLToPath(new URL("../../", import.meta.url)), "packs");
}

/**
 * The manifest file of a bundled pack, or null when there is no such pack.
 *
 * Name-guarded and existence-checked: the name reaches the filesystem, so traversal must
 * not. Returns the `.yaml` or `.yml` form, whichever the pack actually ships.
 */
export function resolvePackManifestFile(packName: string): string | null {
  const name = String(packName ?? "").trim();
  if (!SAFE_PACK_NAME.test(name)) return null;
  const root = bundledPacksDir();
  const packDir = join(root, name);
  // Belt and braces over the name test: never leave the packs directory.
  if (!packDir.startsWith(root)) return null;
  for (const file of ["manifest.yaml", "manifest.yml"]) {
    const candidate = join(packDir, file);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Which bundled pack a MISSING path was almost certainly naming, or null.
 *
 * This deliberately does NOT substitute the file. An earlier version of this returned the
 * live path and applied it, and review was right to attack that: `apply_manifest` installs
 * custom nodes and downloads model weights, so running a file the caller did not name is a
 * much worse failure than the ENOENT it replaces — and the recogniser authenticated only
 * the last four segments, so a user's own `~/dev/comfyui-mcp/packs/<name>/manifest.yaml`
 * would have been retargeted at a bundled pack that merely shares a directory name.
 *
 * So it answers a question instead: "is there a bundled pack this dead path was pointing
 * at?" The caller turns that into an actionable refusal naming `pack:<name>`, which is one
 * call away and leaves the choice with the user. `pack:` is the actual fix for #1568; this
 * only stops the failure being a bare ENOENT that reads like a missing pack.
 *
 * Still requires `node_modules` in the path, because the reported failure is an INSTALLED
 * copy under an npx cache — that keeps a source checkout out of it entirely.
 */
export function bundledPackNamedByStalePath(candidate: string): string | null {
  const raw = String(candidate ?? "");
  if (!raw.trim()) return null;
  // Only a path that resolves to nothing is a candidate. This is not a security boundary —
  // nothing is substituted on the strength of it — so an ambiguous stat (a permission
  // error, a dangling symlink) costing us a suggestion is the harmless direction.
  if (existsSync(raw)) return null;
  const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 5) return null;
  const file = parts[parts.length - 1];
  const name = parts[parts.length - 2];
  const packs = parts[parts.length - 3];
  const owner = parts[parts.length - 4];
  const container = parts[parts.length - 5];
  if (file !== "manifest.yaml" && file !== "manifest.yml") return null;
  if (packs !== "packs") return null;
  if (owner !== "comfyui-mcp") return null;
  // An INSTALLED copy, which is what an npx cache holds. A working checkout at
  // `~/dev/comfyui-mcp/packs/…` is not this, and its missing file is its own business.
  if (container !== "node_modules") return null;
  if (!SAFE_PACK_NAME.test(name)) return null;
  // …and only if this build actually ships it, so the hint never names a pack that is not
  // there to apply.
  return resolvePackManifestFile(name) ? name : null;
}

export type ManifestAction =
  | "apt"
  | "pip"
  | "custom_node"
  | "model";

export type ManifestItemStatus = "applied" | "skipped" | "failed" | "pending";

export interface ManifestItemReport {
  item: string;
  action: ManifestAction;
  status: ManifestItemStatus;
  message: string;
}

export interface ApplyManifestResult {
  success: boolean;
  summary: Record<ManifestItemStatus, number>;
  results: ManifestItemReport[];
}

function parseManifestText(path: string, text: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return JSON.parse(text);
  if (ext === ".yaml" || ext === ".yml") {
    return parseYaml(text, { maxAliasCount: YAML_MAX_ALIAS_COUNT });
  }
  throw new ValidationError(
    `Unsupported manifest file extension "${ext || "(none)"}". Use .json, .yaml, or .yml.`,
  );
}

export async function loadManifestFile(path: string): Promise<ComfyManifest> {
  const info = await stat(path);
  if (info.size > MAX_MANIFEST_BYTES) {
    throw new ValidationError(
      `Manifest file is too large (${info.size} bytes). Maximum is ${MAX_MANIFEST_BYTES} bytes.`,
    );
  }
  const text = await readFile(path, "utf-8");
  const raw = parseManifestText(path, text);
  return manifestSchema.parse(raw);
}

/** What `resolveManifest` resolved, plus how — so the caller can report a substitution it
 *  did not ask for (#1568). */
interface ResolvedManifest {
  manifest: ComfyManifest;
  staleRepair?: { requested: string; applied: string; pack: string };
}

async function resolveManifest(opts: ApplyManifestOptions): Promise<ComfyManifest> {
  const hasInline = opts.manifest !== undefined;
  const hasPath = opts.path !== undefined && opts.path.trim().length > 0;
  const hasPack = opts.pack !== undefined && opts.pack.trim().length > 0;
  const given = [hasInline, hasPath, hasPack].filter(Boolean).length;
  if (given !== 1) {
    throw new ValidationError(
      "Provide exactly one of `manifest`, `path`, or `pack` to apply_manifest.",
    );
  }
  if (hasInline) return manifestSchema.parse(opts.manifest);

  // #1568 — a NAME, resolved against the running package root. This is the durable form: a
  // pack name cannot expire the way a path captured under an npx cache hash does.
  if (hasPack) {
    const name = opts.pack!.trim();
    const file = resolvePackManifestFile(name);
    if (!file) {
      throw new ValidationError(
        `No bundled pack named "${name}" ships a manifest in this build. ` +
          `List the available packs with list_packs (action:"list") and use the \`name\` it reports.`,
      );
    }
    return loadManifestFile(file);
  }

  // The path is opened EXACTLY as given. Trimming was only ever meant to decide whether an
  // input was present; trimming what gets opened would silently retarget a legitimate
  // POSIX path with leading or trailing whitespace (review).
  const requested = opts.path!;
  // #1568 — the reported failure: a path handed out by an EARLIER npx process, whose cache
  // directory no longer exists. Turn the bare ENOENT into the one-call remedy rather than
  // applying a file nobody named.
  // ATTEMPT THE OPEN FIRST, and only then explain (review, round 2). Deciding "this is a
  // stale npx path" before trying it replaced the loader's real error — an ordinary npm
  // install under node_modules, or a permission failure, would both have been relabelled,
  // hiding the actual ENOENT/EACCES and pointing at a pack the caller never asked for.
  //
  // So the real error is what surfaces, and the remedy is appended to it.
  try {
    return await loadManifestFile(requested);
  } catch (err) {
    const stalePack = bundledPackNamedByStalePath(requested);
    if (!stalePack) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `${cause}\n\nThat path points inside an installed comfyui-mcp package directory. If it came ` +
        `from an earlier npx run, that directory is replaced on each respawn, which is why a ` +
        `manifest_path captured earlier stops resolving (#1568). This build does ship a pack ` +
        `called "${stalePack}" — if that is the one you meant, re-run with pack: "${stalePack}" ` +
        `instead of a path: it resolves against the running build and cannot go stale. ` +
        `(Nothing was installed.)`,
    );
  }
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync(IS_WIN ? "where" : cmd, IS_WIN ? [cmd] : ["--version"], {
      encoding: "utf-8",
      stdio: "ignore",
      timeout: 5000,
      shell: false,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspacePython(comfyuiPath: string): Promise<InstallInterpreterResolution> {
  return resolveInstallInterpreter(comfyuiPath);
}

function validatePipPackageSpec(pkg: string): void {
  if (pkg.startsWith("-")) {
    throw new ValidationError(`Manifest pip entry must be a package spec, not an option: ${redactUrlCredentials(pkg)}`);
  }
  if (ASCII_CONTROL_RE.test(pkg)) {
    throw new ValidationError("Manifest pip entry cannot contain ASCII control characters.");
  }
  if (WHITESPACE_RE.test(pkg)) {
    throw new ValidationError(`Manifest pip entry cannot contain whitespace: ${redactUrlCredentials(pkg)}`);
  }
}

function runPythonPipInstall(python: string, pkg: string, comfyuiPath: string): string {
  const out = execFileSync(python, ["-m", "pip", "install", pkg], {
    cwd: comfyuiPath,
    encoding: "utf-8",
    timeout: 600_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (out ?? "").trim();
}

/** uv refuses to install into an interpreter that is not a virtual environment
 *  unless told to. A ComfyUI running from a system Python (no .venv) hits exactly
 *  this — `uv pip install --python <sys python>` fails with "No virtual
 *  environment found ... pass --system" (#377). Recognize that message so we can
 *  fall back to the interpreter's own pip, which installs correctly with no venv. */
function isUvNonVenvError(text: string): boolean {
  return /No virtual environment found|not a virtual environment|pass `?--system|run `?uv venv/i.test(
    text,
  );
}

/**
 * #1508 — PEP 668: the interpreter declares itself EXTERNALLY MANAGED, so its own
 * pip refuses to install into it. Stability Matrix's uv-managed CPython does
 * exactly this:
 *
 *   error: externally-managed-environment
 *   This Python installation is managed by uv and should not be modified.
 *
 * Keyed on the PEP's own error id first (`externally-managed-environment`, the
 * literal pip emits) and the prose form second, because the second line is
 * supplied by the distributor's EXTERNALLY-MANAGED file and therefore says
 * something different on Debian, Homebrew, and uv. Matching only the uv wording
 * would have fixed this reporter and no one else.
 */
function isExternallyManagedError(text: string): boolean {
  return (
    // pip's canonical PEP 668 error IDENTIFIER. Stable across distributors —
    // the line under it is the distributor's prose and says something different
    // on Debian, Homebrew and uv, so keying on that would have fixed one
    // reporter and nobody else.
    // Anchored to the START OF A LINE, which is where pip prints it:
    //   error: externally-managed-environment
    // (measured). An unanchored match would fire on any output that merely
    // CONTAINS the token — a file path, a package name, a vendored log line —
    // and rewrite an unrelated failure as this one, discarding its real cause
    // (codex P2).
    /^\s*error: externally-managed-environment/im.test(text) ||
    // uv's own refusal, which uses no error id:
    //   error: The interpreter at <path> is externally managed, and indicates ...
    // Anchored on "interpreter at ... is externally managed" rather than the bare
    // phrase (codex P2): plain "externally managed" appears in ordinary build and
    // dependency output, and matching it would rewrite an unrelated failure as a
    // managed-environment story — discarding the real cause behind a remedy that
    // does not apply. Both forms below were MEASURED against uv 0.11.21 and a
    // uv-managed CPython 3.12.13, not transcribed from documentation.
    /interpreter at .+ is externally managed/i.test(text)
  );
  // WHICH WAY THIS FAILS MATTERS, and it is chosen deliberately (codex P2, the
  // opposite direction). PEP 668 requires only that the installer error out; it
  // does not mandate pip's renderer token, so a distributor-patched or localized
  // installer can refuse in wording neither pattern above matches.
  //
  // That miss is the SAFE failure. It surfaces the installer's own error
  // unchanged — exactly today's behaviour, no regression — and that error already
  // names PEP 668 itself. The reader loses this message's extra guidance and
  // nothing else. The opposite error, matching too eagerly, REPLACES a real cause
  // with a remedy that does not apply, which is strictly worse than saying
  // nothing. So this stays tight and is widened only against a refusal someone
  // has actually seen.
}

/** Cap the installer's own output carried into a refusal. Enough to diagnose,
 *  bounded so a verbose failure cannot swamp the actionable part. */
/**
 * Mask credentials embedded in a URL's userinfo (`https://user:token@host/...`).
 *
 * A pip entry may legitimately BE such a URL — `validatePipPackageSpec` only
 * rejects options, control characters and whitespace — so the spec itself is a
 * secret-bearing string, not just the command line built around it. Applied to
 * everything this refusal renders: the package name it echoes AND the installer
 * output it carries, since pip prints the URL it is fetching.
 */
function redactUrlCredentials(text: string): string {
  // Userinfo runs from `://` to the LAST `@` before the path, and may contain
  // BOTH ':' and '@' in the password — `https://u:alpha@beta@host` is a valid URL
  // whose password is `alpha@beta`. An earlier version stopped at the FIRST `@`
  // ([^/\s@]+@) and so rendered that as `https://***:***@beta@host`, leaking half
  // the secret while looking redacted (codex P1).
  //
  // `[^/\s]*` is GREEDY and cannot cross `/` or whitespace, so it runs to the
  // last `@` within the authority and no further.
  return text.replace(/(\w+:\/\/)[^/\s]*@/g, (_m, scheme: string) => `${scheme}***:***@`);
}

function clipInstallerOutput(text: string): string {
  const cleaned = text.replace(/\r/g, "").split("\n").filter((l) => l.trim()).join("\n").trim();
  return cleaned.length > 1200 ? `${cleaned.slice(0, 1200)}\n… (truncated)` : cleaned;
}

/** Both pip and uv write the refusal to stderr, but a non-zero exit from
 *  execFileSync carries it across `stderr`, `stdout` and `message` inconsistently
 *  depending on how the child died — so every failure is read from all three. */
function errorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
  return `${e?.stderr?.toString() ?? ""}\n${e?.stdout?.toString() ?? ""}\n${e?.message ?? ""}`;
}

/**
 * The installer's OWN output — stderr and stdout only, deliberately WITHOUT
 * `Error.message`.
 *
 * Node builds that message as `Command failed: <the whole argv>`, so it embeds
 * the package spec. A pip spec may legitimately be a direct URL, and a direct URL
 * may carry credentials (`https://user:token@host/pkg.whl`) — that entry passes
 * `validatePipPackageSpec`, which only rejects options, control characters and
 * whitespace. Echoing the command back into a user-facing refusal would copy the
 * token into it.
 *
 * `errorText` still includes the message, because DETECTION wants the breadth (a
 * child that dies before writing to a stream can leave the reason only there).
 * What gets shown is narrower than what gets matched, which is the right way
 * round.
 */
function installerOutput(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stdout?: Buffer | string; stderr?: Buffer | string };
  return `${e?.stderr?.toString() ?? ""}\n${e?.stdout?.toString() ?? ""}`;
}

/**
 * #1508 — the refusal, said in a way that can be acted on.
 *
 * Deliberately does NOT reach for `--break-system-packages`, which is the
 * reporter's own caution and the right one: on a uv-managed interpreter that
 * writes into an environment uv owns and may later reset, converting a clean
 * refusal into a silent, delayed breakage of their ComfyUI install. A refusal
 * that names the two supported routes is worth more than a write that appears to
 * work.
 */
function externallyManagedRefusal(pkg: string, python: string, output = ""): string {
  // The installer's OWN output is carried through (codex P2). This refusal
  // replaces the underlying error rather than wrapping it, and apply_manifest
  // reports only `err.message` per item — so without this the actual diagnostic
  // is gone, and an earlier draft even claimed it was "above" when nothing had
  // been printed. Anything the tool said that this message does not anticipate
  // would have been lost silently.
  // REDACT, then clip — never the other way round (codex P1). Clipping first can
  // sever the `@` that the redaction pattern anchors on, so a secret sitting near
  // the cut survives as `https://u:token` in a message that looks sanitised.
  const detail = clipInstallerOutput(redactUrlCredentials(output));
  return (
    (detail ? `${detail}\n\n` : "") +
    `Refusing to install "${redactUrlCredentials(pkg)}": the Python that ComfyUI runs (${python}) declares itself ` +
    `EXTERNALLY MANAGED (PEP 668), so nothing may install into it directly. This is normal for a ` +
    `uv-managed install (Stability Matrix) and for distro Pythons on Linux — a deliberate guard, ` +
    `not a broken interpreter.\n\n` +
    `uv does NOT get around this: \`uv pip install --python "${python}"\` is refused by uv too, ` +
    `with "the interpreter ... is externally managed". Measured, not assumed — so do not spend ` +
    `time on it.\n\n` +
    `What actually works — the environment needs to be a VIRTUAL one:\n` +
    `  - if your launcher owns this install (Stability Matrix), add the package through its own ` +
    `Python-packages UI, which installs into the environment it manages for ComfyUI;\n` +
    `  - or create a venv and run ComfyUI from it: \`uv venv <dir>\` (uv's own suggestion for ` +
    `exactly this error), install there, then set COMFYUI_PYTHON to that interpreter and restart ` +
    `ComfyUI through this server so the manifest installs into it.\n\n` +
    `WORTH CHECKING FIRST: if ComfyUI already runs from a virtual environment, then the ` +
    `interpreter above is the wrong one — a base install picked up instead of the venv — and the ` +
    `fix is to point COMFYUI_PYTHON at the venv rather than to change anything about packaging. ` +
    `The path in this message is the one to compare against.\n\n` +
    `Not doing it for you: pip offers \`--break-system-packages\` and this refuses to pass it. On ` +
    `a uv-managed interpreter that writes into an environment uv owns and may later reset, which ` +
    `turns a clear failure now into a broken ComfyUI later. That stays a decision you make ` +
    `deliberately, not one inherited from a manifest.`
  );
}

async function installPipPackage(
  pkg: string,
  comfyuiPath: string,
): Promise<InstallInterpreterResolution> {
  validatePipPackageSpec(pkg);
  const resolved = await resolveWorkspacePython(comfyuiPath);
  if (!resolved.python) {
    throw new ValidationError(
      `Refusing to install "${redactUrlCredentials(pkg)}". ${resolved.reason} Set COMFYUI_PYTHON to the interpreter ComfyUI runs with, or restart ComfyUI through this MCP server and retry.`,
    );
  }
  const python = resolved.python;
  const useUv = commandExists("uv");

  if (!useUv) {
    logger.info("Installing manifest Python package", { package: redactUrlCredentials(pkg), installer: "pip" });
    try {
      runPythonPipInstall(python, pkg, comfyuiPath);
    } catch (err) {
      // #1508 — THE reporter's path. Stability Matrix bundles uv inside its own
      // directory rather than on PATH, so `useUv` is false and we come straight
      // here — into an interpreter whose pip refuses by design (PEP 668).
      if (isExternallyManagedError(errorText(err))) {
        throw new ValidationError(externallyManagedRefusal(pkg, python, installerOutput(err)));
      }
      throw err;
    }
    return resolved;
  }

  logger.info("Installing manifest Python package", { package: redactUrlCredentials(pkg), installer: "uv" });
  try {
    const out = execFileSync("uv", ["pip", "install", "--python", python, pkg], {
      cwd: comfyuiPath,
      encoding: "utf-8",
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    void out;
    return resolved;
  } catch (err) {
    const detail = errorText(err);
    // #1508 — checked BEFORE the #377 fallback. uv's non-venv message and a PEP
    // 668 refusal can both appear on a managed interpreter, and falling back to
    // bare pip there walks straight into the same wall one step later, burying
    // the real reason under a second failure.
    if (isExternallyManagedError(detail)) {
      throw new ValidationError(externallyManagedRefusal(pkg, python, installerOutput(err)));
    }
    if (isUvNonVenvError(detail)) {
      // System-Python ComfyUI (no venv): uv can't use the interpreter directly.
      // The interpreter's own pip installs into that exact environment, which is
      // what we want (#377).
      logger.info(
        "uv rejected the non-venv ComfyUI interpreter; falling back to `python -m pip install`",
        { package: redactUrlCredentials(pkg) },
      );
      try {
        runPythonPipInstall(python, pkg, comfyuiPath);
      } catch (err2) {
        // The fallback's OWN refusal (#1508). Reported as the managed-environment
        // case it is, not as a bare pip error, so the caller is not left reading
        // uv's non-venv complaint as the cause.
        // `err2`, NOT `err`. The output carried into the refusal must be the one
        // that actually refused — pip's. Attaching uv's earlier non-venv complaint
        // here is precisely the misdirection this branch exists to prevent, and it
        // would send the reader off to create a venv for the wrong reason.
        if (isExternallyManagedError(errorText(err2))) {
          throw new ValidationError(externallyManagedRefusal(pkg, python, installerOutput(err2)));
        }
        throw err2;
      }
      return resolved;
    }
    throw err;
  }
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function maybeGitModuleName(value: string): string | undefined {
  if (!/^(https?:\/\/|git@|git\+)/i.test(value) && !value.endsWith(".git")) {
    return undefined;
  }
  const withoutRef = value.replace(/(?<!^)@[^@/]+$/, "");
  const stripped = withoutRef.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const pathPart = stripped.includes(":") && !stripped.includes("://")
    ? stripped.slice(stripped.lastIndexOf(":") + 1)
    : stripped;
  return basename(pathPart).replace(/\.git$/i, "").toLowerCase();
}

function nodeAlreadyInstalled(id: string, installed: InstalledNode[]): boolean {
  const wanted = normalizeId(id);
  const gitModule = maybeGitModuleName(id);
  return installed.some((node) => {
    const candidates = [
      node.module,
      node.cnrId,
      node.auxId,
    ]
      .filter((v): v is string => Boolean(v))
      .map(normalizeId);
    return candidates.includes(wanted) || (gitModule ? candidates.includes(gitModule) : false);
  });
}

function defaultFilenameForUrl(url: string): string {
  return basename(new URL(url).pathname) || "model.safetensors";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function rejectEscapingSymlinkTarget(
  root: string,
  path: string,
  label: string,
): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return;
    const realTarget = await realpath(path);
    if (!isWithinRoot(root, realTarget)) {
      throw new ValidationError(`${label} escapes the models directory: ${path}`);
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // Missing final target is fine; downloadModel will create it.
  }
}

async function validateExistingModelAncestors(
  root: string,
  parent: string,
  realRoot: string,
  localPath: string,
): Promise<void> {
  let cursor = parent;
  while (cursor !== root && cursor.startsWith(root + sep)) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        const realCursor = await realpath(cursor);
        if (!isWithinRoot(realRoot, realCursor)) {
          throw new ValidationError(
            `Model local_path escapes the models directory: ${localPath}`,
          );
        }
      } else if (!info.isDirectory()) {
        throw new ValidationError(`Model local_path parent is not a directory: ${localPath}`);
      }
      return;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      cursor = dirname(cursor);
    }
  }
}

async function resolveLocalModelPath(
  model: ComfyManifest["models"][number],
): Promise<{ targetSubfolder: string; filename: string; targetPath: string }> {
  // Root the target — and therefore the local_path symlink/containment guards
  // below — at the SAME directory the downloader actually writes to: the live
  // connected server's models dir (resolveModelsDir, live-first), NOT
  // <COMFYUI_PATH>/models. When the connected install differs from a stale
  // COMFYUI_PATH (#490), validating against COMFYUI_PATH/models would leave a
  // symlink that escapes the LIVE models dir unchecked and redirect the write
  // outside it. Same canonical root as the writer = one authoritative guard.
  const root = resolve(await resolveModelsDir());

  if (model.local_path) {
    if (isAbsolute(model.local_path)) {
      throw new ValidationError(
        `Model local_path must be relative to models/: ${model.local_path}`,
      );
    }
    const targetPath = resolve(root, model.local_path);
    const rel = relative(root, targetPath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    if (!targetPath.startsWith(root + sep)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    const filename = basename(targetPath);
    if (filename === "." || filename === ".." || filename.length === 0) {
      throw new ValidationError(`Model local_path must include a filename: ${model.local_path}`);
    }
    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    await validateExistingModelAncestors(root, dirname(targetPath), realRoot, model.local_path);
    await mkdir(dirname(targetPath), { recursive: true });
    const realParent = await realpath(dirname(targetPath));
    if (!isWithinRoot(realRoot, realParent)) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    await rejectEscapingSymlinkTarget(realRoot, targetPath, "Model local_path");
    return {
      targetSubfolder: dirname(rel),
      filename,
      targetPath,
    };
  }

  const targetSubfolder: ModelType = model.model_type ?? "checkpoints";
  const filename = model.filename ?? defaultFilenameForUrl(model.url);
  return {
    targetSubfolder,
    filename,
    targetPath: join(root, targetSubfolder, filename),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Decide whether a manifest model already exists locally, honoring EVERY model
 * root ComfyUI loads from — not just the single computed target under
 * `<COMFYUI_PATH>/models`. ComfyUI resolves models across the primary install
 * PLUS the extra roots declared in extra_model_paths.yaml / extra_models_config
 * (commonly on another drive, e.g. E:\). Checking only the computed path
 * re-downloads a large model the user already has under an alternate root.
 *
 * Returns the path where the file was found (absolute for filesystem hits, or a
 * ComfyUI-relative `category/name` for HTTP hits), or undefined if it exists in
 * no root. Best-effort and NEVER throws: any resolver failure (ComfyUI
 * unreachable, no extra roots, cloud mode) is swallowed and we fall back to the
 * single-path check, so a legitimate install is never blocked.
 *
 * Reuses the existing multi-root machinery:
 *  - `resolveExistingModelFile` (model-resolver, #58/#60) — exact relative-path
 *    lookup across the primary root AND every extra_model_paths root, scoped per
 *    category, with the project's containment/symlink guards.
 *  - `listLocalModels` — the category listing ComfyUI actually serves over HTTP
 *    (aggregates symlinked/extra roots and nested subfolders; also works in
 *    remote mode), with a filesystem fallback.
 */
async function findExistingModel(target: {
  targetSubfolder: string;
  filename: string;
  targetPath: string;
}): Promise<string | undefined> {
  // 1. Baseline single-path check (the original behavior). Always safe and is
  //    the source of truth when no extra roots / HTTP are reachable.
  if (await fileExists(target.targetPath)) return target.targetPath;

  // 2. Exact relative-path lookup across the primary models/ root AND every
  //    extra_model_paths root. The category scoping inside the resolver keeps a
  //    `.safetensors` checkpoint from matching a same-named file under loras/.
  const relativePath = (
    target.targetSubfolder && target.targetSubfolder !== "."
      ? `${target.targetSubfolder}/${target.filename}`
      : target.filename
  ).replace(/\\/g, "/");
  try {
    const found = await resolveExistingModelFile(relativePath);
    if (found.info.isFile()) return found.path;
  } catch {
    // Not found in any root, comfyuiPath unset, or traversal — fall through.
  }

  // 3. Match within the category across all roots ComfyUI serves (when running,
  //    the HTTP-aggregated view of extra/symlinked roots; remote setups; and a
  //    filesystem fallback). Category-scoped, so cross-category same-name files
  //    are never mistaken for a match.
  //
  //    The match precision depends on where the target lives:
  //    - CATEGORY ROOT target (e.g. model_type: checkpoints, or local_path
  //      "checkpoints/foo.safetensors"): the intent is "do I already have this
  //      file anywhere in the served category?", so match by basename anywhere
  //      (also catches a model the user stored under a nested subfolder).
  //    - NESTED target (e.g. local_path "checkpoints/foo/model.safetensors"):
  //      the manifest asks for that EXACT relative location. Matching by
  //      basename here would false-skip when only a same-named file under a
  //      DIFFERENT subfolder exists, leaving the requested file absent. So
  //      require an exact category-relative path match instead.
  const subSegments = target.targetSubfolder.split(/[/\\]+/).filter(Boolean);
  const category = subSegments[0];
  if (category && (MODEL_SUBDIRS as readonly string[]).includes(category)) {
    const isCategoryRoot = subSegments.length === 1;
    // The category-relative path implied by the target (strip the leading
    // category segment), normalized to forward slashes for comparison.
    const relWithinCategory = [...subSegments.slice(1), target.filename].join("/");
    try {
      const local = await listLocalModels(category);
      const hit = local.find((m) => {
        const name = m.name.replace(/\\/g, "/");
        return isCategoryRoot
          ? basename(name) === target.filename
          : name === relWithinCategory;
      });
      if (hit) return hit.path;
    } catch {
      // Listing unavailable — fall through to download.
    }
  }

  return undefined;
}

function report(
  action: ManifestAction,
  item: string,
  status: ManifestItemStatus,
  message: string,
): ManifestItemReport {
  // `item` is echoed back verbatim from the manifest, and a pip entry or a model
  // URL may legitimately carry credentials in its userinfo. Redacting only the
  // MESSAGE left the secret in the structured result — which is what actually
  // travels into transcripts and logs (codex, and my own test asserted the
  // narrower claim while believing the wider one).
  //
  // The entry stays identifiable: only the userinfo is masked, so the host and
  // path a reader matches on are untouched.
  //
  // `message` too, and this is the CHOKE POINT that closes the class rather than
  // the instances (codex r4). An ordinary, non-PEP-668 failure is rethrown raw by
  // design — that is the right call for diagnosis — and the caller reports
  // `err.message`, which Node builds as `Command failed: <whole argv>`. So every
  // pip failure that ISN'T the case this issue is about was still echoing the
  // spec. Redacting here covers those, the model and custom-node paths, and any
  // future one, instead of requiring each new call site to remember.
  return {
    action,
    item: redactUrlCredentials(item),
    status,
    message: redactUrlCredentials(message),
  };
}

/**
 * Derive ComfyUI-Manager install-model params from a manifest model entry for
 * REMOTE mode (no local filesystem). Honors `local_path` (its first segment is
 * the model dir, the rest is the relative save path) and `model_type`/`filename`
 * the same way the local resolver does, with the same anti-traversal guards.
 */
function remoteModelTarget(model: ComfyManifest["models"][number]): {
  name: string;
  type: string;
  save_path: string;
  filename: string;
  /** OUR canonical category folder — for the panel download-tray watcher. */
  category: string;
} {
  if (model.local_path) {
    if (isAbsolute(model.local_path)) {
      throw new ValidationError(
        `Model local_path must be relative to models/: ${model.local_path}`,
      );
    }
    const segments = model.local_path.split(/[/\\]+/).filter(Boolean);
    if (segments.length === 0 || segments.includes("..")) {
      throw new ValidationError(
        `Model local_path escapes the models directory: ${model.local_path}`,
      );
    }
    const filename = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    if (dirSegments.length === 0) {
      throw new ValidationError(
        `Model local_path must include a category subfolder (e.g. 'checkpoints/foo.safetensors'): ${model.local_path}`,
      );
    }
    // Map our category folder to a Manager-valid { type, save_path }. Nested
    // paths are handed to Manager verbatim; top-level categories resolve via the
    // type-map ("default") or fall back to the folder name.
    const { type, save_path } = managerModelDestination(
      dirSegments[0],
      dirSegments.length > 1 ? dirSegments.join("/") : undefined,
    );
    return { name: filename, type, save_path, filename, category: dirSegments[0] };
  }

  const category: ModelType = model.model_type ?? "checkpoints";
  const filename = model.filename ?? defaultFilenameForUrl(model.url);
  const { type, save_path } = managerModelDestination(category);
  return { name: filename, type, save_path, filename, category };
}

/**
 * #390: resolve a saved default workspace to adopt as the local FS target for
 * THIS apply_manifest call, WITHOUT persisting it process-wide. Returns a path
 * only when: we are in local mode (a loopback/local ComfyUI, not remote/cloud),
 * COMFYUI_PATH is unset, and the saved default (what install_comfyui (action:"environment") resolves)
 * both exists and looks like a ComfyUI install (has models/ or custom_nodes/).
 * The connected server is local (isRemoteMode() === false), so the saved default
 * is a valid local mirror of it. Returns undefined otherwise.
 */
function adoptableLocalWorkspace(): string | undefined {
  if (config.comfyuiPath || isRemoteMode()) return undefined;
  const saved = getSavedDefaultWorkspaceSync();
  if (
    saved &&
    existsSync(saved) &&
    (existsSync(join(saved, "models")) || existsSync(join(saved, "custom_nodes")))
  ) {
    return saved;
  }
  return undefined;
}

async function installedNodesOrEmpty(): Promise<InstalledNode[]> {
  try {
    return await listInstalledNodes();
  } catch (err) {
    logger.warn("Could not list installed custom nodes before manifest apply", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function applyManifest(
  opts: ApplyManifestOptions,
): Promise<ApplyManifestResult> {
  const manifest = await resolveManifest(opts);

  // Resolve the LOCAL ComfyUI base this call should target, WITHOUT mutating the
  // process-global config.comfyuiPath (a global temp-set would leak the path to
  // every concurrent tab/tool and could be clobbered by an interleaved restore —
  // #490/#463 codex review). We thread it explicitly to applyManifestSections
  // instead. Precedence, local mode only:
  //   1. config.comfyuiPath (COMFYUI_PATH / auto-detect) — unchanged, wins.
  //   2. saved default workspace (#390).
  //   3. the LIVE connected server's own install root from /system_stats argv
  //      (#463) — a panel-connected local session with no COMFYUI_PATH still has
  //      a real FS target, so models/pip aren't skipped as "no local filesystem".
  // The actual on-disk model DESTINATION is always re-derived live-first by the
  // downloader (resolveModelsDir), so this base only governs the local-vs-remote
  // classification + pip's interpreter, never where a model lands.
  const localBase = await resolveLocalManifestBase();

  return applyManifestSections(manifest, localBase);
}

/**
 * The effective LOCAL ComfyUI base for an apply_manifest call. Never mutates
 * global config. Returns undefined in remote/cloud mode or when no local install
 * can be found (COMFYUI_PATH unset, no saved default, no reachable live server).
 */
async function resolveLocalManifestBase(): Promise<string | undefined> {
  if (config.comfyuiPath) return config.comfyuiPath;
  if (isRemoteMode()) return undefined;
  const saved = adoptableLocalWorkspace();
  if (saved) return saved;
  // #463: a live LOCAL ComfyUI is connected but COMFYUI_PATH/default are unset.
  // Adopt its own install root (from /system_stats argv) only when it exists and
  // looks like a ComfyUI install.
  const liveBase = await resolveLiveComfyUIBase();
  if (
    liveBase &&
    existsSync(liveBase) &&
    (existsSync(join(liveBase, "models")) ||
      existsSync(join(liveBase, "custom_nodes")))
  ) {
    logger.info(
      "apply_manifest: targeting the live connected ComfyUI root for this call (COMFYUI_PATH unset)",
      { path: liveBase },
    );
    return liveBase;
  }
  return undefined;
}

async function applyManifestSections(
  manifest: ComfyManifest,
  localBase: string | undefined,
): Promise<ApplyManifestResult> {
  const results: ManifestItemReport[] = [];

  // Per-section mode handling. A LOCAL filesystem is usable only when we are NOT
  // in remote (or cloud) mode AND a local base was resolved (COMFYUI_PATH, saved
  // default, or the live connected server's own root — see resolveLocalManifestBase,
  // threaded here as `localBase` WITHOUT any global config mutation). Otherwise we
  // are targeting a remote/cloud ComfyUI over HTTP. Keying off isRemoteMode()
  // (rather than mere base presence) matters because a remote target can coexist
  // with an unrelated COMFYUI_PATH on this machine — in that case we must still
  // route pip/model handling remotely instead of touching the local install/disk.
  // custom_nodes and models can still be handled remotely through ComfyUI-Manager's
  // HTTP API, but pip/apt have no remote equivalent.
  const comfyuiPath = localBase;
  const hasLocalFs = !isRemoteMode() && Boolean(comfyuiPath);

  for (const pkg of manifest.apt) {
    results.push(
      report(
        "apt",
        pkg,
        "skipped",
        hasLocalFs
          ? "System packages must be installed manually or with root privileges; apply_manifest does not run apt."
          : "System packages are not supported against a remote ComfyUI (no local shell/root access); install them on the ComfyUI host.",
      ),
    );
  }

  for (const pkg of manifest.pip) {
    if (!hasLocalFs) {
      results.push(
        report(
          "pip",
          pkg,
          "skipped",
          "Python package install is not supported against a remote ComfyUI (no local filesystem/venv); install it on the ComfyUI host.",
        ),
      );
      continue;
    }
    try {
      const resolved = await installPipPackage(pkg, comfyuiPath!);
      results.push(report("pip", pkg, "applied", `Python package installed. ${resolved.reason}`));
    } catch (err) {
      results.push(
        report(
          "pip",
          pkg,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  // #489: bound the whole custom-node phase by a wall-clock budget. Each install
  // drives the shared ComfyUI-Manager queue, which can legitimately run for
  // minutes on a big pack; blocking until every one drains overruns the MCP
  // tools/call timeout (300s) and the caller sees a FALSE failure while the
  // Manager keeps installing. So we mirror the model-download grace pattern:
  // install sequentially, but RACE each install against the remaining budget. If
  // the budget wins, the install keeps running SERVER-SIDE (we stop awaiting it,
  // swallowing its late result) and is reported "pending" — never failed — and
  // every not-yet-started node is reported "pending" too. The caller polls the
  // Manager queue / re-runs apply_manifest to finish. A node that SETTLES within
  // budget is verified and reported applied/failed exactly as before.
  const nodeDeadline = Date.now() + manifestNodeBudgetMs();
  const pendingBudgetMessage = (started: boolean): string =>
    started
      ? "Still installing on the ComfyUI-Manager queue when the apply_manifest time " +
        "budget elapsed. This is NOT a failure — the install continues server-side. " +
        "Poll the Manager queue for completion; do not re-issue this node."
      : "Not started: the apply_manifest time budget elapsed while ComfyUI-Manager " +
        "was still installing earlier packs. This is NOT a failure — poll the " +
        "Manager queue for completion, then re-run apply_manifest to continue.";
  let nodeBudgetSpent = false;
  // Even the INITIAL installed-list probe is budget-bounded — a hung Manager here
  // must not blow the tools/call timeout before we can report anything.
  const initialList = await raceDeadline(installedNodesOrEmpty(), nodeDeadline);
  const installedNodes = initialList === BUDGET_TIMEOUT ? [] : initialList;
  if (initialList === BUDGET_TIMEOUT) nodeBudgetSpent = true;
  for (const id of manifest.custom_nodes) {
    const isPanelTarget = targetsPanelPackExactly(id);
    if (isPanelTarget) {
      // `apply_manifest` has a Manager target but no authoritative association
      // between that target and a local served-panel root. In particular,
      // config.comfyuiPath may name loopback instance A while Manager targets B.
      // Refuse rather than pre/post-scan A around a mutation of B, or report a
      // Manager-installed-list entry as browser-visible success.
      results.push(
        report(
          "custom_node",
          id,
          "failed",
          "apply_manifest does not manage the sidebar panel because it cannot prove that its " +
            "ComfyUI-Manager target and local served-panel filesystem are the same instance. " +
            "Use install_comfyui(action:'panel') on the selected ComfyUI host, which verifies the served version and .bak shadows.",
        ),
      );
      continue;
    }
    if (nodeAlreadyInstalled(id, installedNodes)) {
      results.push(report("custom_node", id, "skipped", "Custom node is already installed."));
      continue;
    }
    if (nodeBudgetSpent || Date.now() >= nodeDeadline) {
      nodeBudgetSpent = true;
      results.push(report("custom_node", id, "pending", pendingBudgetMessage(false)));
      continue;
    }

    // Never REJECTS: fold success/failure into a tagged value so the un-awaited
    // promise (when the deadline wins) can't surface as an unhandled rejection.
    // Thread the call-scoped local base (no global config mutation) so the
    // git-clone / ref-checkout fallback works for an adopted saved-default/live
    // workspace when COMFYUI_PATH is unset (#463).
    const installOutcome = installCustomNode({ id, comfyuiPath: localBase })
      .then((res) => ({ kind: "settled" as const, res }))
      .catch((err) => ({ kind: "error" as const, err }));
    const outcome = await raceDeadline(installOutcome, nodeDeadline);

    if (outcome === BUDGET_TIMEOUT) {
      // Budget spent mid-install: leave it running server-side (installOutcome
      // already has a .catch, so its eventual settle is safely ignored) and stop
      // blocking on the remaining nodes.
      nodeBudgetSpent = true;
      results.push(report("custom_node", id, "pending", pendingBudgetMessage(true)));
      continue;
    }
    if (outcome.kind === "error") {
      results.push(
        report(
          "custom_node",
          id,
          "failed",
          outcome.err instanceof Error ? outcome.err.message : String(outcome.err),
        ),
      );
      continue;
    }
    // ComfyUI-Manager marks a git-URL task "done" (queue drained) even when it
    // cloned NOTHING — e.g. a repo not in its registry resolves to nothing, no
    // dir is created, but the queue still empties cleanly. So a successful
    // installCustomNode() call is NOT proof of install. Re-query the installed
    // list (it reflects on-disk custom_nodes via Manager's
    // /v2/customnode/installed, so a freshly-cloned node shows up even before a
    // reboot) and confirm the node is actually present before reporting success.
    // Budget-bounded too: if the confirm can't complete in time we report pending
    // (conservative — the install itself already settled) rather than overrun.
    const verified = await raceDeadline(installedNodesOrEmpty(), nodeDeadline);
    if (verified === BUDGET_TIMEOUT) {
      nodeBudgetSpent = true;
      results.push(report("custom_node", id, "pending", pendingBudgetMessage(true)));
      continue;
    }
    if (nodeAlreadyInstalled(id, verified)) {
      installedNodes.length = 0;
      installedNodes.push(...verified);
      results.push(report("custom_node", id, "applied", outcome.res.message));
    } else {
      results.push(
        report(
          "custom_node",
          id,
          "failed",
          `ComfyUI-Manager reported the install as queued/done, but the node is not present afterward — the source likely resolved to nothing (a git URL that isn't in the Manager registry won't clone). Install it directly (git clone into custom_nodes) or use a registry id. ${outcome.res.message}`,
        ),
      );
    }
  }

  // #362: enqueue ALL local model downloads to the background job registry FIRST
  // (no per-model blocking), then await ONE short grace window across the whole
  // batch. A big pack has many multi-GB files; awaiting each sequentially — even
  // with a per-file grace — scales with the number of models and blows past the
  // 300s tools/call timeout. A single batch-wide grace is bounded regardless of
  // count: quick/local files finish inside it (reported "applied"), the rest keep
  // streaming and are reported "pending" with a job id to poll via
  // download_model action:"status". A still-running download is NEVER counted as "applied", so
  // top-level success never claims an unfinished download succeeded.
  const enqueued: Array<{
    item: string;
    job: DownloadJob;
    settled: Promise<void>;
    /** #1298 — a proven-irrelevant same-named file, noted on the applied item. */
    staleOutsideLiveRoots?: string;
  }> = [];
  for (const model of manifest.models) {
    const item = model.local_path ?? model.filename ?? model.url;
    try {
      if (!hasLocalFs) {
        // REMOTE: no local filesystem to scan/write. Route the download to the
        // ComfyUI host via ComfyUI-Manager's install-model task (server-side
        // fetch, returns at handoff). Cloud mode has no Manager, so report it as
        // unsupported.
        if (!isRemoteMode()) {
          results.push(
            report(
              "model",
              item,
              "skipped",
              "Model install is not supported against this ComfyUI (no local filesystem and no ComfyUI-Manager HTTP API); install it on the ComfyUI host.",
            ),
          );
          continue;
        }
        const { name, type, save_path, filename, category } = remoteModelTarget(model);
        const res = await installModelViaManager({
          name,
          url: model.url,
          filename,
          type,
          save_path,
          // Panel tray: watch the canonical category for the file to land (#143).
          trayCategory: category,
        });
        // A Manager dispatch is ACCEPTED, not landed — Manager reports its queue task
        // done even on failure, and there is no local file to verify. Reporting that
        // as "applied" is the same fabricated success #369 is about, so it is PENDING
        // with the caveat spelled out (codex gate, round 2).
        results.push(
          report(
            "model",
            item,
            "pending",
            `${res.message} NOTE: the dispatch was ACCEPTED, NOT verified as landed — ` +
              "ComfyUI-Manager reports its queue task 'done' even on failure. Confirm with " +
              "list_local_models before relying on it.",
          ),
        );
        continue;
      }
      const target = await resolveLocalModelPath(model);
      const existing = await findExistingModel(target);
      // #1298 — set when a found file is PROVEN to be outside every tree the
      // live server reads. It is then irrelevant, and rides along as a note on
      // the download rather than vetoing it.
      let staleOutsideLiveRoots: string | undefined;
      if (existing) {
        // "Already exists" is only a legitimate SKIP if the running ComfyUI can
        // actually load it. On a locally-configured (non-live-resolved) models root
        // an old file in a STALE install would otherwise satisfy the manifest while
        // the live server has never seen it — the #369 failure, reached through the
        // existing-file shortcut instead of a download (codex gate, round 3).
        // Prefer the DECISIVE test when it is available: is the file we found
        // physically inside a tree the running server reads? A name-only listing
        // check cannot tell a stale `C:\Stale\...\x.safetensors` from the live
        // server's own `D:\Live\...\x.safetensors` (codex gate, round 5).
        // ONLY a positive containment result licenses the skip. A name-only listing
        // hit cannot tell a stale `C:\Stale\...\x.safetensors` from the live server's
        // OWN `D:\Live\...\x.safetensors`, so it may never promote an unconfirmed
        // answer to "installed" (codex gate, round 8) — it is reported as a
        // diagnostic on the pending item instead.
        const visible = (
          await isUnderLiveModelRoots(
            existing,
            target.targetSubfolder.split(/[\\/]+/).filter(Boolean)[0],
          )
        ).inRoots;
        // #1298 — a PROVEN-irrelevant file is not evidence about anything.
        //
        // #369 made this FAIL, which fixed a false SKIP: a stale same-named file
        // used to satisfy the manifest while the live server had never seen it,
        // and the render failed later. That was the right call about SKIPPING.
        // But failing is a third thing, and it vetoes a download that has
        // nothing wrong with it — the live models root resolved correctly, and a
        // leftover in an install the server does not read cannot make writing to
        // the right place unsafe. The old remedy even told the user to repoint
        // COMFYUI_PATH, which they cannot act on when it is already correct.
        //
        // So: fall through to the download, carrying the stale path as a NOTE.
        // #369's requirement is preserved — the item is satisfied only if the
        // DOWNLOAD succeeds, never by the mere existence of a file somewhere.
        if (visible === false) {
          staleOutsideLiveRoots = existing;
        } else if (visible === undefined) {
          // #1587 — containment could not answer, and about THIS question it never
          // could. `isUnderLiveModelRoots` compares `existing` against a models root
          // the running server did not name (`modelsDirNamedByServer`); it never
          // consults the server's own listing. Deriving `pending` from that silence
          // overruled the one source that CAN answer — /models — with a source
          // structurally blind to it, and then said so in a message that told the
          // user their install root "could only be inferred from local
          // configuration". That is not what `undefined` means here: an
          // OS-process-observed root (ComfyUI Desktop's shape, where the interpreter
          // is identified from the process table serving our port) lands in exactly
          // this bucket, and the file was often FOUND by the server's own listing in
          // the first place (findExistingModel step 3).
          //
          // So ask what the manifest actually needs to know — does the running server
          // already have this model? — and let the server answer it. Precision
          // mirrors findExistingModel: a category-root target is satisfied by the
          // basename anywhere in the category, a nested target by the exact
          // category-relative path.
          //
          // This does NOT weaken #369. #369's failure is a stale same-named file
          // satisfying the manifest while the live server has never seen it — there
          // the server does NOT list the entry, so this branch still reports pending
          // and the download still runs. What is dropped is only the claim that the
          // local copy is the served one, which the note now STATES instead of the
          // verdict asserting its opposite.
          const nested = target.targetSubfolder.split(/[\\/]+/).filter(Boolean).length > 1;
          const listed = nested
            ? await liveListingHasEntry(target.targetSubfolder, target.filename)
            : await liveListingHasBasename(target.targetSubfolder, target.filename);
          results.push(
            listed === true
              ? report(
                  "model",
                  item,
                  "skipped",
                  `The connected ComfyUI already serves "${target.filename}" in ` +
                    `"${target.targetSubfolder}", so the manifest's model is present for it. ` +
                    "NOTE: containment could not be established — the running server did not " +
                    `name its models root — so it is NOT confirmed that the copy at ${existing} ` +
                    "is the one it serves.",
                )
              : report(
                  "model",
                  item,
                  "pending",
                  `A file exists at ${existing}, but it could NOT be established that the ` +
                    "connected ComfyUI reads models from there — the running server did not " +
                    "name its models root, so the root had to be inferred — and " +
                    (listed === false
                      ? `the server does NOT list "${target.filename}" under "${target.targetSubfolder}".`
                      : `the server could not be asked whether it lists "${target.filename}" under "${target.targetSubfolder}".`) +
                    " Check list_local_models.",
                ),
          );
          continue;
        }
        // Containment can still be satisfied by a HOST path that merely shares its
        // name with the server's — a container reporting `--models-directory /models`
        // while this host has its own unrelated `/models` (codex gate, round 15). So
        // a SKIP additionally requires the running server to really serve a file of
        // that name in the category. Matched by BASENAME, because findExistingModel
        // accepts a nested hit within the served category and an exact-path check
        // would fail legitimate installs.
        const servedByLive = await liveListingHasBasename(
          target.targetSubfolder,
          target.filename,
        );
        // NOTE: `servedByLive` above is deliberately computed and unused on the
        // stale path. Keeping the call costs one cheap listing GET per stale item
        // and avoids churn on this branch; it is NOT load-bearing here, and it
        // reads as though it feeds the guard below, which it does not.
        if (!staleOutsideLiveRoots) {
          results.push(
            servedByLive === true
              ? report("model", item, "skipped", `Model already exists at ${existing}.`)
              : servedByLive === false
                ? report(
                    "model",
                    item,
                    "failed",
                    `A file exists at ${existing}, but the connected ComfyUI does not list ` +
                      `"${target.filename}" under "${target.targetSubfolder}" at all — the models ` +
                      "directory it reported is not the one this file is in (this happens when " +
                      "ComfyUI runs in a container or behind a port-forward and its path also " +
                      "exists on this host). Confirm with list_local_models.",
                  )
                : report(
                    "model",
                    item,
                    "pending",
                    `A file exists at ${existing}, but the connected ComfyUI could not be asked ` +
                      `whether it serves "${target.filename}", so this is not confirmed as ` +
                      "installed. Check list_local_models.",
                  ),
          );
          continue;
        }
      }
      const { job, settled } = await startDownloadJob(
        model.url,
        target.targetSubfolder,
        target.filename,
      );
      enqueued.push({ item, job, settled, staleOutsideLiveRoots });
    } catch (err) {
      results.push(
        report(
          "model",
          item,
          "failed",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  if (enqueued.length > 0) {
    // Single bounded grace over the whole batch (settled never rejects — the job
    // registry captures errors onto job.status). allSettled resolves early if
    // every download finishes fast; otherwise the timer caps the wait.
    let graceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(enqueued.map((e) => e.settled)),
      new Promise<void>((r) => {
        graceTimer = setTimeout(r, manifestDownloadGraceMs());
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    // ONE resolution for the batch: a verdict made against a DIFFERENT ComfyUI than
    // the one connected now must not be re-asserted as an apply (#369).
    const liveRootNow = await currentLiveModelsRoot();
    for (const { item, job, staleOutsideLiveRoots } of enqueued) {
      // #1298 — the stale-copy note belongs on EVERY outcome, not just the happy
      // one. Review measured it rendering on 1 of 6: a download slower than the
      // 15s grace reports `pending` and the path was lost permanently, because
      // it lives only in this local array and the `download_model status` poll
      // the user is told to run cannot see it. That is the reporter's own case.
      // Worst was `wrongPlace`: two same-named copies on disk and neither
      // message naming the other.
      const staleNote = staleOutsideLiveRoots
        ? ` (Note: a same-named file also exists at ${staleOutsideLiveRoots}, which was NOT in ` +
          "any directory the connected ComfyUI reported reading when this item was checked — it " +
          "belongs to a different install and was ignored.)"
        : "";
      if (job.status === "error") {
        results.push(
          report("model", item, "failed", (job.error ?? "Model download failed.") + staleNote),
        );
      } else if (job.status === "done") {
        // "applied" must mean the running ComfyUI can actually load it (#369). Same
        // shared placement policy as download_model: an unconfirmed or demonstrably
        // wrong placement is reported as such, never as a clean apply.
        const placement = describePlacement(job, { liveModelsDir: liveRootNow });
        results.push(
          // "applied" must mean the running ComfyUI can actually load it (#369) —
          // that is the whole failure, just wearing a manifest's clothes. A
          // demonstrably unreadable placement is a FAILURE; an unconfirmed one is
          // PENDING (the transfer finished, the placement has not been established).
          placement.confirmed
            ? report(
                "model",
                item,
                "applied",
                `Model downloaded to ${job.path}${placement.pathQualifier}.` + staleNote,
              )
            : placement.wrongPlace
              ? report(
                  "model",
                  item,
                  "failed",
                  `Model ${placement.pathLabel} ${job.path}, but it is NOT usable by the connected ComfyUI: ${placement.warning}` +
                    staleNote,
                )
              : report(
                  "model",
                  item,
                  "pending",
                  `Model ${placement.pathLabel} ${job.path}. ${placement.warning}` + staleNote,
                ),
        );
      } else {
        results.push(
          report(
            "model",
            item,
            "pending",
            `Model download is RUNNING in the background (job ${job.id}) — NOT yet complete, ` +
              `and NOT a failure. Poll download_model action:"status" with this id; the file lands on its own. ` +
              `Do not re-issue the download.` + staleNote,
          ),
        );
      }
    }
  }

  const summary: Record<ManifestItemStatus, number> = {
    applied: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
  };
  for (const result of results) summary[result.status]++;

  return {
    // `success` means the manifest is APPLIED AND VERIFIED — nothing failed AND
    // nothing is still unsettled. A pending item is a real "not done": a transfer
    // still running, a ComfyUI-Manager dispatch that was accepted but not verified
    // as landed, or an existing file whose placement could not be established. All
    // three used to fold into a `true` here, which is the same fabricate-success
    // shape #369 is about, one level up (codex gate, round 15). Callers that only
    // care about hard failures read `summary.failed`; the per-item results say
    // exactly what is outstanding and how to confirm it.
    success: summary.failed === 0 && summary.pending === 0,
    summary,
    results,
  };
}
