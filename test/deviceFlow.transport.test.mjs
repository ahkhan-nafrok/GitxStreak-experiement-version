// test/deviceFlow.transport.test.mjs
// The network-facing half of lib/deviceFlow.js (the pure parsers are covered
// by deviceFlow.test.mjs): request shape, error classification, and the
// verification-link origin check.
// Run with: node test/deviceFlow.transport.test.mjs
import assert from "node:assert/strict";
import { requestDeviceCode, checkTokenOnce, parseDeviceCodeResponse, DeviceFlowError } from "../lib/deviceFlow.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}
const res = (body, { status = 200, ok = status < 400, badJson = false } = {}) => ({
  ok, status, statusText: String(status), headers: { get: () => null },
  json: async () => { if (badJson) throw new SyntaxError("Unexpected token <"); return body; },
});
const originalFetch = globalThis.fetch;
const GOOD = { device_code: "d", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };

await test("requestDeviceCode: POSTs form-encoded client_id + scope to github.com/login/device/code with a deadline", async () => {
  let url, opts;
  globalThis.fetch = async (u, o) => { url = u; opts = o; return res(GOOD); };
  const info = await requestDeviceCode();
  assert.equal(url, "https://github.com/login/device/code");
  assert.equal(opts.method, "POST");
  assert.ok(opts.signal);
  const body = new URLSearchParams(opts.body);
  assert.ok(body.get("client_id"));
  assert.ok(body.get("scope"));
  assert.equal(info.userCode, "ABCD-1234");
});

await test("checkTokenOnce: POSTs the device_code grant to /login/oauth/access_token", async () => {
  let url, body;
  globalThis.fetch = async (u, o) => { url = u; body = new URLSearchParams(o.body); return res({ error: "authorization_pending" }); };
  assert.deepEqual(await checkTokenOnce("dev123", 5), { status: "pending" });
  assert.equal(url, "https://github.com/login/oauth/access_token");
  assert.equal(body.get("device_code"), "dev123");
  assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
});

await test("a documented 400 carrying an `error` field is interpreted, not treated as a network failure", async () => {
  globalThis.fetch = async () => res({ error: "expired_token" }, { status: 400 });
  await assert.rejects(() => checkTokenOnce("d", 5), (e) => e instanceof DeviceFlowError && e.code === "expired_token");
});

await test("a dropped connection is classified as the retryable code 'network'", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(() => checkTokenOnce("d", 5), (e) => e instanceof DeviceFlowError && e.code === "network");
});

await test("a hung request is aborted at the deadline and classified 'network'", async () => {
  const { netConfig } = await import("../lib/net.js");
  const saved = netConfig.timeoutMs;
  netConfig.timeoutMs = 20;
  globalThis.fetch = (u, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(() => checkTokenOnce("d", 5), (e) => e instanceof DeviceFlowError && e.code === "network" && /in time/.test(e.message));
  } finally { clearTimeout(keepAlive); netConfig.timeoutMs = saved; }
});

await test("a GitHub 502/503 (HTML error page) is 'network', never a crash on res.json()", async () => {
  globalThis.fetch = async () => res(null, { status: 502, badJson: true });
  await assert.rejects(() => checkTokenOnce("d", 5), (e) => e instanceof DeviceFlowError && e.code === "network" && /502/.test(e.message));
});

await test("a 200 with an unreadable body is 'network' (retryable), not an unhandled SyntaxError", async () => {
  globalThis.fetch = async () => res(null, { status: 200, badJson: true });
  await assert.rejects(() => checkTokenOnce("d", 5), (e) => e instanceof DeviceFlowError && e.code === "network");
});

await test("verification_uri must be on https://github.com — off-origin links never reach the UI", () => {
  for (const bad of ["https://evil.example/login/device", "http://github.com/login/device", "https://github.com.evil.example/x", "javascript:alert(1)", "not a url"]) {
    assert.throws(() => parseDeviceCodeResponse({ ...GOOD, verification_uri: bad }), (e) => e instanceof DeviceFlowError && e.code === "malformed", bad);
  }
  assert.equal(parseDeviceCodeResponse(GOOD).verificationUri, "https://github.com/login/device");
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
