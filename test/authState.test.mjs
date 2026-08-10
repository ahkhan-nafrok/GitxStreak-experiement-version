// test/authState.test.mjs
// Tests for lib/authState.js — the plain (non-encrypted) flag tracking
// whether the currently-saved token has started failing auth. Deliberately
// simple: this is the entire surface area of that file, so the tests match.
//
// Run with: node test/authState.test.mjs

import assert from "node:assert/strict";
import { getAuthFailed, setAuthFailed } from "../lib/authState.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.message}`);
  }
}

function makeMockAdapter() {
  let store = {};
  return {
    async get(keys) {
      const out = {};
      for (const k of keys) out[k] = store[k];
      return out;
    },
    async set(obj) {
      store = { ...store, ...obj };
    },
    _dump: () => store,
  };
}

await test("getAuthFailed defaults to false when nothing has ever been set", async () => {
  const adapter = makeMockAdapter();
  assert.equal(await getAuthFailed(adapter), false);
});

await test("setAuthFailed(true) then getAuthFailed reads true", async () => {
  const adapter = makeMockAdapter();
  await setAuthFailed(adapter, true);
  assert.equal(await getAuthFailed(adapter), true);
});

await test("setAuthFailed(false) clears a previously-set true", async () => {
  const adapter = makeMockAdapter();
  await setAuthFailed(adapter, true);
  await setAuthFailed(adapter, false);
  assert.equal(await getAuthFailed(adapter), false);
});

await test("setAuthFailed coerces truthy/falsy input to a strict boolean, never stores garbage", async () => {
  const adapter = makeMockAdapter();
  await setAuthFailed(adapter, "yes"); // truthy, not a real boolean
  assert.equal(adapter._dump().ghTokenAuthFailed, true);
  await setAuthFailed(adapter, 0); // falsy, not a real boolean
  assert.equal(adapter._dump().ghTokenAuthFailed, false);
});

await test("getAuthFailed ignores unrelated keys already present in storage", async () => {
  const adapter = makeMockAdapter();
  await adapter.set({ ghTokenEncrypted: { ciphertext: "x", iv: "y" }, someOtherKey: 42 });
  assert.equal(await getAuthFailed(adapter), false, "an unrelated key must not be misread as the auth-failed flag");
});

await test("the flag is scoped per adapter instance — no shared module-level state leaking between callers", async () => {
  const a = makeMockAdapter();
  const b = makeMockAdapter();
  await setAuthFailed(a, true);
  assert.equal(await getAuthFailed(b), false, "setting the flag via one adapter must not leak into another");
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;