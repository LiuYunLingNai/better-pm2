import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const {
  PIPE_ROOT,
  pm2Home,
  namespace,
  pipeNames,
  sanitizeName,
} = require("../src/namespace.cjs");

test("PIPE_ROOT is the literal Windows pipe prefix", () => {
  assert.equal(PIPE_ROOT.length, 9);
  assert.equal(PIPE_ROOT, "\\\\.\\pipe\\");
});

test("pm2Home prefers PM2_HOME, then falls back to ~/.pm2", () => {
  assert.equal(pm2Home({ PM2_HOME: "D:\\a\\.pm2" }), "D:\\a\\.pm2");
  assert.equal(pm2Home({}), path.join(os.homedir(), ".pm2"));
});

test("same home yields the same namespace (CLI and daemon agree)", () => {
  const env = { PM2_HOME: "C:\\Users\\x\\.pm2" };
  assert.equal(namespace(env), namespace({ ...env }));
});

test("namespace is case-insensitive, matching Windows path semantics", () => {
  assert.equal(
    namespace({ PM2_HOME: "C:\\Users\\Me\\.pm2" }),
    namespace({ PM2_HOME: "c:\\users\\me\\.pm2" })
  );
});

test("different homes yield different namespaces", () => {
  assert.notEqual(
    namespace({ PM2_HOME: "C:\\a\\.pm2" }),
    namespace({ PM2_HOME: "C:\\b\\.pm2" })
  );
});

test("LPM2_NS overrides the derived namespace", () => {
  const ns = namespace({ PM2_HOME: "C:\\a\\.pm2", LPM2_NS: "myapp" });
  assert.equal(ns, "myapp");
});

test("namespaces are safe to embed in a pipe name", () => {
  const ns = namespace({ LPM2_NS: "has spaces/and\\slashes:and*stars" });
  assert.match(ns, /^[A-Za-z0-9._-]+$/);
  assert.ok(!ns.includes(" "));
});

test("sanitizeName trims and bounds length", () => {
  assert.equal(sanitizeName("  ok-name  "), "ok-name");
  assert.equal(sanitizeName("a".repeat(200)).length, 64);
});

test("pipeNames produces distinct, namespaced endpoints", () => {
  const env = { PM2_HOME: "C:\\a\\.pm2" };
  const p = pipeNames(env);
  const ns = namespace(env);

  assert.equal(p.rpc, `${PIPE_ROOT}lpm2-${ns}-rpc.sock`);
  assert.equal(p.pub, `${PIPE_ROOT}lpm2-${ns}-pub.sock`);
  assert.equal(p.interactor, `${PIPE_ROOT}lpm2-${ns}-interactor.sock`);

  // Distinctness matters: two endpoints sharing a name would collide.
  assert.equal(new Set(Object.values(p)).size, 3);
});

test("pipeNames never collide with pm2's hardcoded global names", () => {
  const p = pipeNames({ PM2_HOME: "C:\\a\\.pm2" });
  for (const name of Object.values(p)) {
    assert.notEqual(name, `${PIPE_ROOT}rpc.sock`);
    assert.notEqual(name, `${PIPE_ROOT}pub.sock`);
    assert.notEqual(name, `${PIPE_ROOT}interactor.sock`);
    assert.ok(name.startsWith(`${PIPE_ROOT}lpm2-`));
  }
});
