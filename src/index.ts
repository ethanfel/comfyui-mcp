#!/usr/bin/env node
// #1318 — THE LAUNCHER EXISTS SO A DAMAGED INSTALL CAN SAY SO.
//
// Everything this program does lives in ./boot.js. It is loaded DYNAMICALLY, and
// that is the whole point: a static import of a missing dependency throws before
// any of our code runs, so the user gets Node's resolver talking about a path
// inside node_modules and nothing else. That is what happened in #1318 — a global
// install whose `@modelcontextprotocol/sdk` was half-extracted produced an
// ERR_MODULE_NOT_FOUND that never mentioned comfyui-mcp, while the recorded
// version still read as current.
//
// Keeping this file free of package imports is load-bearing. Anything imported
// here statically is something that can fail before the handler is installed, and
// the handler is the only reason this file exists.
import { describeBrokenInstall, isModuleResolutionFailure } from "./utils/broken-install.js";

try {
  await import("./boot.js");
} catch (err) {
  // A REAL error from real code must reach the user unchanged. Only the specific
  // "the file is not on disk" failure is translated; anything else rethrown.
  if (!isModuleResolutionFailure(err)) throw err;
  process.stderr.write(`\n${describeBrokenInstall(err)}\n`);
  // Exit code unchanged (1): scripts and supervisors already treat that as a
  // failed start, and moving it would be a behaviour change nobody asked for.
  process.exit(1);
}
