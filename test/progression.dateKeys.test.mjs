// test/progression.dateKeys.test.mjs — lib/progression/dateKeys.js
import assert from "node:assert/strict";
import { keyToDayNumber, dayNumberToKey, addDays, diffDays, weekdayIndex, weekStartKey, isoWeekId, isValidDateKey, eachDay } from "../lib/progression/dateKeys.js";

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.message}`); } }

// Independent reference: the classic "nearest Thursday" algorithm on a real Date.
function refIsoWeek(key) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

test("round trip key <-> day number, and invalid keys are rejected (incl. impossible dates)", () => {
  for (const k of ["1970-01-01", "2024-02-29", "2026-11-24", "2100-12-31"]) assert.equal(dayNumberToKey(keyToDayNumber(k)), k);
  for (const bad of ["2026-02-30", "2026-13-01", "2025-02-29", "26-01-01", "", null, undefined, "2026-1-1", "2026-01-01T00:00:00Z"]) {
    assert.equal(isValidDateKey(bad), false, String(bad));
  }
});

test("addDays / diffDays cross month, year and leap-day boundaries", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2025-02-28", 1), "2025-03-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(diffDays("2026-01-01", "2027-01-01"), 365);
  assert.equal(diffDays("2024-01-01", "2025-01-01"), 366);
  assert.equal(diffDays("2026-05-10", "2026-05-03"), -7);
  assert.throws(() => addDays("nope", 1));
});

test("weekdayIndex: Monday = 0 .. Sunday = 6", () => {
  assert.equal(weekdayIndex("2026-11-23"), 0); // a Monday
  assert.equal(weekdayIndex("2026-11-24"), 1);
  assert.equal(weekdayIndex("2026-11-29"), 6); // Sunday
  assert.equal(weekdayIndex("1970-01-01"), 3); // Thursday
});

test("weekStartKey is the Monday on or before the day", () => {
  assert.equal(weekStartKey("2026-11-23"), "2026-11-23");
  assert.equal(weekStartKey("2026-11-29"), "2026-11-23");
  assert.equal(weekStartKey("2026-11-30"), "2026-11-30");
  assert.equal(weekStartKey("2027-01-01"), "2026-12-28");
});

test("isoWeekId known edge cases (year boundaries, W53 years)", () => {
  assert.equal(isoWeekId("2020-12-31"), "2020-W53");
  assert.equal(isoWeekId("2021-01-03"), "2020-W53");
  assert.equal(isoWeekId("2021-01-04"), "2021-W01");
  assert.equal(isoWeekId("2024-12-30"), "2025-W01"); // calendar 2024, ISO 2025
  assert.equal(isoWeekId("2026-01-01"), "2026-W01");
  assert.equal(isoWeekId("2026-11-24"), "2026-W48");
  assert.equal(isoWeekId("2016-01-03"), "2015-W53");
});

test("isoWeekId matches an independent implementation for EVERY day 1990..2060", () => {
  let n = 0;
  for (let k = "1990-01-01"; k <= "2060-12-31"; k = addDays(k, 1)) {
    assert.equal(isoWeekId(k), refIsoWeek(k), k);
    n++;
  }
  assert.ok(n > 25000);
});

test("all 7 days of a week share one id; the id changes exactly at Monday", () => {
  for (const start of ["2026-11-23", "2024-12-30", "2020-12-28"]) {
    const ids = new Set(eachDay(start, addDays(start, 6)).map(isoWeekId));
    assert.equal(ids.size, 1);
    assert.notEqual(isoWeekId(addDays(start, 7)), isoWeekId(start));
    assert.notEqual(isoWeekId(addDays(start, -1)), isoWeekId(start));
  }
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
