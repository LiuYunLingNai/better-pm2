"use strict";

/**
 * The preload patch. Installed via
 *   NODE_OPTIONS="--require better-pm2/preload"
 * so it runs before any pm2 module in *both* the CLI process and the God
 * Daemon that the CLI spawns (the daemon inherits the CLI's environment).
 *
 * It rewrites pm2's `constants.js` exports before pm2 reads them. pm2 builds
 * its transport paths at require-time in paths.js and merges them into a
 * plain mutable object in constants.js, and every consumer
 * (`new Client()` in lib/Client.js, the `Daemon` in lib/Daemon.js) reads the
 * ports off that object — so reassigning the properties is enough to move
 * the whole daemon onto a private set of pipes.
 *
 * Two deliberate choices:
 *
 *  1. `Module._load` interception, not a hardcoded path. better-pm2 may be
 *     installed globally, in a monorepo, or alongside a pnpm content-addressed
 *     store; it must patch whichever pm2 the command actually resolved.
 *
 *  2. Rewriting `_load` rather than mutating `require.cache` — `_load` sees
 *     the request *and* parent, so it works on Node 18 through current with
 *     no reliance on cache-key formats.
 */

const Module = require("node:module");
const { pipeNames } = require("./namespace.cjs");

const DEBUG = !!process.env.BETTER_PM2_DEBUG;

/** Match pm2's constants module by shape, not by a fixed install path. */
const CONSTANTS_RE = /[\\/]pm2[\\/]constants\.js$/;

/** Guard against double-patching when several preloads stack. */
const PATCH_FLAG = Symbol.for("better-pm2.patched");

let installed = false;

function describe(resolved) {
  return resolved.replace(/\\/g, "/").split("/node_modules/").pop();
}

function patch(mod, resolved) {
  if (!mod || mod[PATCH_FLAG]) return;

  const pipes = pipeNames();

  // Only rewrite what pm2 would otherwise derive from the platform. On POSIX
  // the paths already sit inside PM2_HOME and are private per home, so there
  // is nothing to fix.
  if (process.platform === "win32") {
    mod.DAEMON_RPC_PORT = pipes.rpc;
    mod.DAEMON_PUB_PORT = pipes.pub;
    mod.INTERACTOR_RPC_PORT = pipes.interactor;
  }

  Object.defineProperty(mod, PATCH_FLAG, { value: true, enumerable: false });

  if (DEBUG) {
    console.error(
      `[better-pm2] pid=${process.pid} role=${process.argv[1] && describe(process.argv[1])} ` +
        `rpc=${mod.DAEMON_RPC_PORT}`
    );
  }
}

function install() {
  if (installed) return;
  installed = true;

  const origLoad = Module._load;

  Module._load = function betterPm2Load(request, parent, isMain) {
    const mod = origLoad.apply(this, arguments);

    // Cheap rejection before touching the resolver: the vast majority of
    // requires in a process are not pm2's constants module.
    if (
      mod &&
      typeof request === "string" &&
      request.includes("constants") &&
      !mod[PATCH_FLAG]
    ) {
      try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (CONSTANTS_RE.test(resolved)) patch(mod, resolved);
      } catch {
        // Resolution failures are pm2's problem to report, not ours.
      }
    }

    return mod;
  };
}

install();

module.exports = { install, patch, describe };
