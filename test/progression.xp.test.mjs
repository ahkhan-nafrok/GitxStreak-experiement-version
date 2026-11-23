// test/progression.xp.test.mjs — lib/progression/xp.js
import assert from "node:assert/strict";
import { levelFromXp, deriveAwards, explainAward, balanceOf, RULES, RULES_VERSION, DEFAULT_CURVE } from "../lib/progression/xp.js";
import { addDays } from "../lib/progression/dateKeys.js";

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); } }

const days = (...keys) => Object.fromEntries(keys.map((k) => [k, { count: 1 }]));
const MON = "2026-11-23", TUE = "2026-11-24", WED = "2026-11-25", SUN = "2026-11-29";
const CFG = { weeklyTarget: 3, dailyEnabled: false, dailyEnabledSinceKey: null };
const base = (over) => ({ dayMap: {}, todayKey: SUN, trackingStartKey: "2026-01-01", config: CFG, trackedRepoCount: 0, ...over });

test("level curve: 100 for L1, 125 for L2, 150 for L3 ... boundaries are exact", () => {
  assert.deepEqual(levelFromXp(0), { level: 1, xpIntoLevel: 0, xpForNext: 100, pct: 0, totalAtLevelStart: 0 });
  assert.equal(levelFromXp(99).level, 1);
  assert.equal(levelFromXp(100).level, 2);
  assert.equal(levelFromXp(100).xpForNext, 125);
  assert.equal(levelFromXp(224).level, 2);
  assert.equal(levelFromXp(225).level, 3);
  assert.equal(levelFromXp(225 + 150).level, 4);
});

test("level math is closed-form consistent: cumulative XP to reach level L = 100(L-1) + 12.5(L-1)(L-2)", () => {
  for (let L = 1; L <= 60; L++) {
    const need = 100 * (L - 1) + 12.5 * (L - 1) * (L - 2);
    assert.equal(levelFromXp(need).level, L, `at exactly ${need}`);
    if (need > 0) assert.equal(levelFromXp(need - 1).level, L - 1);
  }
});

test("levelFromXp is robust to junk and honours a custom curve", () => {
  for (const bad of [-50, NaN, undefined, null, Infinity, "5"]) assert.equal(levelFromXp(bad).level, 1, String(bad));
  assert.equal(levelFromXp(50, { base: 50, step: 0 }).level, 2);
  assert.ok(levelFromXp(1e9).level > 100);
});

test("no retroactive XP: days before trackingStartKey earn nothing", () => {
  const map = days(MON, TUE, WED);
  assert.deepEqual(deriveAwards(base({ dayMap: map, trackingStartKey: "2026-11-30", todayKey: "2026-12-01" })), []);
});

test("first-active-day pays once, dated to the first live active day", () => {
  const a = deriveAwards(base({ dayMap: days(TUE, WED), trackingStartKey: MON }));
  const first = a.filter((x) => x.ruleId === "first-active-day");
  assert.equal(first.length, 1);
  assert.equal(first[0].occurredOn, TUE);
  assert.equal(first[0].amount, RULES["first-active-day"].amount);
});

test("weekly-target: one award per ISO week, keyed by week id, dated to the day it was reached", () => {
  const map = days(MON, TUE, WED, "2026-11-26", "2026-11-27", "2026-11-16", "2026-11-17"); // week A: 5 days, week B: 2 days
  const w = deriveAwards(base({ dayMap: map, trackingStartKey: "2026-11-01" })).filter((x) => x.ruleId === "weekly-target");
  assert.equal(w.length, 1, "extra days in the same week add nothing");
  assert.equal(w[0].key, "weekly-target:2026-W48");
  assert.equal(w[0].occurredOn, WED);
  assert.deepEqual(w[0].detail, { weekId: "2026-W48", target: 3 }, "detail holds only what was earned, never when it was noticed");
});

test("a week is only counted from tracking start: a partial first week needs its own 3 live days", () => {
  const map = days(MON, TUE, WED);
  assert.equal(deriveAwards(base({ dayMap: map, trackingStartKey: TUE })).filter((x) => x.ruleId === "weekly-target").length, 0);
});

test("daily-streak-7 does NOT exist while daily streak is off (the default)", () => {
  const map = days(...Array.from({ length: 10 }, (_, i) => addDays("2026-11-10", i)));
  assert.equal(deriveAwards(base({ dayMap: map, trackingStartKey: "2026-11-01" })).filter((x) => x.ruleId === "daily-streak-7").length, 0);
});

test("daily-streak-7 pays once per run when enabled, ignoring days before it was enabled", () => {
  const run = Array.from({ length: 10 }, (_, i) => addDays("2026-11-10", i)); // 11-10..11-19
  const map = days(...run);
  const on = { ...CFG, dailyEnabled: true, dailyEnabledSinceKey: "2026-11-01" };
  const a = deriveAwards(base({ dayMap: map, trackingStartKey: "2026-11-01", config: on })).filter((x) => x.ruleId === "daily-streak-7");
  assert.equal(a.length, 1, "a 10-day run pays once, not once per day");
  assert.equal(a[0].occurredOn, "2026-11-16");
  // Enabled mid-run: only days since enabling count, so the run is 5 long -> nothing.
  const late = { ...on, dailyEnabledSinceKey: "2026-11-15" };
  assert.equal(deriveAwards(base({ dayMap: map, trackingStartKey: "2026-11-01", config: late })).filter((x) => x.ruleId === "daily-streak-7").length, 0);
});

test("a later GitHub backfill that moves a run's start does not pay the same run twice", () => {
  const on = { ...CFG, dailyEnabled: true, dailyEnabledSinceKey: "2026-11-01" };
  const run = Array.from({ length: 8 }, (_, i) => addDays("2026-11-10", i));
  const first = deriveAwards(base({ dayMap: days(...run), trackingStartKey: "2026-11-01", config: on })).filter((x) => x.ruleId === "daily-streak-7");
  const ledger = first.map((c) => ({ ...c, awardedAt: "x" }));
  const backfilled = days(...run, "2026-11-09", "2026-11-08"); // run now starts earlier
  const again = deriveAwards(base({ dayMap: backfilled, trackingStartKey: "2026-11-01", config: on, existing: ledger })).filter((x) => x.ruleId === "daily-streak-7");
  assert.equal(again.length, 0);
  // ...but a genuinely separate later run is paid.
  const second = Array.from({ length: 7 }, (_, i) => addDays("2026-11-20", i));
  const more = deriveAwards(base({ dayMap: days(...run, ...second), trackingStartKey: "2026-11-01", config: on, existing: ledger, todayKey: "2026-12-05" })).filter((x) => x.ruleId === "daily-streak-7");
  assert.equal(more.length, 1);
  assert.equal(more[0].detail.startKey, "2026-11-20");
});

test("first-tracked-repo pays when repos exist, unless it was already satisfied at onboarding", () => {
  assert.equal(deriveAwards(base({ trackedRepoCount: 1 })).filter((x) => x.ruleId === "first-tracked-repo").length, 1);
  assert.equal(deriveAwards(base({ trackedRepoCount: 0 })).length, 0);
  assert.equal(deriveAwards(base({ trackedRepoCount: 3, preclaimed: ["first-tracked-repo"] })).length, 0);
});

test("derivation is deterministic: same input twice, and independent of dayMap key order", () => {
  const keys = [MON, TUE, WED, "2026-11-16", "2026-11-17", "2026-11-18"];
  const a = deriveAwards(base({ dayMap: days(...keys), trackingStartKey: "2026-11-01", trackedRepoCount: 2 }));
  const b = deriveAwards(base({ dayMap: days(...[...keys].reverse()), trackingStartKey: "2026-11-01", trackedRepoCount: 2 }));
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((x) => x.occurredOn), [...a.map((x) => x.occurredOn)].sort());
});

test("every candidate has a unique key, the current rules version, and an amount from the rule table", () => {
  const map = days(...Array.from({ length: 40 }, (_, i) => addDays("2026-10-01", i)));
  const on = { ...CFG, dailyEnabled: true, dailyEnabledSinceKey: "2026-10-01" };
  const a = deriveAwards(base({ dayMap: map, trackingStartKey: "2026-10-01", config: on, trackedRepoCount: 1, todayKey: "2026-11-15" }));
  assert.equal(new Set(a.map((x) => x.key)).size, a.length);
  for (const x of a) { assert.equal(x.ruleVersion, RULES_VERSION); assert.equal(x.amount, RULES[x.ruleId].amount); }
});

test("explainAward gives a readable reason for every rule and survives an unknown (future) rule", () => {
  for (const id of Object.keys(RULES)) {
    const text = explainAward({ ruleId: id, ruleVersion: 1, occurredOn: MON, detail: { weekId: "2026-W48", target: 3, startKey: MON } });
    assert.ok(text.length > 10, id);
  }
  assert.match(explainAward({ ruleId: "from-the-future", ruleVersion: 9 }), /from-the-future/);
  assert.ok(explainAward(null).length > 0);
});

test("balanceOf sums amounts and ignores junk entries", () => {
  assert.equal(balanceOf([{ amount: 5 }, { amount: 20 }, { amount: NaN }, null, {}]), 25);
  assert.equal(balanceOf(undefined), 0);
  assert.equal(DEFAULT_CURVE.base, 100);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
