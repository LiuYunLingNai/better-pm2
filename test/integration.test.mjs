/**
 * Integration test — reproduces the exact failure lpm2 exists to fix.
 *
 * The scenario: something already holds the global `\\.\pipe\rpc.sock` (an
 * orphaned daemon from another account or session). Stock pm2 hangs and then
 * dies with an unhandled EPERM; lpm2 must come up regardless.
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
const CLI = path.join(HERE, "..", "bin", "lpm2.mjs");
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
let pipeHeldByForeignDaemon = false;

before(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "lpm2-it-"));
  baseEnv = { ...process.env };
  delete baseEnv.NODE_OPTIONS;
  delete baseEnv.PM2_HOME;

  if (!isWindows) return;

  // The precondition for every test below is "the global pipe is already
  // held" — which is exactly the situation on a machine with an orphaned
  // daemon. If a real daemon holds it, that is a better fixture than
  // anything we could fake, so use it instead of failing to bind.
  //
  // Binding is attempted only to guarantee the precondition: EADDRINUSE
  // means someone else holds it, which is what we want.
  squatter = net.createServer((c) => c.end());
  const outcome = await new Promise((resolve) => {
    squatter.once("error", (err) => resolve(err.code));
    squatter.listen(GLOBAL_RPC, () => resolve(null));
  });

  if (outcome === "EADDRINUSE") {
    pipeHeldByForeignDaemon = true;
    squatter = null;
    console.log(
      `# fixture: a real daemon already holds ${GLOBAL_RPC}; using it as the held-pipe condition`
    );
  } else if (outcome) {
    throw new Error(`could not establish the held-pipe precondition: ${outcome}`);
  } else {
    console.log(`# fixture: this test holds ${GLOBAL_RPC} itself`);
  }
});

after(async () => {
  if (squatter) await new Promise((r) => squatter.close(r));
  // Tear down any daemon this test started. Safe to run unconditionally:
  // lpm2 addresses its own namespace, so this cannot reach a foreign daemon.
  if (pm2) {
    await run(process.execPath, [CLI, "kill"], {
      env: { ...baseEnv, PM2_HOME: path.join(tmp, "home") },
      cwd: process.cwd(),
      timeoutMs: 15000,
    });
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test(
  "lpm2 reports an empty list while a foreign daemon holds the global pipe",
  { skip: !pm2 || !isWindows },
  async () => {
    const res = await run(process.execPath, [CLI, "list"], {
      env: { ...baseEnv, PM2_HOME: path.join(tmp, "isolated") },
      cwd: process.cwd(),
      timeoutMs: 30000,
    });

    const text = strip(res.out);
    assert.equal(res.hung, false, `lpm2 hung:\n${text}`);
    assert.equal(res.code, 0, `lpm2 exited ${res.code}:\n${text}`);

    // The decisive property: a fresh PM2_HOME must show nothing, even though
    // the machine has a daemon running. Any row here would mean lpm2 reached
    // into another project's daemon.
    const rows = text
      .split("\n")
      .filter((l) => l.includes("│") && !/^\s*│\s*id\s*│/.test(l));
    assert.equal(
      rows.length,
      0,
      `expected no processes for an isolated PM2_HOME, got:\n${rows.join("\n")}`
    );
  }
);

test("lpm2 succeeds while the global pipe is held", { skip: !pm2 || !isWindows }, async () => {
  const env = {
    ...baseEnv,
    PM2_HOME: path.join(tmp, "home"),
    LPM2_DEBUG: "1",
  };

  const res = await run(process.execPath, [CLI, "ping"], {
    env,
    cwd: process.cwd(),
    timeoutMs: 30000,
  });

  const text = strip(res.out);
  assert.equal(res.hung, false, `lpm2 hung:\n${text}`);
  assert.equal(res.code, 0, `lpm2 exited ${res.code}:\n${text}`);
  assert.match(text, /pong/, `expected a pong reply:\n${text}`);
});

test("lpm2 doctor reports both transports", { skip: !pm2 }, async () => {
  const res = await run(process.execPath, [CLI, "doctor"], {
    env: { ...baseEnv, PM2_HOME: path.join(tmp, "doctor") },
    cwd: process.cwd(),
    timeoutMs: 20000,
  });

  const text = strip(res.out);
  assert.match(text, /lpm2 diagnostics/);
  assert.match(text, /transport \(lpm2\)/);
  assert.match(text, /lpm2-.*-rpc\.sock/);
});

test("lpm2 list works end to end", { skip: !pm2 || !isWindows }, async () => {
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
