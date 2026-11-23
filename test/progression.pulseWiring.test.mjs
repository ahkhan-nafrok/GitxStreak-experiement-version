// test/progression.pulseWiring.test.mjs
// The REAL pulseView.js (strict fake DOM/chrome, real vault, mocked GitHub):
// a successful fetch pays XP via lib/progression, the identity comes from the
// same GraphQL call (no extra request), and nothing about progression — absent
// identity, a storage failure — can change what Pulse shows.
//
// Run with: node test/progression.pulseWiring.test.mjs
import assert from "node:assert/strict";
import { setup, waitFor, jsonResponse } from "./helpers/fakeDom.mjs";

if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;

const { initPulseView } = await import("../pulseView.js");
const { initToast } = await import("../toast.js");
const { chromeStorageAdapter: adapter } = await import("../lib/storageAdapter.js");
const { saveConnection } = await import("../lib/connection.js");
const { PULSE_CACHE_KEY } = await import("../lib/accountData.js");
const { toDateKeyUTC } = await import("../lib/pulse.js");
const { PROGRESSION_KEY } = await import("../lib/progression/store.js");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}

const originalFetch = globalThis.fetch;
const TODAY = toDateKeyUTC(new Date());
const GRAPHQL = "https://api.github.com/graphql";

function body({ viewerId, todayCount = 3 } = {}) {
  const day = (date, contributionCount) => ({ date, contributionCount });
  const viewer = { contributionsCollection: { contributionCalendar: { weeks: [{ contributionDays: [day(TODAY, todayCount)] }] } } };
  if (viewerId !== undefined) viewer.id = viewerId;
  return { data: { viewer } };
}
function mock(graphqlBody) {
  const calls = { graphql: 0, other: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === GRAPHQL) { calls.graphql++; return jsonResponse(graphqlBody); }
    if (u.includes("/user/repos")) { calls.other++; return jsonResponse([]); }
    throw new Error(`Unhandled mock URL: ${u}`);
  };
  return calls;
}
async function boot() {
  const w = setup();
  initToast();
  await saveConnection(adapter, "ghp_abcdefgh12345678", { scopes: ["read:user"] });
  initPulseView();
  return w;
}
const rendered = (w) => !w.el("pulse-calendar-wrap").hidden;

await test("a fresh fetch stamps the cache with the viewer id and pays first-active-day (live tracking starts now)", async () => {
  const calls = mock(body({ viewerId: "MDQ6VXNlcjE=" }));
  const w = await boot();
  await waitFor(() => w.store[PROGRESSION_KEY], "progression state");
  assert.equal(w.store[PULSE_CACHE_KEY].viewerId, "MDQ6VXNlcjE=");
  assert.equal(w.store[PROGRESSION_KEY].userId, "MDQ6VXNlcjE=");
  assert.equal(w.store[PROGRESSION_KEY].trackingStartKey, TODAY);
  assert.deepEqual(w.store[PROGRESSION_KEY].ledger.map((e) => e.ruleId), ["first-active-day"]);
  assert.equal(calls.graphql, 1, "identity rides on the existing GraphQL call — no extra requests");
});

await test("clicking Update again does not pay again (idempotent end to end)", async () => {
  mock(body({ viewerId: "u1" }));
  const w = await boot();
  await waitFor(() => w.store[PROGRESSION_KEY], "progression state");
  const before = JSON.stringify(w.store[PROGRESSION_KEY]);
  for (let i = 0; i < 3; i++) await w.el("pulse-refresh-btn").dispatch("click"), await new Promise((r) => setTimeout(r, 30));
  assert.equal(JSON.stringify(w.store[PROGRESSION_KEY]), before);
});

await test("a response with no viewer id still renders Pulse and writes no progression", async () => {
  mock(body({ viewerId: undefined }));
  const w = await boot();
  await waitFor(() => rendered(w) && w.store[PULSE_CACHE_KEY], "render");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.store[PROGRESSION_KEY], undefined);
  assert.equal(w.store[PULSE_CACHE_KEY].viewerId, null);
  assert.notEqual(w.el("pulse-streak").textContent, "—");
});

await test("if the progression write FAILS (e.g. storage quota), Pulse still renders normally", async () => {
  mock(body({ viewerId: "u1" }));
  const w = await boot();
  const set = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = (obj, cb) => {
    if (PROGRESSION_KEY in obj) { globalThis.chrome.runtime.lastError = { message: "QUOTA_BYTES quota exceeded" }; cb(); globalThis.chrome.runtime.lastError = null; return; }
    set(obj, cb);
  };
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    await w.el("pulse-refresh-btn").dispatch("click");
    await waitFor(() => rendered(w) && w.el("pulse-streak").textContent !== "—", "render despite failure");
    await waitFor(() => warned > 0, "failure is logged, not thrown");
  } finally { console.warn = warn; }
  assert.equal(w.el("pulse-update-btn-label").textContent, "Updated", "the Update button is not stuck or errored");
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
