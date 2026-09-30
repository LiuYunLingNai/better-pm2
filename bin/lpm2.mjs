#!/usr/bin/env node
/**
 * lpm2 — run PM2 with a private IPC namespace.
 *
 * Usage is identical to pm2; every argument is forwarded:
 *   lpm2 start app.js
 *   lpm2 list
 *   lpm2 logs
 *
 * The command resolves the pm2 that the current project actually uses, then
 * re-invokes its CLI with a preload that moves the daemon onto pipes keyed by
 * PM2_HOME. Because the God Daemon is spawned with the CLI's environment, it
 * inherits the preload and lands on the same pipes — so this fixes the
 * collision rather than just working around it.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "..", "src", "preload.cjs");

const DEBUG = !!process.env.LPM2_DEBUG;

function fail(message) {
  console.error(`lpm2: ${message}`);
  process.exit(1);
}

/** Resolve pm2 from the project first, then from lpm2's own tree. */
function resolvePm2Bin(cwd) {
  const resolvers = [
    createRequire(path.join(cwd, "__lpm2__.js")),
    createRequire(import.meta.url),
  ];

  for (const req of resolvers) {
    let pkgPath;
    try {
      pkgPath = req.resolve("pm2/package.json");
    } catch {
      continue;
    }
    const reqFromPm2 = createRequire(pkgPath);
    const pkg = reqFromPm2("pm2/package.json");
    const binField = pkg.bin;
    const rel = typeof binField === "string" ? binField : binField?.pm2;
    if (!rel) continue;

    const abs = path.resolve(path.dirname(pkgPath), rel);
    if (existsSync(abs)) return { bin: abs, version: pkg.version, pkgPath };
  }

  return null;
}

/**
 * pm2's launcher is a JS file, but running it through `node` keeps us off
 * PATH and away from the .cmd/.ps1 shim differences on Windows.
 *
 * Paths are normalized to forward slashes: NODE_OPTIONS is tokenized with
 * backslash-escape semantics, so a Windows path like `D:\a\b\c.js` loses its
 * separators (`D:abc.js`) and the preload silently fails to resolve.
 * Node accepts forward slashes on Windows.
 */
function buildNodeOptions(preloadPath) {
  const parts = [];
  const existing = process.env.NODE_OPTIONS;
  if (existing) parts.push(existing.trim());

  const normalized = preloadPath.replace(/\\/g, "/");
  parts.push(`--require "${normalized}"`);
  return parts.join(" ");
}

function resolvePm2Home() {
  return process.env.LPM2_HOME || process.env.PM2_HOME || path.join(os.homedir(), ".pm2");
}

function doctor() {
  const pm2 = resolvePm2Bin(process.cwd());
  const { pipeNames, legacyPipeNames, namespace } = createRequire(import.meta.url)(
    "../src/namespace.cjs"
  );
  const pipes = pipeNames();
  const legacy = legacyPipeNames();

  console.log("lpm2 diagnostics");
  console.log("  platform        :", process.platform);
  console.log("  node            :", process.version);
  console.log("  pm2             :", pm2 ? `${pm2.version} (${pm2.pkgPath})` : "NOT FOUND");
  console.log("  PM2_HOME        :", resolvePm2Home());
  console.log("  namespace       :", namespace());
  console.log("  preload         :", PRELOAD, existsSync(PRELOAD) ? "" : "(MISSING!)");
  console.log("");
  console.log("  transport (lpm2):");
  console.log("    rpc        :", pipes.rpc);
  console.log("    pub        :", pipes.pub);
  console.log("    interactor :", pipes.interactor);
  console.log("");
  console.log("  transport (stock pm2, global/shared):");
  console.log("    rpc        :", legacy.rpc);
  console.log("    pub        :", legacy.pub);
  console.log("");
  console.log("  If the stock paths above are held by another daemon, plain `pm2`");
  console.log("  will fail with `connect EPERM`; lpm2 uses its own set.");

  if (!pm2) {
    console.log("");
    console.log("  NOTE: pm2 is not resolvable from here. Install it (npm i pm2)");
    console.log("        or set NODE_PATH, then run lpm2 again.");
  }
  process.exit(pm2 ? 0 : 1);
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === "doctor" || args[0] === "--doctor") return doctor();
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`lpm2 ${readVersion()} — pm2 with per-instance IPC namespaces

Usage: lpm2 <pm2 command> [options]

  lpm2 start app.js        start an app
  lpm2 list                list processes
  lpm2 logs                tail logs
  lpm2 restart all         restart everything
  lpm2 doctor              show transport/diagnostic info
  lpm2 kill                stop the daemon for this PM2_HOME

Any pm2 command works — arguments are forwarded verbatim.

Environment:
  PM2_HOME          daemon home (default: ~/.pm2); sets the namespace
  LPM2_HOME   overrides PM2_HOME for lpm2 only
  LPM2_NS     force an explicit namespace instead of hashing the home
  LPM2_DEBUG  print namespace/pipe decisions to stderr
`);
    return process.exit(0);
  }

  const pm2 = resolvePm2Bin(process.cwd());
  if (!pm2) {
    fail(
      "could not resolve pm2 from this directory.\n" +
        "  Install it here (npm install pm2) or globally (npm install -g pm2)."
    );
  }
  if (!existsSync(PRELOAD)) fail(`preload missing at ${PRELOAD} — package is corrupt.`);

  const env = {
    ...process.env,
    PM2_HOME: resolvePm2Home(),
    NODE_OPTIONS: buildNodeOptions(PRELOAD),
  };

  if (DEBUG) {
    console.error(`[lpm2] pm2=${pm2.version} home=${env.PM2_HOME}`);
    console.error(`[lpm2] NODE_OPTIONS=${env.NODE_OPTIONS}`);
  }

  const child = spawn(process.execPath, [pm2.bin, ...args], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("error", (err) => fail(`failed to launch pm2: ${err.message}`));
  child.on("close", (code, signal) => {
    if (signal) return process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

function readVersion() {
  try {
    return createRequire(import.meta.url)("../package.json").version;
  } catch {
    return "";
  }
}

main();
