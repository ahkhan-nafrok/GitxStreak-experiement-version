// test/deviceFlow.scope.test.mjs — scope handling across deviceFlow, the runner, and saveConnection.
// Run with: node test/deviceFlow.scope.test.mjs
import assert from "node:assert/strict";
import { createFakeIndexedDB } from "./helpers/fakeIndexedDB.mjs";
import { requestDeviceCode, interpretTokenResponse, DeviceFlowError } from "../lib/deviceFlow.js";
import { createDeviceFlowRunner, SESSION_KEY } from "../lib/deviceFlowRunner.js";
import { SCOPE_PUBLIC, SCOPE_PRIVATE } from "../lib/scopes.js";

globalThis.indexedDB = createFakeIndexedDB().indexedDB;
if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;
const { saveConnection, disconnect } = await import("../lib/connection.js");
const { getGrantedScopes } = await import("../lib/authState.js");

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); } }
const GOOD = { device_code: "d", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 };
const okRes = (body) => ({ ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => body });
const originalFetch = globalThis.fetch;
const sentScope = async (arg) => { let scope; globalThis.fetch = async (u, o) => { scope = new URLSearchParams(o.body).get("scope"); return okRes(GOOD); }; await requestDeviceCode(arg); return scope; };

await test("requestDeviceCode requests ONLY read:user by default", async () => { assert.equal(await sentScope(), SCOPE_PUBLIC); assert.equal(await sentScope({}), SCOPE_PUBLIC); });
await test("requestDeviceCode can request the private tier when asked", async () => { assert.equal(await sentScope({ scope: SCOPE_PRIVATE }), SCOPE_PRIVATE); });
await test("requestDeviceCode refuses any scope string outside the vetted two — and sends nothing", async () => {
  let called = false; globalThis.fetch = async () => { called = true; return okRes(GOOD); };
  for (const bad of ["repo", "admin:org", "repo read:user delete_repo", "", null]) await assert.rejects(() => requestDeviceCode({ scope: bad }), (e) => e instanceof DeviceFlowError && e.code === "bad_request");
  assert.equal(called, false);
});

await test("interpretTokenResponse: surfaces the granted scope when GitHub reports one, and keeps the old shape when it doesn't", () => {
  assert.deepEqual(interpretTokenResponse({ access_token: "ghu_x", scope: "repo,read:user" }, 5), { status: "success", token: "ghu_x", scope: "repo,read:user" });
  assert.deepEqual(interpretTokenResponse({ access_token: "ghu_x" }, 5), { status: "success", token: "ghu_x" });
});

function runnerEnv(checkTokenOnce) {
  const data = {}; const calls = []; const saved = [];
  const storage = { async get(k) { const o = {}; for (const x of k) if (x in data) o[x] = structuredClone(data[x]); return o; }, async set(o) { Object.assign(data, structuredClone(o)); }, async remove(k) { for (const x of [].concat(k)) delete data[x]; } };
  const alarms = { async create() {}, async clear() {}, async get() { return {}; } };
  let t = 1_000_000;
  const runner = createDeviceFlowRunner({
    storage, alarms,
    requestDeviceCode: async (opts) => { calls.push(opts); return { deviceCode: "dc", userCode: "U", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 }; },
    checkTokenOnce, onSuccess: async (token, info) => { saved.push({ token, info }); }, broadcast() {}, now: () => t,
  });
  return { runner, calls, saved, advance: (ms) => { t += ms; } };
}

await test("runner: startFlow() asks for the public tier; startFlow({includePrivate:true}) asks for the private tier", async () => {
  const a = runnerEnv(async () => ({ status: "pending" }));
  await a.runner.startFlow();
  assert.equal(a.calls[0].scope, SCOPE_PUBLIC);
  const b = runnerEnv(async () => ({ status: "pending" }));
  await b.runner.startFlow({ includePrivate: true });
  assert.equal(b.calls[0].scope, SCOPE_PRIVATE);
});
await test("runner: a truthy-but-not-true includePrivate does NOT widen the request", async () => {
  const e = runnerEnv(async () => ({ status: "pending" }));
  await e.runner.startFlow({ includePrivate: "true" });
  assert.equal(e.calls[0].scope, SCOPE_PUBLIC);
});
await test("runner: success hands onSuccess the GRANTED scopes parsed into an array (null when GitHub didn't say)", async () => {
  const e = runnerEnv(async () => ({ status: "success", token: "ghu_1", scope: "repo,read:user" }));
  await e.runner.startFlow({ includePrivate: true }); e.advance(6000); await e.runner.pollOnce();
  assert.deepEqual(e.saved, [{ token: "ghu_1", info: { scopes: ["repo", "read:user"] } }]);
  const f = runnerEnv(async () => ({ status: "success", token: "ghu_2" }));
  await f.runner.startFlow(); f.advance(6000); await f.runner.pollOnce();
  assert.deepEqual(f.saved[0].info, { scopes: null });
});

await test("saveConnection records the granted scopes; unknown stays null; disconnect forgets them", async () => {
  globalThis.indexedDB = createFakeIndexedDB().indexedDB;
  let store = {};
  const a = { async get(k) { const o = {}; for (const x of k) if (x in store) o[x] = structuredClone(store[x]); return o; }, async set(o) { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); } };
  await saveConnection(a, "ghp_x", { scopes: ["read:user"] });
  assert.deepEqual(await getGrantedScopes(a), ["read:user"]);
  await saveConnection(a, "ghp_y"); // e.g. fine-grained PAT: unknown
  assert.equal(await getGrantedScopes(a), null, "a reconnect must not inherit the previous token's scopes");
  await saveConnection(a, "ghp_z", { scopes: ["repo"] });
  await disconnect(a);
  assert.equal(await getGrantedScopes(a), null);
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
