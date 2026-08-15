import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { config, isRemoteMode } from "../config.js";
import { resolveEffectiveComfyUIBase } from "./workspace-env.js";

/**
 * The ComfyUI install a comfy-cli invocation TARGETS when the caller passed no explicit
 * `workspace`. That is the operation-target question, and `resolveEffectiveComfyUIBase`
 * is the only thing that answers it — including its refusal to name a local directory
 * when the session is pointed somewhere else.
 *
 * This used to read `config.comfyuiPath ?? resolveEffectiveComfyUIBase()`, which failed
 * twice over (#490): the resolver did not yet enforce the mode check this comment
 * claimed for it, AND the `??` short-circuited past the resolver entirely whenever
 * COMFYUI_PATH was set — the ordinary local configuration — so fixing the resolver alone
 * would not have reached here. The two operands answer different questions ("where is
 * the user's local install" vs "which install does this act on") and the `??` silently
 * substituted the first for the second.
 *
 * It matters most here: this module runs `comfy-cli uninstall` and `comfy-cli disable`.
 * With a remote `--comfyui-url` session and a stale local COMFYUI_PATH, those commands
 * ran against the local install while the reply described only the remote server.
 *
 * Returning null when nothing is resolvable is the point — callers refuse rather than
 * guess. Do not reintroduce a fallback here; a `??` at this seam is the bug.
 */
function defaultWorkspace(): string | null {
  return resolveEffectiveComfyUIBase() ?? null;
}

export interface ComfyCliError {
  code: string;
  message: string;
  hint?: string | null;
  details?: unknown;
}

export interface ComfyCliEnvelope<T = unknown> {
  schema?: string;
  type?: string;
  ok: boolean;
  command: string;
  version: string;
  where: "local" | "cloud" | null;
  data: T | null;
  error: ComfyCliError | null;
}

export interface ComfyCliRunOptions {
  workspace?: string | null;
  where?: "local" | "cloud";
  timeoutMs?: number;
  /**
   * Idle (liveness) timeout in milliseconds. When set, the process is only
   * killed if it produces NO stdout/stderr output for this long — each chunk
   * of output (e.g. a downloader progress line) resets the clock. This lets a
   * long-but-live download run to completion while still terminating a truly
   * stalled one. Takes precedence over `timeoutMs` when both are provided.
   */
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Minimal shape of the child process we consume; keeps this testable. */
export interface IdleTimeoutChild {
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface IdleTimeoutResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Await a spawned child process, killing it only after `idleTimeoutMs` elapses
 * with no output on either stream. Any stdout/stderr chunk is treated as
 * liveness and resets the idle timer. Exported for direct testing.
 */
export function awaitProcessWithIdleTimeout(
  child: IdleTimeoutChild,
  idleTimeoutMs: number,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout },
): Promise<IdleTimeoutResult> {
  return new Promise<IdleTimeoutResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIdle = () => {
      if (idleTimer) {
        timers.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdle = () => {
      clearIdle();
      idleTimer = timers.setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, idleTimeoutMs);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      armIdle();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      armIdle();
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearIdle();
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearIdle();
      resolve({ stdout, stderr, exitCode: timedOut ? 1 : code ?? 0, timedOut });
    });

    armIdle();
  });
}

const MIN_COMFY_CLI_VERSION = [1, 11, 1] as const;
const versionCache = new Map<string, string | null>();

function executableNames(): string[] {
  return process.platform === "win32" ? ["comfy.exe", "comfy"] : ["comfy"];
}

function workspaceCandidates(workspace?: string | null): string[] {
  if (!workspace) return [];
  const roots = [workspace, dirname(workspace)];
  const dirs = roots.flatMap((root) => [
    join(root, ".venv", process.platform === "win32" ? "Scripts" : "bin"),
    join(root, "venv", process.platform === "win32" ? "Scripts" : "bin"),
  ]);
  return dirs.flatMap((dir) => executableNames().map((name) => join(dir, name)));
}

/** Resolve comfy-cli without invoking a shell. COMFY_CLI_PATH is authoritative. */
export function resolveComfyCliExecutable(options: { refresh?: boolean; workspace?: string | null } = {}): string | null {
  const explicit = process.env.COMFY_CLI_PATH?.trim();
  if (explicit) {
    if (process.platform === "win32" && [".cmd", ".bat"].includes(extname(explicit).toLowerCase())) {
      return null;
    }
    return existsSync(explicit) ? explicit : null;
  }

  const workspace = options.workspace ?? defaultWorkspace();
  for (const candidate of workspaceCandidates(workspace)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames()) {
      const candidate = join(dir.replace(/^"|"$/g, ""), name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function buildArgs(args: readonly string[], options: ComfyCliRunOptions): string[] {
  const result = ["--json"];
  const workspace = options.workspace === undefined ? defaultWorkspace() : options.workspace;
  if (workspace) result.push("--workspace", workspace);
  if (options.where) result.push("--where", options.where);
  result.push("--skip-prompt", ...args);
  return result;
}

export function parseComfyCliEnvelope<T>(stdout: string, stderr = "", exitCode?: number): ComfyCliEnvelope<T> {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  let parsed: unknown;
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      parsed = JSON.parse(lines[index]);
      break;
    } catch {
      // JSON streaming commands may emit events before the final envelope.
    }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`comfy-cli did not return a JSON envelope${exitCode == null ? "" : ` (exit ${exitCode})`}: ${stderr || stdout}`);
  }
  const envelope = parsed as Partial<ComfyCliEnvelope<T>>;
  if (
    envelope.schema !== "envelope/1" ||
    envelope.type !== "envelope" ||
    typeof envelope.ok !== "boolean" ||
    typeof envelope.command !== "string" ||
    typeof envelope.version !== "string"
  ) {
    throw new Error("comfy-cli returned JSON that does not match envelope/1");
  }
  return envelope as ComfyCliEnvelope<T>;
}

function hasJsonRecord(stdout: string): boolean {
  return stdout.trim().split(/\r?\n/).some((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Output lines that are PROGRESS, not diagnosis (#417).
 *
 * ENUMERATED ON PURPOSE, and this is the whole safety argument. The failure this guards
 * against is a non-zero exit whose captured output says nothing about why — the reporter
 * was handed `Start downloading URL ... into ...` in the place a reason belongs. But a
 * filter that is too eager does something strictly worse: it discards a REAL error message
 * and replaces it with "no reason available", un-shipping the fix while looking like it
 * worked. A keyword test ("downloading", "%") would do exactly that to
 * `HTTP 403 while downloading ...`.
 *
 * So each entry matches one KNOWN emitter, anchored, and anything unrecognised is treated
 * as a real message and preserved. Being wrong in the direction of showing the user too
 * much is recoverable; being wrong the other way hides the only evidence they had.
 */
const PROGRESS_ONLY_LINE_PATTERNS: readonly RegExp[] = [
  // comfy-cli's own pre-download announcement — the line from the report. The real
  // emitter is `print(f"Start downloading URL: {url} into {local_filepath}")`
  // (comfy_cli/command/models/models.py) — WITH a colon, which my first fixtures omitted.
  /^start downloading url:?\s.*\binto\b/i,
  // huggingface_hub's tqdm, which ALWAYS carries a desc:
  //   "y.safetensors: 45%|████▌     | 1.20G/2.70G [00:30<00:40, 40.0MB/s]"
  // Every earlier pattern was anchored `^\s*\d`, so a desc-prefixed bar — the only tqdm
  // this tool actually produces — matched none of them. #417 was therefore still live on
  // the gated-Hugging-Face path, which is the path the new hint tells the user to suspect.
  // The desc is bounded and may not contain a `%`, so it cannot swallow a sentence that
  // merely happens to precede a percentage.
  /^[^%]{0,120}:\s*\d{1,3}%\|/,
  // Bare tqdm: " 45%|█████| 1.2G/2.7G [00:30<00:40, 40.0MB/s]". The size quantifiers are
  // BOUNDED: `[\d.]+\s*\S*\/` is ambiguous, and on a pathological single line it
  // backtracks quadratically — measured 13.3s at 200 KB, which on a 16 MB capture
  // (execFile's maxBuffer) would block the event loop for hours.
  /^\s*\d{1,3}%\|[^|]{0,200}\|\s*[\d.]{1,20}\s*\S{0,10}\/[\d.]{1,20}\s*\S{0,10}/i,
  // tqdm with no bar drawn (non-tty): " 45%| | 1.2G/2.7G"
  /^\s*\d{1,3}%\|/,
  // A bare percentage or a "Downloading: 45%" heartbeat.
  /^\s*(downloading:?\s*)?\d{1,3}(\.\d+)?%\s*$/i,
  // A drawn bar with no other text.
  /^[\s█▉▊▋▌▍▎▏#=>.\-\[\]|]+$/,
];

/**
 * Does this captured output contain anything that could explain a failure?
 *
 * Returns the surviving text, or null when every line was recognised progress. Null means
 * "I could not determine the reason" — a distinct third state from "the reason is X", and
 * it must never be reported as one (#796).
 */
export function failureReasonFrom(text: string): string | null {
  const meaningful = text
    // A progress bar redraws with \r; without splitting on it the whole bar is ONE line
    // ending in a real error, or one line of pure progress, depending on the emitter.
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !PROGRESS_ONLY_LINE_PATTERNS.some((re) => re.test(line)));
  return meaningful.length ? meaningful.join("\n") : null;
}

export function normalizeComfyCliResult<T = unknown>(
  args: readonly string[],
  options: ComfyCliRunOptions,
  result: { stdout: string; stderr: string; exitCode: number },
  version: string,
): ComfyCliEnvelope<T> {
  try {
    return parseComfyCliEnvelope<T>(result.stdout, result.stderr, result.exitCode);
  } catch (error) {
    if (hasJsonRecord(result.stdout)) throw error;
  }

  const command = args.join(" ");
  const details = { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  const alreadyStopped =
    args.length === 1 &&
    args[0] === "stop" &&
    /no comfyui is running in the background/i.test(details.stderr || details.stdout);
  if (alreadyStopped) {
    return {
      schema: "envelope/1",
      type: "envelope",
      ok: true,
      command,
      version,
      where: options.where ?? null,
      data: { ...details, already_stopped: true } as T,
      error: null,
    };
  }
  if (result.exitCode !== 0) {
    // #417 — A PROGRESS LINE IS NOT A FAILURE REASON.
    //
    // This used to report `stderr || stdout` verbatim. When comfy-cli dies mid-download
    // its stderr often holds nothing but the progress it had printed so far, so the
    // reporter's error message was `Start downloading URL ... into ...` — a sentence that
    // reads like a diagnosis, names no cause, and sent them looking at their URL and
    // destination directory (both fine) instead of at the download.
    //
    // The three states are: a reason, no reason, and — the one that caused this — no
    // reason DRESSED AS one. Saying plainly that the command produced no error output is
    // less satisfying and far more useful, because it redirects the search instead of
    // misdirecting it. The raw output stays in `details` either way; nothing is dropped.
    const reason = failureReasonFrom(details.stderr) ?? failureReasonFrom(details.stdout);
    // Only a DOWNLOAD may be described as having produced download progress. Read from the
    // argv this call actually ran, not from the tool that happened to call us.
    const isDownload = args.includes("download") || args.includes("--url");
    return {
      schema: "envelope/1",
      type: "envelope",
      ok: false,
      command,
      version,
      where: options.where ?? null,
      data: null,
      error: {
        code: "legacy_command_failed",
        message:
          reason ??
          `comfy-cli exited with code ${result.exitCode} and printed no error, so the cause is ` +
            `not visible from here${isDownload ? " — the output was download progress only" : ""}.`,
        ...(reason
          ? {}
          : {
              // THE DIAGNOSIS IS SCOPED TO THE COMMAND THAT EARNED IT. This function
              // normalizes the ENTIRE comfy-cli surface — stop, launch, run, node
              // install/update, models list/search/remove, skills_*, env — and the first
              // version asserted "its output was download progress only" and offered
              // disk-space-and-gated-HF-auth advice for every one of them. A failing
              // `comfy node install` would have been handed a fabricated download story.
              //
              // Which is this issue's own defect, inverted: #417 is about stating a cause
              // that was never established. Replacing a progress line with a confident
              // guess about a different command is the same error with better prose.
              hint: isDownload
                ? "Nothing in the command's output says why it stopped. Check, in this order: " +
                  "free disk space on the destination drive; whether the source needs auth (a " +
                  "gated Hugging Face repo returns 401/403 and some downloaders exit without " +
                  "printing it); and whether an antivirus or the OS killed the process. " +
                  "Re-running with the same arguments will show the same message — the missing " +
                  "information is on comfy-cli's side, not this tool's."
                : "Nothing in the command's output says why it stopped, and this tool cannot " +
                  "infer it. Re-run the same command directly in a terminal, where comfy-cli " +
                  "may print more than it does when its output is captured.",
            }),
        details: { ...details, exit_code: result.exitCode },
      },
    };
  }
  return {
    schema: "envelope/1",
    type: "envelope",
    ok: true,
    command,
    version,
    where: options.where ?? null,
    data: details as T,
    error: null,
  };
}

function requireExecutable(options: ComfyCliRunOptions): string {
  // REFUSE BEFORE RESOLVING, in remote mode (codex gate P0).
  //
  // comfy-cli acts on a LOCAL install. With `--comfyui-url` the workspace
  // resolver now correctly returns nothing — but that is exactly what makes this
  // dangerous rather than safe: `buildArgs` then omits `--workspace`, the PATH
  // fallback below still finds a global `comfy`, and the CLI falls back to
  // WHATEVER workspace it defaults to. `models_remove` therefore deletes models
  // from some unrelated local install while the session is connected elsewhere.
  //
  // "No workspace could be resolved" was being treated as "no workspace will be
  // used". It is not: it hands the choice to the CLI. This is the one choke-point
  // both `runComfyCli` and `runComfyCliSync` pass through, which is why the
  // refusal belongs here — nothing has run at this point.
  if (isRemoteMode()) {
    throw new Error(
      "This session targets a REMOTE ComfyUI (--comfyui-url), and comfy-cli only acts on a " +
        "LOCAL install — so there is no install here that this session is about. Nothing was " +
        "run. Run comfy-cli on the machine the install lives on, or point this session at the " +
        "local install first.",
    );
  }
  const executable = resolveComfyCliExecutable({ workspace: options.workspace });
  if (!executable) {
    throw new Error(
      "comfy-cli was not found. Install comfy-cli>=1.11.1 and ensure `comfy` is on PATH, " +
        "set COMFY_CLI_PATH, or install it in the selected ComfyUI workspace's .venv.",
    );
  }
  return executable;
}

function unsupportedVersionEnvelope<T>(
  args: readonly string[],
  options: ComfyCliRunOptions,
  version: string | null,
): ComfyCliEnvelope<T> {
  return {
    schema: "envelope/1",
    type: "envelope",
    ok: false,
    command: args.join(" "),
    version: version ?? "unknown",
    where: options.where ?? null,
    data: null,
    error: {
      code: "unsupported_version",
      message: `comfy-cli >=1.11.1 is required; found ${version ?? "an unrecognized version"}.`,
      hint: "Upgrade with: python -m pip install --upgrade comfy-cli",
    },
  };
}

export async function runComfyCli<T = unknown>(args: readonly string[], options: ComfyCliRunOptions = {}): Promise<ComfyCliEnvelope<T>> {
  const executable = requireExecutable(options);
  const detectedVersion = getExecutableVersion(executable);
  if (!isSupportedComfyCliVersion(detectedVersion)) {
    return unsupportedVersionEnvelope<T>(args, options, detectedVersion);
  }
  const version = detectedVersion!;
  if (options.idleTimeoutMs != null) {
    try {
      const child = childProcess.spawn(executable, buildArgs(args, options), {
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1", ...options.env },
        cwd: options.cwd,
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const result = await awaitProcessWithIdleTimeout(child, options.idleTimeoutMs);
      if (result.timedOut) {
        return {
          schema: "envelope/1",
          type: "envelope",
          ok: false,
          command: args.join(" "),
          version,
          where: options.where ?? null,
          data: null,
          error: {
            code: "idle_timeout",
            message:
              `comfy-cli produced no output for ${Math.round(options.idleTimeoutMs / 1000)}s and was terminated as stalled.`,
            hint: "The download appears stuck. Check network connectivity and the source URL, then retry.",
            details: { stdout: result.stdout.trim(), stderr: result.stderr.trim() },
          },
        };
      }
      return normalizeComfyCliResult<T>(args, options, result, version);
    } catch (error) {
      const spawnError = error as Error & { code?: string };
      if (spawnError.code === "ENOENT") throw error;
      return normalizeComfyCliResult<T>(args, options, { stdout: "", stderr: spawnError.message, exitCode: 1 }, version);
    }
  }
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      childProcess.execFile(
        executable,
        buildArgs(args, options),
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? 120_000,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: "1", ...options.env },
          cwd: options.cwd,
        },
        (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      );
    });
    return normalizeComfyCliResult<T>(args, options, { ...result, exitCode: 0 }, version);
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    if (processError.code === "ENOENT") throw error;
    const exitCode = typeof processError.code === "number" ? processError.code : 1;
    return normalizeComfyCliResult<T>(
      args,
      options,
      {
        stdout: processError.stdout ?? "",
        stderr: processError.stderr || processError.message,
        exitCode,
      },
      version,
    );
  }
}

export function runComfyCliSync<T = unknown>(args: readonly string[], options: ComfyCliRunOptions = {}): ComfyCliEnvelope<T> {
  const executable = requireExecutable(options);
  const detectedVersion = getExecutableVersion(executable);
  if (!isSupportedComfyCliVersion(detectedVersion)) {
    return unsupportedVersionEnvelope<T>(args, options, detectedVersion);
  }
  const version = detectedVersion!;
  try {
    const stdout = childProcess.execFileSync(executable, buildArgs(args, options), {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", ...options.env },
      cwd: options.cwd,
    });
    return normalizeComfyCliResult<T>(args, options, { stdout, stderr: "", exitCode: 0 }, version);
  } catch (error) {
    const processError = error as Error & { code?: string; stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    if (processError.code === "ENOENT") throw error;
    const stdout = processError.stdout?.toString() ?? "";
    const stderr = processError.stderr?.toString() || processError.message;
    return normalizeComfyCliResult<T>(args, options, { stdout, stderr, exitCode: processError.status ?? 1 }, version);
  }
}

function getExecutableVersion(executable: string): string | null {
  if (versionCache.has(executable)) return versionCache.get(executable) ?? null;
  const result = childProcess.spawnSync(executable, ["--json", "--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1" },
  });
  try {
    const version = parseComfyCliEnvelope(result.stdout ?? "", result.stderr ?? "", result.status ?? undefined).version;
    versionCache.set(executable, version);
    return version;
  } catch {
    versionCache.set(executable, null);
    return null;
  }
}

export function getComfyCliVersion(options: { workspace?: string | null } = {}): string | null {
  // Read-only, but it still SPAWNS a local `comfy` (codex gate). In remote mode
  // there is no local install this session is about, so probing one and reporting
  // its version would describe a CLI that must never be used from here — and
  // `isComfyCliUsable` below would then advertise it as available. "Not usable"
  // is the honest answer, and it is the same answer `requireExecutable` gives.
  if (isRemoteMode()) return null;
  const executable = resolveComfyCliExecutable({ workspace: options.workspace });
  return executable ? getExecutableVersion(executable) : null;
}

/**
 * Whether a usable comfy-cli (found AND version-supported) is available for the
 * given workspace. A found-but-unrecognized/too-old CLI is NOT usable — read-only
 * tools treat that identically to "absent" so they can fall back to the connected
 * server instead of surfacing `unsupported_version` (#487).
 */
export function isComfyCliUsable(options: { workspace?: string | null } = {}): boolean {
  const executable = resolveComfyCliExecutable({ workspace: options.workspace });
  if (!executable) return false;
  return isSupportedComfyCliVersion(getExecutableVersion(executable));
}

export function isSupportedComfyCliVersion(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < MIN_COMFY_CLI_VERSION.length; index++) {
    if ((parts[index] ?? 0) > MIN_COMFY_CLI_VERSION[index]) return true;
    if ((parts[index] ?? 0) < MIN_COMFY_CLI_VERSION[index]) return false;
  }
  return true;
}

export function shouldUseComfyCli(
  explicit: boolean | undefined,
  localMode: boolean,
  executable: string | null,
  version: string | null,
): boolean {
  if (explicit !== undefined) return explicit;
  return localMode && executable !== null && isSupportedComfyCliVersion(version);
}

export function assertComfyCliOk<T>(envelope: ComfyCliEnvelope<T>): ComfyCliEnvelope<T> {
  if (!envelope.ok) {
    const error = envelope.error;
    throw new Error(`${error?.code ? `${error.code}: ` : ""}${error?.message ?? "comfy-cli command failed"}${error?.hint ? ` (${error.hint})` : ""}`);
  }
  return envelope;
}
