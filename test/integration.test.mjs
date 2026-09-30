/**
 * Integration test — reproduces the exact failure better-pm2 exists to fix.
 *
 * The scenario: something already holds the global `\\.\pipe\rpc.sock` (an
 * orphaned daemon from another account or session). Stock pm2 hangs and then
 * dies with an unhandled EPERM; better-pm2 must come up regardless.
 *
 * Requires pm2 to be resolvable. Skipped when it is not, so the unit suite
 * stays runnable anywhere.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "better-pm2.mjs");
const require = createRequire(import.meta.url);
const { PIPE_ROOT, pipeNames } = require("../src/namespace.cjs");

const GLOBAL_RPC = `${PIPE_ROOT}rpc.sock`;
const isWindows = process.platform === "win32";

function resolvePm2() {
  for (const base of [process.cwd(), HERE]) {
    try {
      const req = createRequire(path.join(base, "__probe__.js"));
      const pkgPath = req.resolve("pm2/package.json");
      const pkg = req("pm2/package.json");
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pm2;
      if (!rel) continue;
      const abs = path.resolve(path.dirname(pkgPath), rel);
      if (existsSync(abs)) return { bin: abs, version: pkg.version };
    } catch {
      /* try next base */
    }
  }
  return null;
}

const pm2 = resolvePm2();

/** Run a command with a watchdog; resolves {hung} instead of throwing. */
function run(cmd, args, { env, cwd, timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ hung: true, code: null, out });
    }, timeoutMs);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hung: false, code: null, out: out + String(e.message) });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hung: false, code, out });
    });
  });
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

let tmp;
let squatter;
let baseEnv;

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "better-pm2-it-"));
  baseEnv = { ...process.env };
  delete baseEnv.NODE_OPTIONS;
  delete baseEnv.PM2_HOME;

  if (isWindows) {
    // Occupy the global pipe, exactly like a foreign/orphaned pm2 daemon.
    squatter = net.createServer((c) => c.end());
    await new Promise((resolve, reject) => {
      squatter.once("error", reject);
      squatter.listen(GLOBAL_RPC, resolve);
    });
  }
});

after(async () => {
  if (squatter) await new Promise((r) => squatter.close(r));
  // Tear down any daemon this test started.
  if (pm2) {
    await run(process.execPath, [CLI, "kill"], {
      env: { ...baseEnv, PM2_HOME: path.join(tmp, "home") },
      cwd: process.cwd(),
      timeoutMs: 15000,
    });
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("stock pm2 fails while the global pipe is held", { skip: !pm2 || !isWindows }, async () => {
  const res = await run(process.execPath, [pm2.bin, "ping"], {
    env: { ...baseEnv, PM2_HOME: path.join(tmp, "stock") },
    cwd: process.cwd(),
    timeoutMs: 15000,
  });

  const text = strip(res.out);
  const failed = res.hung || res.code !== 0 || /EPERM|EADDRINUSE/i.test(text);
  assert.ok(
    failed,
    `expected stock pm2 to fail against a held pipe, but it succeeded:\n${text}`
  );
});

test("better-pm2 succeeds while the global pipe is held", { skip: !pm2 || !isWindows }, async () => {
  const env = {
    ...baseEnv,
    PM2_HOME: path.join(tmp, "home"),
    BETTER_PM2_DEBUG: "1",
  };

  const res = await run(process.execPath, [CLI, "ping"], {
    env,
    cwd: process.cwd(),
    timeoutMs: 30000,
  });

  const text = strip(res.out);
  assert.equal(res.hung, false, `better-pm2 hung:\n${text}`);
  assert.equal(res.code, 0, `better-pm2 exited ${res.code}:\n${text}`);
  assert.match(text, /pong/, `expected a pong reply:\n${text}`);
});

test("better-pm2 doctor reports both transports", { skip: !pm2 }, async () => {
  const res = await run(process.execPath, [CLI, "doctor"], {
    env: { ...baseEnv, PM2_HOME: path.join(tmp, "doctor") },
    cwd: process.cwd(),
    timeoutMs: 20000,
  });

  const text = strip(res.out);
  assert.match(text, /better-pm2 diagnostics/);
  assert.match(text, /transport \(better-pm2\)/);
  assert.match(text, /better-pm2-.*-rpc\.sock/);
});

test("better-pm2 list works end to end", { skip: !pm2 || !isWindows }, async () => {
  const env = { ...baseEnv, PM2_HOME: path.join(tmp, "home") };
  const res = await run(process.execPath, [CLI, "list"], {
    env,
    cwd: process.cwd(),
    timeoutMs: 30000,
  });

  const text = strip(res.out);
  assert.equal(res.hung, false, `list hung:\n${text}`);
  assert.equal(res.code, 0, `list exited ${res.code}:\n${text}`);
});
