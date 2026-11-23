// test/progression.streaks.test.mjs — lib/progression/streaks.js
import assert from "node:assert/strict";
import { computeStreaks, weeklyTargetHits, dailyRuns, activeDayKeys, clampWeeklyTarget } from "../lib/progression/streaks.js";
import { addDays } from "../lib/progression/dateKeys.js";
import { calculateCurrentStreak } from "../lib/pulse.js";
import { mulberry32, randomDayMap } from "./helpers/memoryAdapter.mjs";

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); } }

const days = (...keys) => Object.fromEntries(keys.map((k) => [k, { count: 1 }]));
// 2026-11-23 is a Monday.
const MON = "2026-11-23", TUE = "2026-11-24", WED = "2026-11-25", THU = "2026-11-26", FRI = "2026-11-27", SUN = "2026-11-29";

test("design doc example: Mon/Wed/Fri active -> 3 of 3 reached on Friday, Sat/Sun add nothing", () => {
  const map = { ...days(MON, WED, FRI), "2026-11-28": { count: 0 }, [SUN]: { count: 0 } };
  const s = computeStreaks(map, { todayKey: SUN, target: 3 });
  assert.equal(s.week.activeDays, 3);
  assert.equal(s.week.met, true);
  assert.deepEqual(s.week.days, [true, false, true, false, true, false, false]);
  assert.equal(weeklyTargetHits(map, { target: 3, todayKey: SUN })[0].reachedOn, FRI);
});

test("ten commits on one day are one active day", () => {
  const s = computeStreaks({ [MON]: { count: 10 } }, { todayKey: MON, target: 3 });
  assert.equal(s.week.activeDays, 1);
});

test("an in-progress week that has not hit the target is NOT a break", () => {
  // Two full met weeks (Mon-Wed each), then this week has only 1 day so far.
  const prev1 = ["2026-11-09", "2026-11-10", "2026-11-11"];
  const prev2 = ["2026-11-16", "2026-11-17", "2026-11-18"];
  const map = { ...days(...prev1, ...prev2, MON), "2026-11-02": { count: 0 } };
  const s = computeStreaks(map, { todayKey: TUE, target: 3 });
  assert.equal(s.weekly.current, 2, "still alive, week not over");
  assert.equal(s.week.met, false);
});

test("once the in-progress week meets the target it extends the streak", () => {
  const prev = ["2026-11-16", "2026-11-17", "2026-11-18"];
  const s = computeStreaks({ "2026-11-02": { count: 0 }, ...days(...prev, MON, TUE, WED) }, { todayKey: WED, target: 3 });
  assert.equal(s.weekly.current, 2);
});

test("a finalized week below target resets the current streak but the longest is preserved", () => {
  const wk = (mon) => [mon, addDays(mon, 1), addDays(mon, 2)];
  // weeks: 10-26 met, 11-02 met, 11-09 MISSED (1 day), 11-16 met; today = Wed of current week with 0 days
  const map = { "2026-10-20": { count: 0 }, ...days(...wk("2026-10-26"), ...wk("2026-11-02"), "2026-11-09", ...wk("2026-11-16")) };
  const s = computeStreaks(map, { todayKey: WED, target: 3 });
  assert.equal(s.weekly.current, 1);
  assert.equal(s.weekly.longest, 2);
});

test("a window that starts mid-week excludes that partial week instead of calling it a miss", () => {
  // Window begins Wed 11-11 (partial week of 11-09). Full weeks after it all met.
  const wk = (mon) => [mon, addDays(mon, 1), addDays(mon, 2)];
  const map = { "2026-11-11": { count: 0 }, ...days(...wk("2026-11-16")), ...days(MON, TUE, WED) };
  const s = computeStreaks(map, { todayKey: WED, target: 3 });
  assert.equal(s.weekly.current, 2);
  assert.equal(s.weekly.weeksEvaluated, 2, "11-09 partial week not evaluated");
  assert.equal(s.weekly.truncated, true, "streak touches the window edge, so it may really be longer");
});

test("daily streak: today pending is not a break; a missed day is", () => {
  const map = days("2026-11-20", "2026-11-21", "2026-11-22"); // Fri Sat Sun, today Mon empty
  let s = computeStreaks(map, { todayKey: MON });
  assert.deepEqual([s.daily.current, s.daily.todayPending], [3, true]);
  s = computeStreaks(map, { todayKey: TUE }); // Monday closed empty -> broken
  assert.equal(s.daily.current, 0);
  assert.equal(s.daily.longest, 3);
});

test("today counts when active and the streak keeps walking back", () => {
  const s = computeStreaks(days("2026-11-22", MON), { todayKey: MON });
  assert.deepEqual([s.daily.current, s.daily.todayPending], [2, false]);
});

test("daily current agrees with lib/pulse.js calculateCurrentStreak (the streak users already see)", () => {
  const rand = mulberry32(7);
  for (let i = 0; i < 300; i++) {
    const today = addDays("2026-03-01", Math.floor(rand() * 400));
    const map = randomDayMap(rand, today, 120, 0.3 + rand() * 0.6, { addDays });
    const old = calculateCurrentStreak(map, new Date(`${today}T12:00:00Z`));
    const mine = computeStreaks(map, { todayKey: today }).daily;
    assert.equal(mine.current, old.streak, `${today} case ${i}`);
    assert.equal(mine.todayPending, old.todayPending);
  }
});

// ---- brute-force reference (different structure, real Date math) ----
function refWeekly(dayMap, todayKey, t) {
  const keys = Object.keys(dayMap).sort();
  if (!keys.length) return { current: 0, longest: 0 };
  const monday = (k) => { const d = new Date(`${k}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const plus7 = (k) => { const d = new Date(`${k}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); };
  const per = {};
  for (const k of keys) if (k <= todayKey && dayMap[k].count > 0) per[monday(k)] = (per[monday(k)] || 0) + 1;
  let first = monday(keys[0]);
  if (first < keys[0]) first = plus7(first);
  const cur = monday(todayKey);
  if (first > cur) first = cur;
  let run = 0, longest = 0;
  for (let w = first; w <= cur; w = plus7(w)) {
    const met = (per[w] || 0) >= t;
    if (met) { run++; longest = Math.max(longest, run); }
    else if (w < cur) run = 0; // the current, unfinished week never breaks a run
  }
  return { current: run, longest };
}

test("weekly current/longest match a brute-force reference over 1,500 random histories (targets 1..7)", () => {
  const rand = mulberry32(2026);
  for (let i = 0; i < 1500; i++) {
    const today = addDays("2025-01-01", Math.floor(rand() * 900));
    const span = 1 + Math.floor(rand() * 380);
    const map = randomDayMap(rand, today, span, rand(), { addDays });
    const t = 1 + Math.floor(rand() * 7);
    const got = computeStreaks(map, { todayKey: today, target: t }).weekly;
    const want = refWeekly(map, today, t);
    assert.equal(got.current, want.current, `case ${i} current (today ${today}, span ${span}, t ${t})`);
    assert.equal(got.longest, want.longest, `case ${i} longest`);
    assert.ok(got.longest >= got.current);
  }
});

test("dailyRuns finds maximal consecutive runs", () => {
  const runs = dailyRuns(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-05", "2026-01-09", "2026-01-10"]);
  assert.deepEqual(runs, [
    { startKey: "2026-01-01", endKey: "2026-01-03", length: 3 },
    { startKey: "2026-01-05", endKey: "2026-01-05", length: 1 },
    { startKey: "2026-01-09", endKey: "2026-01-10", length: 2 },
  ]);
  assert.deepEqual(dailyRuns([]), []);
});

test("weeklyTargetHits only counts days on/after fromKey (pre-onboarding days can't complete a week)", () => {
  const map = days(MON, TUE, WED);
  assert.equal(weeklyTargetHits(map, { target: 3, todayKey: WED }).length, 1);
  assert.equal(weeklyTargetHits(map, { target: 3, todayKey: WED, fromKey: TUE }).length, 0, "only 2 eligible days");
  assert.equal(weeklyTargetHits(map, { target: 2, todayKey: WED, fromKey: TUE })[0].reachedOn, WED);
});

test("garbage in the map is ignored: bad keys, zero/negative/NaN counts, future days", () => {
  const map = { ...days(MON), "not-a-date": { count: 5 }, [TUE]: { count: 0 }, [WED]: { count: -2 }, [THU]: { count: NaN }, "2027-01-01": { count: 9 }, [FRI]: null };
  assert.deepEqual(activeDayKeys(map, { todayKey: SUN }), [MON]);
  const s = computeStreaks(map, { todayKey: MON });
  assert.equal(s.week.activeDays, 1);
});

test("empty / missing map yields zeros, not a crash", () => {
  for (const m of [{}, null, undefined]) {
    const s = computeStreaks(m, { todayKey: TUE });
    assert.deepEqual([s.weekly.current, s.weekly.longest, s.daily.current, s.coverage], [0, 0, 0, null]);
  }
});

test("target is clamped to 1..7 and defaults sanely; bad todayKey throws", () => {
  assert.equal(clampWeeklyTarget(0), 1);
  assert.equal(clampWeeklyTarget(99), 7);
  assert.equal(clampWeeklyTarget("x"), 3);
  assert.equal(clampWeeklyTarget(2.5), 3);
  assert.equal(computeStreaks(days(MON), { todayKey: MON, target: 99 }).week.target, 7);
  assert.throws(() => computeStreaks({}, { todayKey: "2026-02-31" }));
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
