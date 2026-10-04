// test/connection.test.mjs
// lib/connection.js — what connecting and disconnecting actually do to the
// data on disk, using the REAL token vault over a fake IndexedDB.
// Run with: node test/connection.test.mjs
import assert from "node:assert/strict";
import { createFakeIndexedDB } from "./helpers/fakeIndexedDB.mjs";

let fakeDb = createFakeIndexedDB();
globalThis.indexedDB = fakeDb.indexedDB;
if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;

const { saveConnection, disconnect } = await import("../lib/connection.js");
const { getToken } = await import("../lib/tokenVault.js");
const { getAuthFailed, setAuthFailed, getHasEverConnected, getConnectionId } = await import("../lib/authState.js");
const { PULSE_CACHE_KEY, cacheBelongsTo } = await import("../lib/accountData.js");
const { createProjectStore } = await import("../lib/projectStore.js");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}
function freshAdapter() {
  fakeDb = createFakeIndexedDB();
  globalThis.indexedDB = fakeDb.indexedDB;
  let store = {};
  return { async get(keys) { const o = {}; for (const k of keys) if (k in store) o[k] = structuredClone(store[k]); return o; }, async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v); }, _dump: () => store };
}

await test("saveConnection: token is retrievable, flags set, a connection id exists, and a prior auth-failure is cleared", async () => {
  const a = freshAdapter();
  await setAuthFailed(a, true);
  await saveConnection(a, "ghp_token_one");
  assert.equal(await getToken(a), "ghp_token_one");
  assert.equal(await getAuthFailed(a), false);
  assert.equal(await getHasEverConnected(a), true);
  assert.ok(await getConnectionId(a));
});

await test("saveConnection: every (re)connection gets a NEW connection id, instantly orphaning the previous cache", async () => {
  const a = freshAdapter();
  await saveConnection(a, "ghp_account_A");
  const idA = await getConnectionId(a);
  await a.set({ [PULSE_CACHE_KEY]: { connectionId: idA, dayMap: { "2026-01-01": { count: 5 } }, lastPushedRepos: [{ fullName: "a/private" }] } });
  assert.equal(cacheBelongsTo((await a.get([PULSE_CACHE_KEY]))[PULSE_CACHE_KEY], idA), true);

  await saveConnection(a, "ghp_account_B"); // user switches account without disconnecting first
  const idB = await getConnectionId(a);
  assert.notEqual(idA, idB);
  assert.equal(cacheBelongsTo((await a.get([PULSE_CACHE_KEY]))[PULSE_CACHE_KEY], idB), false, "account A's cache must not be trusted under account B's connection");
});

await test("disconnect: removes token, key, cache and connection id; clears auth-failed; keeps hasEverConnected", async () => {
  const a = freshAdapter();
  await saveConnection(a, "ghp_secret_value");
  await setAuthFailed(a, true);
  await a.set({ [PULSE_CACHE_KEY]: { connectionId: await getConnectionId(a), lastPushedRepos: [{ fullName: "me/secret-repo" }] } });

  await disconnect(a);

  assert.equal(await getToken(a), null);
  assert.equal(fakeDb._inspectRawStore("gitstreak_vault", "keys").get("token-key"), undefined, "vault key deleted too");
  assert.equal(a._dump()[PULSE_CACHE_KEY], null, "cached account data is wiped");
  assert.equal(await getConnectionId(a), null);
  assert.equal(await getAuthFailed(a), false);
  assert.equal(await getHasEverConnected(a), true, "'has ever connected' must survive disconnect (drives the reconnect copy)");
  assert.ok(!JSON.stringify(a._dump()).includes("secret-repo"), "no private repo name may remain anywhere in storage");
});

await test("disconnect: tracked PRIVATE repos are removed; public and never-checked ones stay", async () => {
  const a = freshAdapter();
  await saveConnection(a, "ghp_x");
  const store = createProjectStore(a);
  await store.create("priv", "Priv", "me/priv");
  await store.create("pub", "Pub", "me/pub");
  await store.create("fresh", "Fresh", "me/fresh");
  await store.updateRepoMeta("priv", { private: true });
  await store.updateRepoMeta("pub", { private: false });

  await disconnect(a);

  assert.deepEqual((await createProjectStore(a).list()).map((p) => p.id).sort(), ["fresh", "pub"]);
});

await test("disconnect on a never-connected install is a harmless no-op", async () => {
  const a = freshAdapter();
  await disconnect(a);
  assert.equal(await getToken(a), null);
  assert.equal(await getHasEverConnected(a), false);
});

await test("disconnect then reconnect: a fresh vault key, a new id, and no data carried over", async () => {
  const a = freshAdapter();
  await saveConnection(a, "ghp_first");
  const id1 = await getConnectionId(a);
  await disconnect(a);
  await saveConnection(a, "ghp_second");
  assert.equal(await getToken(a), "ghp_second");
  assert.notEqual(await getConnectionId(a), id1);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
