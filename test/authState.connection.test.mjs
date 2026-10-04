// test/authState.connection.test.mjs
// The parts of lib/authState.js that authState.test.mjs doesn't cover:
// ghHasEverConnected and the connection id.
// Run with: node test/authState.connection.test.mjs
import assert from "node:assert/strict";
import { getHasEverConnected, setHasEverConnected, getConnectionId, rotateConnectionId, ensureConnectionId } from "../lib/authState.js";
import { cacheBelongsTo } from "../lib/accountData.js";

if (!globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}
function makeMockAdapter() {
  let store = {};
  return { async get(keys) { const o = {}; for (const k of keys) o[k] = store[k]; return o; }, async set(obj) { store = { ...store, ...obj }; }, _dump: () => store };
}

await test("getHasEverConnected defaults to false; set(true) sticks; coerces to a strict boolean", async () => {
  const a = makeMockAdapter();
  assert.equal(await getHasEverConnected(a), false);
  await setHasEverConnected(a, "yes");
  assert.equal(a._dump().ghHasEverConnected, true);
  assert.equal(await getHasEverConnected(a), true);
});

await test("getConnectionId is null when there is no connection", async () => {
  assert.equal(await getConnectionId(makeMockAdapter()), null);
});

await test("rotateConnectionId mints a new, different id every time", async () => {
  const a = makeMockAdapter();
  const first = await rotateConnectionId(a);
  const second = await rotateConnectionId(a);
  assert.ok(first && second && first !== second);
  assert.equal(await getConnectionId(a), second);
});

await test("ensureConnectionId is stable once an id exists, and mints one for a legacy install that has none", async () => {
  const a = makeMockAdapter();
  const minted = await ensureConnectionId(a);
  assert.ok(minted);
  assert.equal(await ensureConnectionId(a), minted);
  assert.equal(await ensureConnectionId(a), minted);
});

await test("cacheBelongsTo: only a cache stamped with the CURRENT connection id is trusted", () => {
  assert.equal(cacheBelongsTo({ connectionId: "A", dayMap: {} }, "A"), true);
  assert.equal(cacheBelongsTo({ connectionId: "A" }, "B"), false, "another connection's cache");
  assert.equal(cacheBelongsTo({ dayMap: {} }, "A"), false, "a legacy cache with no stamp");
  assert.equal(cacheBelongsTo({ connectionId: "A" }, null), false, "no active connection");
  assert.equal(cacheBelongsTo(null, "A"), false);
  assert.equal(cacheBelongsTo({ connectionId: undefined }, undefined), false, "undefined must never match undefined");
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
