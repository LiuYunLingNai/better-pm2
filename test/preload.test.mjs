import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const { pipeNames } = require("../src/namespace.cjs");

/**
 * The preload patches pm2's constants as they are required. These tests use a
 * stand-in module tree that mimics pm2's shape (`pm2/constants.js` exporting a
 * mutable object) so they run without pm2 installed.
 */

function makeFakePm2(dir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.join(dir, "node_modules", "pm2");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pm2", version: "0.0.0-fake" }));
  fs.writeFileSync(
    path.join(root, "constants.js"),
    `module.exports = {
       DAEMON_RPC_PORT: '\\\\\\\\.\\\\pipe\\\\rpc.sock',
       DAEMON_PUB_PORT: '\\\\\\\\.\\\\pipe\\\\pub.sock',
       INTERACTOR_RPC_PORT: '\\\\\\\\.\\\\pipe\\\\interactor.sock',
       IS_WINDOWS: process.platform === 'win32'
     };`
  );
  return root;
}

test("preload rewrites pm2's transport constants on win32", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lpm2-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  makeFakePm2(dir);

  // Install the hook, then require through the fake tree.
  const { install } = require("../src/preload.cjs");
  install();

  const cst = require(path.join(dir, "node_modules", "pm2", "constants.js"));
  const expected = pipeNames();

  if (process.platform === "win32") {
    assert.equal(cst.DAEMON_RPC_PORT, expected.rpc);
    assert.equal(cst.DAEMON_PUB_PORT, expected.pub);
    assert.equal(cst.INTERACTOR_RPC_PORT, expected.interactor);
    assert.notEqual(cst.DAEMON_RPC_PORT, "\\\\.\\pipe\\rpc.sock");
  } else {
    // On POSIX pm2's paths are already private per PM2_HOME; leave them alone.
    assert.equal(cst.DAEMON_RPC_PORT, "\\\\.\\pipe\\rpc.sock");
  }
});

test("preload patches the module on every require, idempotently", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lpm2-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  makeFakePm2(dir);
  const { install } = require("../src/preload.cjs");
  install();

  const target = path.join(dir, "node_modules", "pm2", "constants.js");
  const first = require(target);
  const second = require(target);

  // Cached module: the same object, already patched.
  assert.equal(first, second);
  if (process.platform === "win32") {
    assert.match(first.DAEMON_RPC_PORT, /lpm2-.*-rpc\.sock$/);
    assert.ok(!first.DAEMON_RPC_PORT.includes("\\\\.\\pipe\\rpc.sock"));
  }
});

test("preload is a no-op for unrelated modules", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lpm2-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const other = path.join(dir, "constants.js");
  fs.writeFileSync(other, "module.exports = { DAEMON_RPC_PORT: 'untouched' };");

  const { install } = require("../src/preload.cjs");
  install();

  const mod = require(other);
  assert.equal(mod.DAEMON_RPC_PORT, "untouched");
});
