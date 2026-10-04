// test/net.test.mjs — lib/net.js: deadline + retry policy.
// Run with: node test/net.test.mjs
import assert from "node:assert/strict";
import { fetchWithTimeout, fetchGetWithRetry, NetworkError, netConfig } from "../lib/net.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}
const res = (status) => ({ ok: status < 400, status, statusText: String(status), headers: { get: () => null } });
const originalFetch = globalThis.fetch;
const noSleep = async () => {};

await test("fetchWithTimeout: passes an AbortSignal and returns the response untouched", async () => {
  let seen;
  globalThis.fetch = async (u, o) => { seen = o; return res(200); };
  const r = await fetchWithTimeout("https://x", { method: "POST" }, 50);
  assert.equal(r.status, 200);
  assert.equal(seen.method, "POST");
  assert.ok(seen.signal);
});

await test("fetchWithTimeout: a hung request is aborted at the deadline -> NetworkError", async () => {
  globalThis.fetch = (u, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer is unref'd; keep Node alive for the test
  const started = Date.now();
  try {
    await assert.rejects(() => fetchWithTimeout("https://x", {}, 25), (e) => e instanceof NetworkError && /in time/.test(e.message));
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(Date.now() - started < 1000);
});

await test("fetchWithTimeout: any other fetch failure is wrapped as NetworkError with the cause message", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(() => fetchWithTimeout("https://x"), (e) => e instanceof NetworkError && /fetch failed/.test(e.message));
});

await test("fetchGetWithRetry: success on the first try makes exactly one call", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res(200); };
  await fetchGetWithRetry("https://x", {}, { sleep: noSleep });
  assert.equal(calls, 1);
});

await test("fetchGetWithRetry: 5xx then success -> retried once, success returned", async () => {
  const statuses = [500, 200];
  let calls = 0;
  globalThis.fetch = async () => res(statuses[calls++]);
  const r = await fetchGetWithRetry("https://x", {}, { sleep: noSleep });
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
});

await test("fetchGetWithRetry: backoff delay is applied between attempts", async () => {
  const delays = [];
  globalThis.fetch = async () => res(503);
  const r = await fetchGetWithRetry("https://x", {}, { retries: 2, baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(r.status, 503, "after retries are exhausted the last 5xx response is returned for the caller to classify");
  assert.deepEqual(delays, [100, 200]);
});

await test("fetchGetWithRetry: 4xx is returned immediately, never retried", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res(404); };
  const r = await fetchGetWithRetry("https://x", {}, { sleep: noSleep });
  assert.equal(r.status, 404);
  assert.equal(calls, 1);
});

await test("fetchGetWithRetry: network error then success -> retried; network error twice -> NetworkError", async () => {
  let calls = 0;
  globalThis.fetch = async () => { if (calls++ === 0) throw new TypeError("boom"); return res(200); };
  assert.equal((await fetchGetWithRetry("https://x", {}, { sleep: noSleep })).status, 200);
  calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("boom"); };
  await assert.rejects(() => fetchGetWithRetry("https://x", {}, { sleep: noSleep }), (e) => e instanceof NetworkError);
  assert.equal(calls, 2);
});

await test("fetchGetWithRetry: retries=0 disables retrying entirely", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res(500); };
  await fetchGetWithRetry("https://x", {}, { retries: 0, sleep: noSleep });
  assert.equal(calls, 1);
});

await test("netConfig defaults are sane (15s deadline, one retry)", () => {
  assert.equal(netConfig.timeoutMs, 15000);
  assert.equal(netConfig.retries, 1);
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
