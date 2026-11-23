// test/progression.store.test.mjs — lib/progression/store.js
// The properties that matter: no retroactive XP, idempotency, determinism
// (day-by-day replay == one-shot), convergence under races, and never
// overwriting data it cannot read.
import assert from "node:assert/strict";
import { createProgressionStore, PROGRESSION_KEY, CONFIG_KEY, MAX_LEDGER, validateState } from "../lib/progression/store.js";
import { addDays } from "../lib/progression/dateKeys.js";
import { makeAdapter, mulberry32, randomDayMap } from "./helpers/memoryAdapter.mjs";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}

const D0 = "2026-01-05"; // a Monday
const days = (...keys) => Object.fromEntries(keys.map((k) => [k, { count: 2 }]));
const strip = (ledger) => ledger.map(({ awardedAt, ...rest }) => rest); // awardedAt is wall-clock
const at = (key) => new Date(`${key}T12:00:00Z`);
const run = (store, over) => store.sync({ userId: 42, dayMap: {}, todayKey: D0, trackedRepoCount: 0, ...over });

await test("first sync creates state with trackingStart = today; a year of past activity earns NOTHING", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  const past = {};
  for (let i = 1; i <= 300; i++) past[addDays(D0, -i)] = { count: 3 };
  const r = await run(s, { dayMap: past });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.newAwards, []);
  const st = await s.getState();
  assert.equal(st.trackingStartKey, D0);
  assert.equal(st.userId, "42");
  assert.deepEqual(st.ledger, []);
});

await test("today's activity on the first sync does count (live tracking starts today)", async () => {
  const s = createProgressionStore(makeAdapter());
  const r = await run(s, { dayMap: days(D0) });
  assert.deepEqual(r.newAwards.map((x) => x.ruleId), ["first-active-day"]);
});

await test("syncing the same data again (polling, re-fetch, repeated Update clicks) pays nothing more", async () => {
  const s = createProgressionStore(makeAdapter());
  const map = days(D0, addDays(D0, 1), addDays(D0, 2));
  const t = addDays(D0, 2);
  await run(s, { dayMap: {}, todayKey: D0 });
  const first = await run(s, { dayMap: map, todayKey: t });
  assert.ok(first.newAwards.length >= 2);
  const before = JSON.stringify((await s.getState()).ledger);
  for (let i = 0; i < 25; i++) assert.deepEqual((await run(s, { dayMap: map, todayKey: t })).newAwards, []);
  assert.equal(JSON.stringify((await s.getState()).ledger), before);
});

await test("a no-change sync performs NO write (storage isn't churned on every popup open)", async () => {
  const a = makeAdapter(); let writes = 0; const set = a.set; a.set = async (o) => { writes++; return set(o); };
  const s = createProgressionStore(a);
  await run(s, { dayMap: days(D0) });
  const w = writes;
  await run(s, { dayMap: days(D0) });
  await run(s, { dayMap: days(D0) });
  assert.equal(writes, w);
});

await test("DETERMINISM: syncing every day for 300 days == one sync at the end (same ledger)", async () => {
  const rand = mulberry32(99);
  const END = addDays(D0, 299);
  const full = randomDayMap(rand, END, 300, 0.55, { addDays }); // history incl. D0..END (+ a few days before)
  const trim = (map, today) => Object.fromEntries(Object.entries(map).filter(([k]) => k <= today));

  const dailyStore = createProgressionStore(makeAdapter());
  await dailyStore.setConfig({ dailyEnabled: true }, { todayKey: D0 });
  await dailyStore.sync({ userId: 1, dayMap: trim(full, D0), todayKey: D0, trackedRepoCount: 0, now: at(D0) });
  for (let i = 1; i < 300; i++) {
    const t = addDays(D0, i);
    await dailyStore.sync({ userId: 1, dayMap: trim(full, t), todayKey: t, trackedRepoCount: 0, now: at(t) });
  }

  const oneShot = createProgressionStore(makeAdapter());
  await oneShot.setConfig({ dailyEnabled: true }, { todayKey: D0 });
  await oneShot.sync({ userId: 1, dayMap: trim(full, D0), todayKey: D0, trackedRepoCount: 0, now: at(D0) });
  await oneShot.sync({ userId: 1, dayMap: trim(full, END), todayKey: END, trackedRepoCount: 0, now: at(END) });

  const a = strip((await dailyStore.getState()).ledger);
  const b = strip((await oneShot.getState()).ledger);
  assert.ok(a.length > 30, `expected a substantial ledger, got ${a.length}`);
  assert.deepEqual(b, a);
});

await test("a different account (user id) is refused, and nothing is written", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  await run(s, { dayMap: days(D0) });
  const before = JSON.stringify(a._store[PROGRESSION_KEY]);
  const r = await s.sync({ userId: 999, dayMap: days(D0, addDays(D0, 1), addDays(D0, 2)), todayKey: addDays(D0, 2), trackedRepoCount: 5 });
  assert.equal(r.status, "account-mismatch");
  assert.equal(JSON.stringify(a._store[PROGRESSION_KEY]), before);
});

await test("a missing user id does nothing (no-identity), and creates no state", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  for (const bad of [null, undefined, "", "  ", false, true, 0, -3, NaN, {}, [], 1.5]) {
    const r = await s.sync({ userId: bad, dayMap: days(D0), todayKey: D0 });
    assert.equal(r.status, "no-identity", String(bad));
  }
  assert.equal(a._store[PROGRESSION_KEY], undefined);
});

await test("a corrupted state is NEVER overwritten (it may be recoverable); sync reports it instead", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  const damaged = { schemaVersion: 1, userId: "42", trackingStartKey: "garbage", preclaimed: [], ledger: [], highWater: { weekly: {}, daily: 0 } };
  a._store[PROGRESSION_KEY] = damaged;
  const r = await run(s, { dayMap: days(D0) });
  assert.equal(r.status, "corrupt");
  assert.deepEqual(a._store[PROGRESSION_KEY], damaged);
  a._store[PROGRESSION_KEY] = "not even an object";
  assert.equal((await run(s)).status, "corrupt");
  a._store[PROGRESSION_KEY] = { ...damaged, schemaVersion: 2, trackingStartKey: D0 };
  assert.equal((await run(s)).status, "corrupt", "a state from a NEWER schema must not be clobbered by an older build");
});

await test("config defaults: weekly target 3, daily streak OFF; setConfig clamps and tracks the enable date", async () => {
  const s = createProgressionStore(makeAdapter());
  assert.deepEqual(await s.getConfig(), { weeklyTarget: 3, dailyEnabled: false, dailyEnabledSinceKey: null });
  assert.equal((await s.setConfig({ weeklyTarget: 99 }, { todayKey: D0 })).weeklyTarget, 7);
  assert.equal((await s.setConfig({ weeklyTarget: 0 }, { todayKey: D0 })).weeklyTarget, 1);
  const on = await s.setConfig({ dailyEnabled: true }, { todayKey: "2026-02-01" });
  assert.deepEqual([on.dailyEnabled, on.dailyEnabledSinceKey], [true, "2026-02-01"]);
  const again = await s.setConfig({ dailyEnabled: true }, { todayKey: "2026-03-01" });
  assert.equal(again.dailyEnabledSinceKey, "2026-02-01", "re-saving 'on' must not move the date");
  const off = await s.setConfig({ dailyEnabled: false }, { todayKey: "2026-03-02" });
  assert.deepEqual([off.dailyEnabled, off.dailyEnabledSinceKey], [false, null]);
  assert.equal((await s.setConfig({ dailyEnabled: "yes" }, { todayKey: D0 })).dailyEnabled, false, "only strict true enables");
});

await test("daily XP only flows while the daily streak is enabled and only for days since enabling", async () => {
  const s = createProgressionStore(makeAdapter());
  await run(s, { dayMap: {}, todayKey: D0 });
  const week = Array.from({ length: 8 }, (_, i) => addDays(D0, i));
  let r = await run(s, { dayMap: days(...week), todayKey: week[7] });
  assert.ok(!r.newAwards.some((x) => x.ruleId === "daily-streak-7"), "off by default");
  await s.setConfig({ dailyEnabled: true }, { todayKey: week[7] });
  r = await run(s, { dayMap: days(...week), todayKey: week[7] });
  assert.ok(!r.newAwards.some((x) => x.ruleId === "daily-streak-7"), "no fabricated continuity for days before enabling");
  const more = Array.from({ length: 7 }, (_, i) => addDays(week[7], 1 + i));
  r = await run(s, { dayMap: days(...week, ...more), todayKey: more[6] });
  assert.equal(r.newAwards.filter((x) => x.ruleId === "daily-streak-7").length, 1);
});

await test("repos already tracked at onboarding don't pay 'first tracked repo'; the first one after does", async () => {
  const s1 = createProgressionStore(makeAdapter());
  await run(s1, { trackedRepoCount: 4 });
  assert.deepEqual((await run(s1, { trackedRepoCount: 5 })).newAwards, []);
  const s2 = createProgressionStore(makeAdapter());
  await run(s2, { trackedRepoCount: 0 });
  const r = await run(s2, { trackedRepoCount: 1 });
  assert.deepEqual(r.newAwards.map((x) => x.ruleId), ["first-tracked-repo"]);
  assert.deepEqual((await run(s2, { trackedRepoCount: 1 })).newAwards, []);
  await run(s2, { trackedRepoCount: 0 }); await run(s2, { trackedRepoCount: 1 });
  assert.equal((await s2.getState()).ledger.filter((e) => e.ruleId === "first-tracked-repo").length, 1, "remove + re-add is not a farm");
});

await test("snapshot: balance, level and streaks come from the ledger/data; works before the first sync", async () => {
  const s = createProgressionStore(makeAdapter());
  const t = addDays(D0, 2);
  const pre = await s.snapshot({ dayMap: days(D0), todayKey: D0 });
  assert.equal(pre.initialized, false);
  assert.equal(pre.xp.balance, 0);
  assert.equal(pre.week.activeDays, 1, "streak display needs no initialisation");
  await run(s, { dayMap: {}, todayKey: D0 });
  await run(s, { dayMap: days(D0, addDays(D0, 1), t), todayKey: t });
  const snap = await s.snapshot({ dayMap: days(D0, addDays(D0, 1), t), todayKey: t });
  assert.equal(snap.xp.balance, 25, "first-active-day 5 + weekly-target 20");
  assert.equal(snap.xp.level, 1);
  assert.equal(snap.weekly.current, 1);
  assert.equal(snap.daily.enabled, false);
  assert.equal(snap.recent.length, 2);
  assert.ok(snap.recent.every((e) => e.reason.length > 10));
});

await test("personal bests survive: a streak that later leaves the data window or breaks is remembered", async () => {
  const s = createProgressionStore(makeAdapter());
  const wk = (mon) => [mon, addDays(mon, 1), addDays(mon, 2)];
  const map = { [addDays(D0, -7)]: { count: 0 }, ...days(...wk(D0), ...wk(addDays(D0, 7)), ...wk(addDays(D0, 14))) };
  const t = addDays(D0, 16);
  await run(s, { dayMap: {}, todayKey: D0 });
  await run(s, { dayMap: map, todayKey: t });
  assert.equal((await s.snapshot({ dayMap: map, todayKey: t })).weekly.longest, 3);
  // Much later the 3-week run is out of the (empty) window; best is still 3.
  const later = addDays(D0, 400);
  await run(s, { dayMap: { [addDays(later, -3)]: { count: 1 } }, todayKey: later });
  const snap = await s.snapshot({ dayMap: { [addDays(later, -3)]: { count: 1 } }, todayKey: later });
  assert.equal(snap.weekly.longest, 3);
  assert.equal(snap.weekly.current, 0);
});

await test("high-water is tracked per weekly target (a best at target=1 is not shown as a best at target=3)", async () => {
  const s = createProgressionStore(makeAdapter());
  const mons = [0, 7, 14, 21].map((n) => addDays(D0, n));
  const map = { [addDays(D0, -7)]: { count: 0 }, ...days(...mons) }; // 1 day per week for 4 weeks
  const t = addDays(D0, 24);
  await s.setConfig({ weeklyTarget: 1 }, { todayKey: D0 });
  await run(s, { dayMap: {}, todayKey: D0 });
  await run(s, { dayMap: map, todayKey: t });
  assert.equal((await s.snapshot({ dayMap: map, todayKey: t })).weekly.longest, 4);
  await s.setConfig({ weeklyTarget: 3 }, { todayKey: t });
  assert.equal((await s.snapshot({ dayMap: map, todayKey: t })).weekly.longest, 0);
});

await test("export/import round trip restores the exact ledger + config", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  await s.setConfig({ weeklyTarget: 4, dailyEnabled: true }, { todayKey: D0 });
  await run(s, { dayMap: {}, todayKey: D0 });
  await run(s, { dayMap: days(D0, addDays(D0, 1), addDays(D0, 2), addDays(D0, 3)), todayKey: addDays(D0, 3), trackedRepoCount: 0 });
  const backup = JSON.parse(JSON.stringify(await s.exportData()));
  const b = makeAdapter(); const s2 = createProgressionStore(b);
  await s2.importData(backup);
  assert.deepEqual(await s2.getState(), await s.getState());
  assert.deepEqual(await s2.getConfig(), await s.getConfig());
});

await test("import rejects malformed backups and leaves current data untouched", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  await run(s, { dayMap: days(D0) });
  const before = JSON.stringify(a._store);
  const good = await s.exportData();
  const dupe = structuredClone(good); dupe.state.ledger.push({ ...dupe.state.ledger[0] });
  const badAmount = structuredClone(good); badAmount.state.ledger[0].amount = "lots";
  const wrongFormat = { ...structuredClone(good), format: "something-else" };
  const newerSchema = { ...structuredClone(good), schemaVersion: 99 };
  for (const bad of [dupe, badAmount, wrongFormat, newerSchema, null, "x", {}]) await assert.rejects(() => s.importData(bad));
  assert.equal(JSON.stringify(a._store), before);
});

await test("reset clears XP/ledger but keeps the user's preferences; sync can then start fresh", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  await s.setConfig({ weeklyTarget: 5 }, { todayKey: D0 });
  await run(s, { dayMap: days(D0) });
  await s.reset();
  assert.equal(await s.getState(), null);
  assert.equal((await s.getConfig()).weeklyTarget, 5);
  const r = await s.sync({ userId: 7, dayMap: days(D0), todayKey: D0 });
  assert.equal(r.status, "ok");
  assert.equal((await s.getState()).userId, "7");
});

await test("the ledger stores rule ids, amounts and dates only — no repo names, URLs or raw activity", async () => {
  const a = makeAdapter(); const s = createProgressionStore(a);
  await run(s, { dayMap: days(D0), trackedRepoCount: 0 });
  await run(s, { dayMap: days(D0), trackedRepoCount: 2 });
  const stored = JSON.stringify(a._store[PROGRESSION_KEY]);
  assert.ok(!/https?:|github\.com|dayMap/i.test(stored));
  for (const e of a._store[PROGRESSION_KEY].ledger) {
    assert.deepEqual(Object.keys(e).sort(), ["amount", "awardedAt", "category", "detail", "key", "occurredOn", "ruleId", "ruleVersion"]);
  }
  assert.deepEqual(Object.keys(a._store).sort(), [PROGRESSION_KEY].sort());
});

await test("validateState enforces the ledger ceiling", () => {
  const base = { schemaVersion: 1, userId: "1", trackingStartKey: D0, preclaimed: [], highWater: { weekly: {}, daily: 0 } };
  const entry = (i) => ({ key: `k${i}`, ruleId: "r", amount: 1, occurredOn: D0 });
  assert.equal(validateState({ ...base, ledger: Array.from({ length: MAX_LEDGER }, (_, i) => entry(i)) }), null);
  assert.match(validateState({ ...base, ledger: Array.from({ length: MAX_LEDGER + 1 }, (_, i) => entry(i)) }), /too large/);
});

// ---- concurrency ----
await test("20 overlapping syncs through one adapter: no duplicate keys, same result as a single sync", async () => {
  const map = days(D0, addDays(D0, 1), addDays(D0, 2));
  const t = addDays(D0, 2);
  const solo = createProgressionStore(makeAdapter());
  await run(solo, { dayMap: {}, todayKey: D0 }); await run(solo, { dayMap: map, todayKey: t });
  const s = createProgressionStore(makeAdapter({ jitterMs: 4 }));
  await run(s, { dayMap: {}, todayKey: D0 });
  await Promise.all(Array.from({ length: 20 }, () => run(s, { dayMap: map, todayKey: t })));
  const ledger = (await s.getState()).ledger;
  assert.equal(new Set(ledger.map((e) => e.key)).size, ledger.length);
  assert.deepEqual(strip(ledger), strip((await solo.getState()).ledger));
});

await test("CROSS-PROCESS race (two separate queues on the same storage, e.g. popup + worker) converges with no double pay", async () => {
  const shared = {};
  const map = days(D0, addDays(D0, 1), addDays(D0, 2), addDays(D0, 7), addDays(D0, 8), addDays(D0, 9));
  const t = addDays(D0, 9);
  await run(createProgressionStore(makeAdapter({ shared })), { dayMap: {}, todayKey: D0 });
  for (let round = 0; round < 15; round++) {
    const popup = createProgressionStore(makeAdapter({ shared, jitterMs: 6 }));   // different adapter => different queue
    const worker = createProgressionStore(makeAdapter({ shared, jitterMs: 6 }));
    await Promise.all([run(popup, { dayMap: map, todayKey: t }), run(worker, { dayMap: map, todayKey: t }), run(popup, { dayMap: map, todayKey: t })]);
  }
  // One final sync from any process repairs anything a race dropped.
  await run(createProgressionStore(makeAdapter({ shared })), { dayMap: map, todayKey: t });
  const ledger = shared[PROGRESSION_KEY].ledger;
  assert.equal(new Set(ledger.map((e) => e.key)).size, ledger.length, "no duplicate keys");
  const keys = ledger.map((e) => e.key).sort();
  assert.deepEqual(keys, ["first-active-day", "weekly-target:2026-W02", "weekly-target:2026-W03"].sort());
});

await test("a config change racing a sync can't be lost (separate keys)", async () => {
  const shared = {};
  const a = createProgressionStore(makeAdapter({ shared, jitterMs: 5 }));
  const b = createProgressionStore(makeAdapter({ shared, jitterMs: 5 }));
  await Promise.all([run(a, { dayMap: days(D0) }), b.setConfig({ weeklyTarget: 6 }, { todayKey: D0 }), run(a, { dayMap: days(D0) })]);
  assert.equal(shared[CONFIG_KEY].weeklyTarget, 6);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
