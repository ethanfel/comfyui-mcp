// #1318 — a half-extracted install is silent until an unrelated-looking crash.
//
// A global Windows install became unusable: `@modelcontextprotocol/sdk`'s
// `dist/esm/server/` held two empty subdirectories where a healthy install has 42
// entries. Directories created, files never written — an interrupted extraction.
// The install's package.json still read 0.50.46, so it presented as up to date
// while being non-functional.
//
// What the user got was Node's resolver talking about a path:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//   '…\node_modules\@modelcontextprotocol\sdk\dist\esm\server\mcp.js'
//
// Nothing in that names comfyui-mcp, says the install is damaged, or hints at the
// one-line repair. The reporter filed it for exactly this detection gap, and was
// careful that the CAUSE is unproven — an interrupted `npm install -g` looks
// identical to a failed self-update. So this diagnoses the STATE, which is
// observable, and does not assert how it got there.

/** Node's error shape for a module that could not be resolved. */
interface ResolutionError {
  code?: unknown;
  message?: unknown;
}

/**
 * Is this the failure of a missing/unreadable module, rather than an error the
 * program threw on its own?
 *
 * Deliberately narrow. `ERR_MODULE_NOT_FOUND` and `MODULE_NOT_FOUND` are the two
 * Node reports for "the file the import points at is not there", which is the
 * observable state a half-extracted tree produces. Anything else is a real error
 * from real code and must reach the user unchanged — swallowing it behind a
 * "reinstall" banner would be its own defect, and a far more confusing one.
 */
export function isModuleResolutionFailure(err: unknown): boolean {
  const code = (err as ResolutionError)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

/** The specifier Node could not resolve, when its message carries one. */
export function missingSpecifier(err: unknown): string | null {
  const msg = typeof (err as ResolutionError)?.message === "string" ? String((err as ResolutionError).message) : "";
  // "Cannot find module '<path>' imported from …" / "Cannot find package '<name>'"
  const quoted = msg.match(/Cannot find (?:module|package) '([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  return null;
}

/**
 * Which of the two failures Node reported — an absent PACKAGE or an absent FILE
 * inside one.
 *
 * Worth distinguishing because the repair reads differently and, more to the
 * point, because "a file is missing: zod" is nonsense. Node says "Cannot find
 * package" when nothing resolved the bare specifier at all, and "Cannot find
 * module" when it resolved to a path that is not on disk — which is the
 * half-extracted case in #1318.
 */
export function missingKind(err: unknown): "package" | "module" | null {
  const msg = typeof (err as ResolutionError)?.message === "string" ? String((err as ResolutionError).message) : "";
  if (/Cannot find package '/.test(msg)) return "package";
  if (/Cannot find module '/.test(msg)) return "module";
  return null;
}

/** The package a path inside node_modules belongs to, for naming the culprit. */
export function owningPackage(specifier: string | null): string | null {
  if (!specifier) return null;
  const norm = specifier.replace(/\\/g, "/");
  const at = norm.lastIndexOf("node_modules/");
  if (at === -1) {
    // Not inside node_modules, so this is one of OUR OWN files, not a dependency.
    //
    // The first version treated any non-node_modules specifier as a bare package
    // name, which on Windows read the drive letter off an absolute path and
    // announced a missing dependency called "C:". An absolute or relative path is
    // never a package name — only a bare specifier is.
    // Tested against the NORMALIZED string: the raw one still has backslashes on
    // Windows, so a pattern written for `/` silently matched nothing there — which
    // is how `C:\Users\…\boot.js` came out as a dependency named "C:".
    if (/^([a-zA-Z]:)?\//.test(norm) || norm.startsWith(".")) return null;
    const m = norm.match(/^(@[^/]+\/[^/]+|[^@/][^/]*)/);
    return m?.[1] ?? null;
  }
  const rest = norm.slice(at + "node_modules/".length);
  const m = rest.match(/^(@[^/]+\/[^/]+|[^/]+)/);
  return m?.[1] ?? null;
}

/**
 * The message a user should get instead of a resolver stack trace.
 *
 * States the OBSERVATION (a module this install needs is not on disk) and the
 * repair, and does NOT claim why — the reporter could not prove self-update
 * caused it, and an interrupted `npm install -g` is indistinguishable. Asserting
 * a cause here would send someone to fix the wrong thing.
 */
export function describeBrokenInstall(err: unknown): string {
  const specifier = missingSpecifier(err);
  const pkg = owningPackage(specifier);
  const isDependency = Boolean(pkg) && pkg !== "comfyui-mcp";
  const what = !specifier
    ? `a module it needs could not be loaded`
    : // Nothing resolved the name at all: the package is absent, not damaged.
      // Printing the bare name on the "path" line would read as `is missing: zod`.
      missingKind(err) === "package" && isDependency
      ? `its dependency "${pkg}" is not installed`
      : isDependency
        ? `a file from its dependency "${pkg}" is missing:\n    ${specifier}`
        : `a file it needs is missing:\n    ${specifier}`;
  return (
    `comfyui-mcp could not start: ${what}\n\n` +
    `This install is INCOMPLETE, not misconfigured. Directories present with files missing is what an\n` +
    `interrupted install or update leaves behind, and the recorded version still looks current — which\n` +
    `is why nothing warned you until now.\n\n` +
    `Repair it by reinstalling:\n\n` +
    `    npm install -g comfyui-mcp@latest\n\n` +
    `If you run it through npx, clear the cache first (npx clear-npx-cache) so it does not reuse the\n` +
    `same damaged tree. Nothing else needs changing: your settings, panel and workflows are untouched.\n`
  );
}
