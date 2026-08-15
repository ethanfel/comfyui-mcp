// #1318 — a half-extracted install crashed with a resolver path and nothing else.
//
// The reporter's install had `@modelcontextprotocol/sdk/dist/esm/server/` as two
// empty directories where a healthy one has 42 entries, and a package.json that
// still read as current. What they got was:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
//   '…\node_modules\@modelcontextprotocol\sdk\dist\esm\server\mcp.js'
//
// These tests pin the two things that make the replacement message worth having:
// it names the DEPENDENCY rather than echoing a path, and it never fires on an
// error that is not a missing file.

import { describe, expect, it } from "vitest";

import {
  describeBrokenInstall,
  isModuleResolutionFailure,
  missingKind,
  missingSpecifier,
  owningPackage,
} from "../../utils/broken-install.js";

/** Node's other shape: the bare specifier resolved to nothing at all. */
function absentPackageError(name: string): Error {
  const err = new Error(`Cannot find package '${name}' imported from C:\\x\\dist\\boot.js`);
  (err as Error & { code: string }).code = "ERR_MODULE_NOT_FOUND";
  return err;
}

/** The real shape Node throws, as captured from the reporter's trace. */
function resolverError(specifier: string, code = "ERR_MODULE_NOT_FOUND"): Error {
  const err = new Error(`Cannot find module '${specifier}' imported from C:\\x\\dist\\boot.js`);
  (err as Error & { code: string }).code = code;
  return err;
}

const SDK_PATH =
  "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\comfyui-mcp\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm\\server\\mcp.js";

describe("only a missing file is treated as a broken install (#1318)", () => {
  it("recognises both codes Node uses for it", () => {
    expect(isModuleResolutionFailure(resolverError(SDK_PATH))).toBe(true);
    expect(isModuleResolutionFailure(resolverError(SDK_PATH, "MODULE_NOT_FOUND"))).toBe(true);
  });

  it("does NOT swallow a real error from real code", () => {
    // This is the direction that matters. A "reinstall comfyui-mcp" banner shown
    // over a genuine crash is a worse defect than the one being fixed — it sends
    // the user to repair something that is not broken and hides the stack that
    // would have told them what is.
    expect(isModuleResolutionFailure(new TypeError("x is not a function"))).toBe(false);
    expect(isModuleResolutionFailure(Object.assign(new Error("nope"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isModuleResolutionFailure(Object.assign(new Error("syntax"), { code: "ERR_MODULE_NOT_FOUND_X" }))).toBe(false);
    // A thrown non-Error must not crash the handler on its way past.
    expect(isModuleResolutionFailure(undefined)).toBe(false);
    expect(isModuleResolutionFailure(null)).toBe(false);
    expect(isModuleResolutionFailure("ERR_MODULE_NOT_FOUND")).toBe(false);
    expect(isModuleResolutionFailure({ code: 42 })).toBe(false);
  });
});

describe("the culprit is named from the specifier (#1318)", () => {
  it("pulls the specifier out of either message Node writes", () => {
    expect(missingSpecifier(resolverError(SDK_PATH))).toBe(SDK_PATH);
    const pkg = Object.assign(new Error("Cannot find package 'zod' imported from C:\\x.js"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(missingSpecifier(pkg)).toBe("zod");
  });

  it("returns null rather than guessing when the message carries none", () => {
    expect(missingSpecifier(Object.assign(new Error("boom"), { code: "ERR_MODULE_NOT_FOUND" }))).toBeNull();
    expect(missingSpecifier(undefined)).toBeNull();
    expect(missingSpecifier({ message: 12 })).toBeNull();
  });

  it("finds the package inside a node_modules path, on both separators", () => {
    expect(owningPackage(SDK_PATH)).toBe("@modelcontextprotocol/sdk");
    expect(owningPackage("/usr/lib/node_modules/comfyui-mcp/node_modules/zod/lib/index.js")).toBe("zod");
    // The LAST node_modules wins — a nested install is the innermost owner, and
    // reading the first one would blame comfyui-mcp for its dependency's damage.
    expect(owningPackage("/a/node_modules/comfyui-mcp/node_modules/ws/index.js")).toBe("ws");
  });

  it("an absolute path is not a package name — the \"C:\" regression", () => {
    // My first version treated any specifier outside node_modules as a bare
    // package name. On Windows that read the DRIVE LETTER off an absolute path
    // and announced a missing dependency called "C:". Caught by running it, not
    // by reading it, which is why the check is asserted against the normalised
    // string here: the first repair was written for `/` and matched nothing on
    // a backslash path, so it looked fixed and was not.
    //
    // These are paths with NO node_modules segment — a git checkout or a
    // bundled dist, which is where the launcher's own missing file shows up.
    expect(owningPackage("C:\\Users\\u\\code\\comfyui-mcp\\dist\\boot.js")).toBeNull();
    expect(owningPackage("C:/Users/u/code/comfyui-mcp/dist/boot.js")).toBeNull();
    expect(owningPackage("/usr/local/lib/comfyui-mcp/dist/boot.js")).toBeNull();
    expect(owningPackage("./boot.js")).toBeNull();
    expect(owningPackage("../lib/x.js")).toBeNull();
    expect(owningPackage(null)).toBeNull();
  });

  it("a genuine bare specifier still reads as one", () => {
    expect(owningPackage("zod")).toBe("zod");
    expect(owningPackage("@modelcontextprotocol/sdk/server/mcp.js")).toBe("@modelcontextprotocol/sdk");
  });
});

describe("the message a user actually gets (#1318)", () => {
  it("names comfyui-mcp, the dependency, and the one-line repair", () => {
    const text = describeBrokenInstall(resolverError(SDK_PATH));

    // Every one of these was absent from what the reporter saw.
    expect(text).toMatch(/^comfyui-mcp could not start/);
    expect(text).toContain('dependency "@modelcontextprotocol/sdk"');
    expect(text).toContain(SDK_PATH);
    expect(text).toContain("npm install -g comfyui-mcp@latest");
    expect(text).toMatch(/INCOMPLETE, not misconfigured/);
    // The regression must not come back in the user-facing string either.
    expect(text).not.toContain('dependency "C:"');
  });

  it("does NOT assert a cause the reporter could not prove", () => {
    // #1318 is careful about this: an interrupted `npm install -g` and a failed
    // self-update leave identical evidence on disk. Naming either one sends
    // someone to fix the wrong thing.
    const text = describeBrokenInstall(resolverError(SDK_PATH));
    expect(text).not.toMatch(/self-?update|auto-?update|caused by|because you/i);
    // It describes the STATE, and hedges the history.
    expect(text).toMatch(/interrupted install or update/);
  });

  it("degrades without inventing detail when the specifier is unreadable", () => {
    const text = describeBrokenInstall(Object.assign(new Error("boom"), { code: "ERR_MODULE_NOT_FOUND" }));
    expect(text).toContain("a module it needs could not be loaded");
    expect(text).toContain("npm install -g comfyui-mcp@latest");
    expect(text).not.toContain("dependency");
  });

  it("our OWN missing file is not blamed on a dependency", () => {
    const text = describeBrokenInstall(resolverError("C:\\npm\\node_modules\\comfyui-mcp\\dist\\boot.js"));
    expect(text).toContain("a file it needs is missing");
    expect(text).not.toContain("dependency");
  });

  it("an ABSENT package is not described as a missing file", () => {
    // Found by running the real launcher against a reproduced damaged install:
    // it printed `a file from its dependency "zod" is missing:` followed by a
    // path line reading just `zod`, because the bare specifier was reused as a
    // path. Node already distinguishes these two failures; so does the message.
    expect(missingKind(absentPackageError("zod"))).toBe("package");
    expect(missingKind(resolverError(SDK_PATH))).toBe("module");
    expect(missingKind(Object.assign(new Error("boom"), { code: "ERR_MODULE_NOT_FOUND" }))).toBeNull();

    const text = describeBrokenInstall(absentPackageError("zod"));
    expect(text).toContain('its dependency "zod" is not installed');
    expect(text).not.toMatch(/is missing:\s*\n\s*zod/);
  });

  it("a checkout outside node_modules says the same, not \"dependency C:\"", () => {
    // The path the launcher's OWN missing boot.js takes when comfyui-mcp is not
    // installed under node_modules. This is the string the "C:" bug produced.
    const text = describeBrokenInstall(resolverError("C:\\Users\\u\\code\\comfyui-mcp\\dist\\boot.js"));
    expect(text).toContain("a file it needs is missing");
    expect(text).not.toContain("dependency");
  });
});

describe("WIRING: the launcher can survive the failure it reports (#1318)", () => {
  // The whole fix turns on WHEN the handler exists. A static import of a broken
  // package throws during module evaluation — before the try/catch is reached —
  // so a launcher that imports anything from node_modules cannot report the very
  // state it was written for. Asserted on the source because there is no way to
  // observe it from inside a healthy process.
  it("imports nothing but the diagnosis helper, and loads boot.js dynamically", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../index.ts", import.meta.url), "utf-8");

    const staticImports = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(["./utils/broken-install.js"]);

    expect(src).toContain('await import("./boot.js")');
    // And the rethrow — without it this file becomes a crash-swallower.
    expect(src).toContain("if (!isModuleResolutionFailure(err)) throw err;");
  });

  it("boot.ts must not AWAIT main() — the launcher's scope depends on it", async () => {
    // The one finding of the review pass, and it is invisible from the launcher.
    //
    // `await import("./boot.js")` resolves when boot's MODULE BODY finishes, not
    // when the server stops. boot.ts ends in `main().catch(...)`, so everything
    // that happens during a run — including the lazy `await import()` probes for
    // OPTIONAL dependencies (@aws-sdk/client-s3, @azure/storage-blob, @ai-sdk/*,
    // @anthropic-ai/claude-agent-sdk), which throw ERR_MODULE_NOT_FOUND when
    // legitimately absent — is handled by boot's own catch and never reaches us.
    //
    // Change that line to `await main()` and every one of those optional probes
    // starts printing "this install is INCOMPLETE, reinstall it" over a working
    // install. MEASURED both ways against the built launcher, not reasoned:
    //
    //   main().catch(...)  -> boot's handler ran, code = ERR_MODULE_NOT_FOUND
    //   await main()       -> comfyui-mcp could not start: its dependency
    //                         "@azure/storage-blob" is not installed
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../boot.ts", import.meta.url), "utf-8");

    expect(src).toMatch(/^main\(\)\s*\n?\s*\.?catch\(/m);
    expect(src).not.toMatch(/^await\s+main\(\)/m);
  });

  it("broken-install.ts itself imports nothing at all", async () => {
    // It is loaded by the launcher, so anything it pulls in is another thing
    // that can be missing at exactly the moment we need to print the message.
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../utils/broken-install.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/^import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });
});
