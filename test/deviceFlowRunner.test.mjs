// test/deviceFlowRunner.test.mjs
// The device-flow state machine with every side effect faked: storage,
// alarms, clock, network, and the token-saving callback.
// Run with: node test/deviceFlowRunner.test.mjs
import assert from "node:assert/strict";
import {
  createDeviceFlowRunner, SESSION_KEY, LAST_RESULT_KEY, ALARM_NAME, STATUS_MESSAGE_TYPE,
  MAX_CONSECUTIVE_TRANSIENT_FAILURES,
} from "../lib/deviceFlowRunner.js";
import { DeviceFlowError } from "../lib/deviceFlow.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function makeEnv({ checkTokenOnce, requestDeviceCode, onSuccess } = {}) {
  const data = {};
  const alarmMap = new Map();
  const sent = [];
  const successes = [];
  let t = 1_000_000;
  let codeCounter = 0;
  const storage = {
    async get(keys) { const o = {}; for (const k of keys) if (k in data) o[k] = structuredClone(data[k]); return o; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
  const alarms = {
    async create(name, info) { alarmMap.set(name, info); },
    async clear(name) { return alarmMap.delete(name); },
    async get(name) { return alarmMap.get(name); },
  };
  const runner = createDeviceFlowRunner({
    storage, alarms,
    requestDeviceCode: requestDeviceCode || (async () => ({ deviceCode: `dc${++codeCounter}`, userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 })),
    checkTokenOnce: checkTokenOnce || (async () => ({ status: "pending" })),
    onSuccess: onSuccess || (async (token) => { successes.push(token); }),
    broadcast: (m) => sent.push(m),
    now: () => t,
  });
  return {
    runner, data, alarmMap, sent, successes,
    advance: (ms) => { t += ms; },
    session: () => data[SESSION_KEY],
    lastResult: () => data[LAST_RESULT_KEY],
    statuses: () => sent.map((m) => m.status),
  };
}
const scripted = (steps) => { const calls = []; const fn = async (dc, iv) => { calls.push(dc); const s = steps[Math.min(calls.length - 1, steps.length - 1)]; if (s instanceof Error) throw s; return s; }; fn.calls = calls; return fn; };
const netErr = () => new DeviceFlowError("Network error: down", "network");

await test("startFlow: persists the session, arms an alarm (>= 1 minute), broadcasts code_ready with the interval", async () => {
  const env = makeEnv();
  await env.runner.startFlow();
  assert.equal(env.session().userCode, "ABCD-1234");
  assert.equal(env.session().deviceCode, "dc1");
  assert.ok(env.alarmMap.get(ALARM_NAME).delayInMinutes >= 1);
  const msg = env.sent.at(-1);
  assert.deepEqual([msg.type, msg.status, msg.userCode, msg.interval], [STATUS_MESSAGE_TYPE, "code_ready", "ABCD-1234", 5]);
});

await test("startFlow: a failed device-code request stores an error result, leaves no session or alarm", async () => {
  const env = makeEnv({ requestDeviceCode: async () => { throw new DeviceFlowError("boom", "network"); } });
  await env.runner.startFlow();
  assert.equal(env.session(), undefined);
  assert.equal(env.alarmMap.size, 0);
  assert.deepEqual(env.lastResult(), { status: "error", message: "boom" });
  assert.equal(env.sent.at(-1).status, "error");
});

await test("pollOnce: pending keeps the flow alive and resets the failure counter", async () => {
  const check = scripted([netErr(), { status: "pending" }]);
  const env = makeEnv({ checkTokenOnce: check });
  await env.runner.startFlow();
  env.advance(6000); await env.runner.pollOnce();
  assert.equal(env.session().failures, 1);
  env.advance(6000); await env.runner.pollOnce();
  assert.equal(env.session().failures, 0);
  assert.ok(env.session());
});

await test("transient network errors do NOT end the flow; MAX consecutive ones do", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([netErr()]) });
  await env.runner.startFlow();
  for (let i = 1; i < MAX_CONSECUTIVE_TRANSIENT_FAILURES; i++) {
    env.advance(6000); await env.runner.pollOnce();
    assert.ok(env.session(), `still alive after ${i} consecutive transient failure(s)`);
  }
  env.advance(6000); await env.runner.pollOnce();
  assert.equal(env.session(), undefined, "ended after the final consecutive failure");
  assert.equal(env.lastResult().status, "error");
  assert.equal(env.alarmMap.size, 0);
});

await test("an intervening success-poll resets the streak: fail,fail,pending,fail,fail,fail stays alive", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([netErr(), netErr(), { status: "pending" }, netErr(), netErr(), netErr(), { status: "pending" }]) });
  await env.runner.startFlow();
  for (let i = 0; i < 6; i++) { env.advance(6000); await env.runner.pollOnce(); }
  assert.ok(env.session(), "3 consecutive failures after a reset is below the limit");
});

await test("a non-network error (access_denied) is terminal immediately and clears session + alarm", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([new DeviceFlowError("You declined the request on GitHub.", "access_denied")]) });
  await env.runner.startFlow();
  env.advance(6000); await env.runner.pollOnce();
  assert.equal(env.session(), undefined);
  assert.equal(env.alarmMap.size, 0);
  assert.equal(env.lastResult().message, "You declined the request on GitHub.");
});

await test("an unexpected (non-DeviceFlowError) exception is terminal, not retried", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([new TypeError("kaboom")]) });
  await env.runner.startFlow();
  env.advance(6000); await env.runner.pollOnce();
  assert.equal(env.session(), undefined);
  assert.match(env.lastResult().message, /Unexpected error: kaboom/);
});

await test("success: onSuccess gets the token, then session + alarm are cleared and success is broadcast", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([{ status: "success", token: "ghu_abc" }]) });
  await env.runner.startFlow();
  env.advance(6000); await env.runner.pollOnce();
  assert.deepEqual(env.successes, ["ghu_abc"]);
  assert.equal(env.session(), undefined);
  assert.equal(env.alarmMap.size, 0);
  assert.equal(env.sent.at(-1).status, "success");
});

await test("success but onSuccess throws: surfaced as a terminal error, session cleared (no silent loss)", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([{ status: "success", token: "ghu_abc" }]), onSuccess: async () => { throw new Error("disk full"); } });
  await env.runner.startFlow();
  env.advance(6000); await env.runner.pollOnce();
  assert.equal(env.session(), undefined);
  assert.match(env.lastResult().message, /saving the token failed: disk full/);
});

await test("slow_down: stores the new interval and re-arms the alarm", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([{ status: "slow_down", newInterval: 120 }]) });
  await env.runner.startFlow();
  env.advance(6000); await env.runner.pollOnce();
  assert.equal(env.session().interval, 120);
  assert.equal(env.alarmMap.get(ALARM_NAME).periodInMinutes, 2);
  assert.equal(env.sent.at(-1).status, "slow_down");
});

await test("expiry: polling past expiresAt reports 'expired' and clears everything", async () => {
  const check = scripted([{ status: "pending" }]);
  const env = makeEnv({ checkTokenOnce: check });
  await env.runner.startFlow();
  env.advance(901_000); await env.runner.pollOnce();
  assert.equal(check.calls.length, 0, "no network call for an already-expired code");
  assert.equal(env.session(), undefined);
  assert.match(env.lastResult().message, /expired/);
});

await test("RACE: cancel while a poll is in flight -> a late success never saves a token", async () => {
  const d = deferred();
  const env = makeEnv({ checkTokenOnce: () => d.promise });
  await env.runner.startFlow();
  env.advance(6000);
  const poll = env.runner.pollOnce();
  await tick();
  await env.runner.cancelFlow();
  d.resolve({ status: "success", token: "ghu_late" });
  await poll;
  assert.deepEqual(env.successes, [], "cancelled flow must not save a token");
  assert.equal(env.session(), undefined);
});

await test("RACE: cancel while a poll is in flight -> a late slow_down can't resurrect the session or alarm", async () => {
  const d = deferred();
  const env = makeEnv({ checkTokenOnce: () => d.promise });
  await env.runner.startFlow();
  env.advance(6000);
  const poll = env.runner.pollOnce();
  await tick();
  await env.runner.cancelFlow();
  d.resolve({ status: "slow_down", newInterval: 10 });
  await poll;
  assert.equal(env.session(), undefined);
  assert.equal(env.alarmMap.size, 0);
});

await test("RACE: cancel while a poll is in flight -> a late network error can't write an error over the cancel", async () => {
  const d = deferred();
  const env = makeEnv({ checkTokenOnce: () => d.promise });
  await env.runner.startFlow();
  env.advance(6000);
  const poll = env.runner.pollOnce();
  await tick();
  await env.runner.cancelFlow();
  d.reject(new TypeError("late failure"));
  await poll;
  assert.equal(env.lastResult(), undefined);
});

await test("RACE: restarting the flow while a poll for the OLD code is in flight drops the old result", async () => {
  const d = deferred();
  const env = makeEnv({ checkTokenOnce: () => d.promise });
  await env.runner.startFlow(); // dc1
  env.advance(6000);
  const poll = env.runner.pollOnce();
  await tick();
  await env.runner.startFlow(); // dc2 replaces dc1
  d.resolve({ status: "success", token: "ghu_for_old_code" });
  await poll;
  assert.deepEqual(env.successes, []);
  assert.equal(env.session().deviceCode, "dc2", "the new flow's session is untouched");
});

await test("RACE: cancel while the device-code request is still pending -> the late code never becomes a session", async () => {
  const d = deferred();
  const env = makeEnv({ requestDeviceCode: () => d.promise });
  const start = env.runner.startFlow();
  await tick();
  await env.runner.cancelFlow();
  d.resolve({ deviceCode: "late", userCode: "X", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 });
  await start;
  assert.equal(env.session(), undefined);
  assert.equal(env.alarmMap.size, 0);
  assert.ok(!env.sent.some((m) => m.status === "code_ready"));
});

await test("rate guard: never polls faster than GitHub's interval; concurrent callers cause one request", async () => {
  const check = scripted([{ status: "pending" }]);
  const env = makeEnv({ checkTokenOnce: check });
  await env.runner.startFlow();
  env.advance(6000);
  await Promise.all([env.runner.pollOnce(), env.runner.pollOnce()]);
  assert.equal(check.calls.length, 1, "overlapping callers share one poll");
  await env.runner.pollOnce(); // immediately again: inside the interval
  assert.equal(check.calls.length, 1, "a second poll inside the interval is skipped");
  env.advance(5000); await env.runner.pollOnce();
  assert.equal(check.calls.length, 2);
});

await test("pollOnce with no session clears a stray alarm and does nothing else", async () => {
  const check = scripted([{ status: "pending" }]);
  const env = makeEnv({ checkTokenOnce: check });
  env.alarmMap.set(ALARM_NAME, {});
  await env.runner.pollOnce();
  assert.equal(env.alarmMap.size, 0);
  assert.equal(check.calls.length, 0);
});

await test("queryStatus: an active session returns code_ready and re-arms a LOST alarm (browser restart)", async () => {
  const env = makeEnv();
  await env.runner.startFlow();
  env.alarmMap.clear();
  const status = await env.runner.queryStatus();
  assert.deepEqual([status.status, status.userCode, status.interval], ["code_ready", "ABCD-1234", 5]);
  assert.ok(env.alarmMap.has(ALARM_NAME));
});

await test("queryStatus: an EXPIRED session is reported as an error and cleared (no dead code on screen)", async () => {
  const env = makeEnv();
  await env.runner.startFlow();
  env.advance(901_000);
  const status = await env.runner.queryStatus();
  assert.equal(status.status, "error");
  assert.match(status.message, /expired/);
  assert.equal(env.session(), undefined);
  assert.equal(env.alarmMap.size, 0);
});

await test("queryStatus / ackStatus: a terminal result is returned until acknowledged, then gone", async () => {
  const env = makeEnv({ checkTokenOnce: scripted([new DeviceFlowError("denied", "access_denied")]) });
  await env.runner.startFlow();
  env.advance(6000); await env.runner.pollOnce();
  assert.equal((await env.runner.queryStatus()).message, "denied");
  await env.runner.ackStatus();
  assert.equal(await env.runner.queryStatus(), null);
});

await test("cancelFlow: clears session, alarm and any stale result, and broadcasts cancelled", async () => {
  const env = makeEnv();
  await env.runner.startFlow();
  await env.runner.cancelFlow();
  assert.equal(env.session(), undefined);
  assert.equal(env.alarmMap.size, 0);
  assert.equal(env.sent.at(-1).status, "cancelled");
});

await test("resume(): re-arms a lost alarm for a live session, and retires an expired one", async () => {
  const env = makeEnv();
  await env.runner.startFlow();
  env.alarmMap.clear();
  await env.runner.resume();
  assert.ok(env.alarmMap.has(ALARM_NAME));
  env.advance(901_000);
  await env.runner.resume();
  assert.equal(env.session(), undefined);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
