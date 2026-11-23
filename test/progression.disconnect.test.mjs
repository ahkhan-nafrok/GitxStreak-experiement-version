// test/progression.disconnect.test.mjs
// Product decision (design doc is silent, my recommendation, easy to reverse):
// DISCONNECT removes the token and the cached GitHub data but KEEPS progression.
// Reason: "Reconnect" after an expired token goes through the same code path —
// wiping XP there would punish the user for a routine 401. XP is only deleted by
// an explicit reset(), and a different GitHub account can never write into it.
//
// Run with: node test/progression.disconnect.test.mjs
import assert from "node:assert/strict";
import { createFakeIndexedDB } from "./helpers/fakeIndexedDB.mjs";

globalThis.indexedDB = createFakeIndexedDB().indexedDB;
if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;

const { saveConnection, disconnect } = await import("../lib/connection.js");
const { getToken } = await import("../lib/tokenVault.js");
const { PULSE_CACHE_KEY } = await import("../lib/accountData.js");
const { createProgressionStore, PROGRESSION_KEY, CONFIG_KEY } = await import("../lib/progression/store.js");
const { syncProgressionFromPulse } = await import("../lib/progression/sync.js");
const { createProjectStore } = await import("../lib/projectStore.js");
const { makeAdapter } = await import("./helpers/memoryAdapter.mjs");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}

const TODAY = "2026-11-24";
const cache = (viewerId) => ({ viewerId, asOfDateKey: TODAY, dayMap: { [TODAY]: { count: 2 } } });

await test("disconnect wipes the token/cache but KEEPS XP, ledger and preferences", async () => {
  globalThis.indexedDB = createFakeIndexedDB().indexedDB;
  const a = makeAdapter();
  await saveConnection(a, "ghp_token_one");
  await createProgressionStore(a).setConfig({ weeklyTarget: 4 }, { todayKey: TODAY });
  await a.set({ [PULSE_CACHE_KEY]: { connectionId: "x", dayMap: {} } });
  const paid = await syncProgressionFromPulse(a, cache("USER-A"));
  assert.equal(paid.status, "ok");
  assert.equal(paid.newAwards.length, 1);
  const ledgerBefore = JSON.stringify(a._store[PROGRESSION_KEY]);

  await disconnect(a);
  assert.equal(await getToken(a), null);
  assert.equal(a._store[PULSE_CACHE_KEY], null);
  assert.equal(JSON.stringify(a._store[PROGRESSION_KEY]), ledgerBefore, "progression untouched by disconnect");
  assert.equal(a._store[CONFIG_KEY].weeklyTarget, 4);
});

await test("reconnecting the SAME account continues the same ledger; no double pay", async () => {
  globalThis.indexedDB = createFakeIndexedDB().indexedDB;
  const a = makeAdapter();
  await saveConnection(a, "ghp_one");
  await syncProgressionFromPulse(a, cache("USER-A"));
  await disconnect(a);
  await saveConnection(a, "ghp_two");
  const again = await syncProgressionFromPulse(a, cache("USER-A"));
  assert.equal(again.status, "ok");
  assert.deepEqual(again.newAwards, []);
  assert.equal(a._store[PROGRESSION_KEY].ledger.length, 1);
});

await test("connecting a DIFFERENT account can't pay into (or read) the previous account's XP", async () => {
  globalThis.indexedDB = createFakeIndexedDB().indexedDB;
  const a = makeAdapter();
  await saveConnection(a, "ghp_one");
  await syncProgressionFromPulse(a, cache("USER-A"));
  const snapshot = JSON.stringify(a._store[PROGRESSION_KEY]);
  await disconnect(a);
  await saveConnection(a, "ghp_other_person");
  const r = await syncProgressionFromPulse(a, cache("USER-B"));
  assert.equal(r.status, "account-mismatch");
  assert.equal(JSON.stringify(a._store[PROGRESSION_KEY]), snapshot);
  // The explicit way out: reset, then the new account starts from zero.
  await createProgressionStore(a).reset();
  const fresh = await syncProgressionFromPulse(a, cache("USER-B"));
  assert.equal(fresh.status, "ok");
  assert.equal(a._store[PROGRESSION_KEY].userId, "USER-B");
});

await test("progression data never contains private repo names even when private repos are tracked", async () => {
  globalThis.indexedDB = createFakeIndexedDB().indexedDB;
  const a = makeAdapter();
  await saveConnection(a, "ghp_one");
  await createProjectStore(a).create("me/secret-project", "secret-project", "me/secret-project");
  await syncProgressionFromPulse(a, cache("USER-A"));
  assert.ok(!JSON.stringify(a._store[PROGRESSION_KEY]).includes("secret-project"));
});

await test("syncProgressionFromPulse ignores an unusable cache (no identity / no data)", async () => {
  const a = makeAdapter();
  for (const bad of [null, {}, { dayMap: {} }, { viewerId: "u", dayMap: {} }, { viewerId: "u", asOfDateKey: TODAY }]) {
    assert.equal((await syncProgressionFromPulse(a, bad)).status, "no-identity");
  }
  assert.equal(a._store[PROGRESSION_KEY], undefined);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
