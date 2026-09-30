"use strict";

/**
 * Derives the per-instance IPC namespace used to keep PM2 daemons apart.
 *
 * PM2 hardcodes its transport names on Windows — `\\.\pipe\rpc.sock` and
 * friends — for every user, every PM2_HOME and every project. Two daemons
 * cannot share one name, so a daemon left behind by another account or an
 * earlier session makes every later `pm2` invocation fail with
 * `connect EPERM \\.\pipe\rpc.sock`, and pm2 turns that into an unhandled
 * 'error' event that kills the CLI.
 *
 * Keying the namespace on PM2_HOME reproduces exactly the isolation PM2
 * already has on POSIX, where the sockets live inside PM2_HOME.
 */

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

/** `\\.\pipe\` — built from char codes so no escaping layer can mangle it. */
const PIPE_ROOT = String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92);

/**
 * Mirrors pm2's own `getDefaultPM2Home()` in pm2/paths.js so the CLI and the
 * God Daemon resolve the same value: the daemon is spawned with
 * `PM2_HOME=<resolved home>`, and the CLI falls back to `<homedir>/.pm2`.
 */
function pm2Home(env = process.env) {
  return env.PM2_HOME || path.join(os.homedir(), ".pm2");
}

/** Restrict to characters that are safe inside a pipe name. */
function sanitizeName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * A stable, filesystem- and case-insensitive identifier for a PM2 home.
 * Lowercasing matters on Windows, where `C:\Users\Me\.pm2` and
 * `c:\users\me\.pm2` name the same directory.
 */
function namespace(env = process.env) {
  if (env.BETTER_PM2_NS) return sanitizeName(env.BETTER_PM2_NS);
  const home = path.resolve(pm2Home(env)).toLowerCase();
  return crypto.createHash("sha1").update(home).digest("hex").slice(0, 12);
}

/** The three transport endpoints pm2 binds, namespaced. */
function pipeNames(env = process.env) {
  const ns = namespace(env);
  return {
    rpc: `${PIPE_ROOT}better-pm2-${ns}-rpc.sock`,
    pub: `${PIPE_ROOT}better-pm2-${ns}-pub.sock`,
    interactor: `${PIPE_ROOT}better-pm2-${ns}-interactor.sock`,
  };
}

/** The names PM2 would have used, kept for diagnostics. */
function legacyPipeNames(env = process.env) {
  const root = env.DAEMON_RPC_PORT ? null : PIPE_ROOT;
  return {
    rpc: root ? `${root}rpc.sock` : env.DAEMON_RPC_PORT,
    pub: root ? `${root}pub.sock` : env.DAEMON_PUB_PORT,
    interactor: root ? `${root}interactor.sock` : env.INTERACTOR_RPC_PORT,
  };
}

module.exports = {
  PIPE_ROOT,
  pm2Home,
  namespace,
  pipeNames,
  legacyPipeNames,
  sanitizeName,
};
