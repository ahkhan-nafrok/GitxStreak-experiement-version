// test/progression.scale.test.mjs — does it hold up with years of data?
// Timing bounds are deliberately LOOSE (CI machines vary); the printed numbers
// are the real signal. Run with: node test/progression.scale.test.mjs
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { computeStreaks } from "../lib/progression/streaks.js";
import { deriveAwards } from "../lib/progression/xp.js";
import { createProgressionStore, PROGRESSION_KEY, MAX_LEDGER } from "../lib/progression/store.js";
import { addDays } from "../lib/progression/dateKeys.js";
import { makeAdapter, mulberry32, randomDayMap } from "./helpers/memoryAdapter.mjs";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (n) => `${n.toFixed(2)}ms`;
function time(fn, runs = 15) { const t = []; for (let i = 0; i < runs; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); } return median(t); }

const TODAY = "2036-01-01";
const CFG = { weeklyTarget: 3, dailyEnabled: true, dailyEnabledSinceKey: "2026-01-01" };

await test("engines on 10 YEARS of data (3,650 days; the app only ever holds 365)", async () => {
  const map = randomDayMap(mulberry32(1), TODAY, 3650, 0.6, { addDays });
  const streakMs = time(() => computeStreaks(map, { todayKey: TODAY, target: 3 }));
  const awardMs = time(() => deriveAwards({ dayMap: map, todayKey: TODAY, trackingStartKey: "2026-01-01", config: CFG, trackedRepoCount: 3 }));
  console.log(`        computeStreaks: ${ms(streakMs)}   deriveAwards: ${ms(awardMs)}   (10y of data)`);
  assert.ok(streakMs < 150 && awardMs < 150);
});

await test("engines on the REAL window (365 days)", async () => {
  const map = randomDayMap(mulberry32(2), TODAY, 365, 0.6, { addDays });
  const streakMs = time(() => computeStreaks(map, { todayKey: TODAY, target: 3 }), 50);
  const awardMs = time(() => deriveAwards({ dayMap: map, todayKey: TODAY, trackingStartKey: "2025-01-01", config: CFG, trackedRepoCount: 3 }), 50);
  console.log(`        computeStreaks: ${ms(streakMs)}   deriveAwards: ${ms(awardMs)}   (365d, what runs on every Update)`);
  assert.ok(streakMs < 20 && awardMs < 20);
});

await test("5 simulated years, a sync EVERY day over a sliding 365-day window, daily streak enabled", async () => {
  const YEARS = 5, N = YEARS * 365;
  const START = "2026-01-05";
  const END = addDays(START, N - 1);
  const full = randomDayMap(mulberry32(3), END, N + 365, 0.7, { addDays });
  const a = makeAdapter();
  const s = createProgressionStore(a);
  await s.setConfig({ dailyEnabled: true }, { todayKey: START });
  const per = [];
  for (let i = 0; i < N; i++) {
    const t = addDays(START, i);
    const lo = addDays(t, -364);
    const window = {};
    for (let d = 0; d < 365; d++) { const k = addDays(lo, d); if (full[k]) window[k] = full[k]; }
    const t0 = performance.now();
    await s.sync({ userId: 1, dayMap: window, todayKey: t, trackedRepoCount: 2, now: new Date(`${t}T12:00:00Z`) });
    per.push(performance.now() - t0);
  }
  const state = a._store[PROGRESSION_KEY];
  const bytes = JSON.stringify(state).length;
  per.sort((x, y) => x - y);
  console.log(`        ${N} syncs  median ${ms(per[N >> 1])}  p99 ${ms(per[Math.floor(N * 0.99)])}  max ${ms(per[N - 1])}`);
  console.log(`        final ledger: ${state.ledger.length} entries, ${(bytes / 1024).toFixed(1)} KB  (chrome.storage.local quota: 10,240 KB)`);
  assert.equal(new Set(state.ledger.map((e) => e.key)).size, state.ledger.length);
  assert.ok(state.ledger.length < 2000, "ledger growth is ~weekly, never per-day-per-repo");
  assert.ok(bytes < 400 * 1024);
  assert.ok(per[Math.floor(N * 0.99)] < 100);
});

await test("worst case: a ledger AT the hard ceiling (MAX_LEDGER): no-change sync cost + size", async () => {
  const a = makeAdapter();
  const entries = Array.from({ length: MAX_LEDGER }, (_, i) => ({
    key: `weekly-target:W${i}`, ruleId: "weekly-target", ruleVersion: 1, category: "consistency", amount: 20,
    occurredOn: "2026-01-05", awardedAt: "2026-01-05T00:00:00.000Z", detail: { weekId: `W${i}`, target: 3 },
  }));
  a._store[PROGRESSION_KEY] = { schemaVersion: 1, rulesVersion: 1, userId: "1", trackingStartKey: "2026-01-05", createdAt: "x", preclaimed: ["first-tracked-repo"], ledger: entries, highWater: { weekly: {}, daily: 0 } };
  const s = createProgressionStore(a);
  const dayMap = randomDayMap(mulberry32(4), "2026-11-24", 365, 0.6, { addDays });
  const t0 = performance.now();
  const r = await s.sync({ userId: 1, dayMap, todayKey: "2026-11-24", trackedRepoCount: 1 });
  const dt = performance.now() - t0;
  const kb = JSON.stringify(a._store[PROGRESSION_KEY]).length / 1024;
  console.log(`        one sync against ${MAX_LEDGER} ledger entries: ${ms(dt)}   state size ${kb.toFixed(0)} KB`);
  assert.equal(r.status, "ok");
  assert.equal(a._store[PROGRESSION_KEY].ledger.length, MAX_LEDGER, "the ceiling holds: nothing is appended past MAX_LEDGER");
  assert.ok(dt < 1500);
});

await test("snapshot() stays cheap with a large ledger", async () => {
  const a = makeAdapter();
  const s = createProgressionStore(a);
  const map = randomDayMap(mulberry32(5), "2026-11-24", 365, 0.6, { addDays });
  await s.sync({ userId: 1, dayMap: {}, todayKey: "2026-01-05" });
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) await s.snapshot({ dayMap: map, todayKey: "2026-11-24" });
  const per = (performance.now() - t0) / 50;
  console.log(`        snapshot(): ${ms(per)} each`);
  assert.ok(per < 20);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
