import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * What ComfyUI Desktop SAVED as an install's launch arguments (#848).
 *
 * #848 is a configuration change that appeared to succeed and silently did not take: a
 * flag was added to Desktop's saved launch settings, `panel_restart_comfyui` reported the
 * server healthy, and the flag was absent. #850 already made the restart report whether
 * the running arguments changed — but that sentence has to be conditioned on the user's
 * own expectation ("if you were expecting different arguments…"), because nothing ever
 * opened the settings. It is a hint where an observation was available.
 *
 * This reads the saved arguments so the restart can say the specific thing: the settings
 * ask for X, the running server does not have X. That is two readings compared, in the
 * style of the rest of this cluster — never a claim about WHY they differ, and never a
 * claim that the restart caused it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not apply the arguments. A Desktop backend is
 * Electron-supervised and is never killed here (#400: killing it does not reliably bring
 * the listener back), and a Manager reboot re-execs the running process — so nothing in
 * this process can inject new launch arguments. Only the Desktop app can, at its own
 * launch. Pretending otherwise would be this issue's own defect pointed the other way.
 */
export interface SavedLaunchArgs {
  /** The install's display name in Desktop, for a message the user can act on. */
  name: string;
  /** Tokens exactly as saved. Desktop stores ONE space-separated string, not an array. */
  args: string[];
}

/** Desktop's own file is a few kilobytes; anything far larger is not it. */
const MAX_INSTALLATIONS_BYTES = 4 * 1024 * 1024;

/** The Desktop config directories, in the same order `config.ts` reads them. */
function desktopConfigDirs(): string[] {
  const home = homedir();
  return [
    join(home, "AppData", "Roaming", "Comfy Desktop"), // Windows
    join(home, "Library", "Application Support", "Comfy Desktop"), // macOS
    join(home, ".config", "Comfy Desktop"), // Linux
  ];
}

/**
 * Path identity, tolerant of trailing separators — and of CASE only where the filesystem
 * is (codex).
 *
 * Folding case everywhere is wrong on Linux, where `/home/u/ComfyUI` and `/home/u/comfyui`
 * are two different installs: the drift sentence would be attributed to the wrong one and
 * name a flag the user never put there. Windows is case-insensitive, and it is the
 * platform whose config layout this file is mostly about, so the fold is scoped to it.
 *
 * macOS is usually — not always — case-insensitive, and guessing is not worth it: a
 * mismatch there DECLINES, which costs a sentence rather than printing a wrong one.
 */
function samePath(a: string, b: string): boolean {
  const fold = process.platform === "win32";
  const norm = (p: string) => {
    const resolved = resolve(p.trim()).replace(new RegExp(`\\${sep}+$`), "");
    return fold ? resolved.toLowerCase() : resolved;
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Split the saved string into tokens the way a shell would, honouring quotes.
 *
 * `--extra-model-paths-config "C:\my path\x.yaml"` splits on whitespace into three
 * fragments, none of which appears in argv — so a naive split reports a change that IS in
 * force as missing, which is this issue's own defect pointed at the user.
 */
function splitLaunchArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const tok = m[1] ?? m[2] ?? m[3];
    if (tok) out.push(tok);
  }
  return out;
}

/**
 * Does this Desktop record describe the install we are running?
 *
 * Desktop's `installPath` is the install ROOT, and for its own installer layout `main.py`
 * sits one level down at `<installPath>/ComfyUI` — the same wrapper shape `config.ts`
 * heals when it detects installs. Our resolved path is the directory that HOLDS main.py,
 * so the two legitimately differ by that one segment. Comparing them naively finds nothing
 * on exactly the Desktop installs this feature exists for, and a silent no-match is
 * indistinguishable here from "no drift" — the sentence would simply never appear.
 */
function identifiesInstall(recorded: string, ours: string): boolean {
  return samePath(recorded, ours) || samePath(join(recorded, "ComfyUI"), ours);
}

/**
 * The saved launch arguments for the install at `installPath`, or undefined when the
 * question could not be answered.
 *
 * UNDEFINED IS "NOT ESTABLISHED", NOT "NONE" (#796). No file, unreadable file, no entry
 * for this path, two entries claiming it, or an entry with no `launchArgs` key are all
 * cases where the caller must stay quiet rather than report an empty set — "Desktop saves
 * no arguments for this install" is a claim, and a missing file does not support it. An
 * entry that explicitly saves an EMPTY string is different: that is a real answer, and it
 * comes back as an empty array.
 */
export function desktopSavedLaunchArgs(installPath: string | undefined): SavedLaunchArgs | undefined {
  if (!installPath?.trim()) return undefined;
  const matches: SavedLaunchArgs[] = [];
  for (const dir of desktopConfigDirs()) {
    let parsed: unknown;
    try {
      const file = join(dir, "installations.json");
      if (!existsSync(file)) continue;
      // A SIZE BOUND (codex P3). This runs while composing the restart REPORT, and the
      // answer is worth one small local JSON read — not an unbounded slurp of whatever
      // happens to sit at that name. It does not make the read non-blocking, which is the
      // honest residual: a redirected roaming profile on a slow share can still cost this
      // report a moment. The restart itself has already happened by then, and this path
      // already makes synchronous process-table and network probes.
      if (statSync(file).size > MAX_INSTALLATIONS_BYTES) continue;
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      // Unreadable or malformed: nothing established.
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const inst of parsed) {
      if (!inst || typeof inst !== "object") continue;
      const rec = inst as Record<string, unknown>;
      // A remote entry describes a URL, not a local process — its saved arguments say
      // nothing about the server running here.
      if (rec.sourceId === "remote" || rec.sourceId === "cloud") continue;
      if (typeof rec.installPath !== "string" || !identifiesInstall(rec.installPath, installPath))
        continue;
      // Desktop writes ONE STRING. An array is accepted too rather than assumed away:
      // the shape is theirs to change, and a silent mis-read here would produce a
      // confident sentence about arguments nobody saved.
      const raw = rec.launchArgs;
      const args =
        typeof raw === "string"
          ? splitLaunchArgs(raw)
          : Array.isArray(raw) && raw.every((t) => typeof t === "string")
            ? (raw as string[]).filter(Boolean)
            : undefined;
      if (args === undefined) continue;
      matches.push({
        name: typeof rec.name === "string" && rec.name.trim() ? rec.name : installPath,
        args,
      });
    }
  }
  // AMBIGUITY DECLINES. Two entries claiming the same path cannot both be the install
  // whose settings the user edited, and picking one would put a specific, checkable
  // sentence in front of them that may be about the other.
  return matches.length === 1 ? matches[0] : undefined;
}

/** The flag NAME of a token: `--port=8000` and `--port` are the same instruction, and a
 *  value token has no flag name at all. */
function flagName(token: string): string {
  return token.startsWith("-") ? token.split("=")[0] : "";
}

/**
 * The sentence naming saved arguments the running server does not have (#848).
 *
 * Returns "" when there is nothing established to say — no saved settings, no running
 * argv, or nothing missing. Silence is the correct output for all three: the caller
 * already prints the general "if you were expecting different arguments" remedy, and this
 * only ever REPLACES a conditional with an observation when one is available.
 *
 * ONLY ABSENCE IS REPORTED, never the reverse. A running server carrying arguments the
 * saved settings do not mention is ordinary — Desktop adds its own — so that direction is
 * not a finding. And the sentence says the tokens are absent, not that the restart
 * dropped them or that Desktop ignored them: neither is observed here.
 */
export function describeSavedLaunchArgDrift(
  saved: SavedLaunchArgs | undefined,
  runningArgv: string[] | undefined,
): string {
  if (!saved || !saved.args.length || !runningArgv?.length) return "";
  // COMPARE FLAGS, NOT TOKENS. The saved settings are one string and argv is already
  // split, so the same instruction is spelled several ways: `--port 8000` against
  // `--port=8000`, a quoted path against its unquoted argv form. Token equality called all
  // of those "not in force" — a confident, checkable, WRONG sentence sending the user to
  // restart Desktop for nothing, which is this issue's defect pointed back at them.
  //
  // Only FLAGS are reported, and only by name. A bare value is an argument to a flag: its
  // formatting varies, and it says nothing on its own. The reported case is a whole flag
  // that is absent, which is exactly what #848 was about.
  const runningFlags = new Set(runningArgv.map(flagName).filter(Boolean));
  const missing = saved.args
    .filter((tok) => tok.startsWith("-"))
    .filter((tok) => !runningFlags.has(flagName(tok)));
  if (!missing.length) return "";
  return (
    ` ComfyUI Desktop's saved launch settings for "${saved.name}" include ` +
    `${missing.join(" ")}, which the running server's arguments do NOT contain — so that ` +
    `change is not in effect. It is applied when Desktop itself spawns the server: fully ` +
    `quit the ComfyUI Desktop app and relaunch it.`
  );
}
