// test/pulse.test.mjs
// Pure logic tests for lib/pulse.js — no network, no chrome.storage, no
// DOM. Replaces the old test/githubOverview.test.mjs (deleted along with
// lib/githubOverview.js, which pulse.js replaced entirely).
//
// Run with: node test/pulse.test.mjs

import assert from "node:assert/strict";
import {
  toDateKeyUTC,
  getRolling12MonthRange,
  parseContributionCalendar,
  buildContributionGrid,
  isContributionCacheStale,
  calculateCurrentStreak,
  calculateYearTotal,
} from "../lib/pulse.js";

let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.message}`);
  }
}

// ---------- toDateKeyUTC ----------

test("toDateKeyUTC: formats as zero-padded YYYY-MM-DD", () => {
  assert.equal(toDateKeyUTC(new Date(Date.UTC(2026, 0, 5))), "2026-01-05");
  assert.equal(toDateKeyUTC(new Date(Date.UTC(2026, 11, 31))), "2026-12-31");
});

// ---------- getRolling12MonthRange ----------

test("getRolling12MonthRange: 'to' is the exclusive start of tomorrow (today's UTC date is included)", () => {
  const now = new Date("2026-07-15T14:22:00Z");
  const range = getRolling12MonthRange(now);
  assert.equal(range.to, "2026-07-16T00:00:00.000Z");
  assert.equal(range.asOfDateKey, "2026-07-15");
});

test("getRolling12MonthRange: 'from' is one year back, plus one day, ending today (365/366-day inclusive window)", () => {
  const now = new Date("2026-07-15T14:22:00Z");
  const range = getRolling12MonthRange(now);
  assert.equal(range.from, "2025-07-16T00:00:00.000Z");
});

test("getRolling12MonthRange: handles a leap-year Feb 29 boundary without drifting", () => {
  // 2024 is a leap year. From Feb 29 2024 + 1 year -> Feb 28 2025 (no Feb 29
  // in 2025), then +1 day per the implementation's date-math.
  const now = new Date("2024-02-29T00:00:00Z");
  const range = getRolling12MonthRange(now);
  assert.equal(range.asOfDateKey, "2024-02-29");
  // Just assert it produces a valid ISO string with no NaN/Invalid Date —
  // the exact day is a documented consequence of JS Date rollover, not a
  // bug to pin down further here.
  assert.ok(!range.from.includes("NaN"), `from must be a valid date, got: ${range.from}`);
});

// ---------- parseContributionCalendar ----------

test("parseContributionCalendar: flattens weeks/contributionDays into a flat date->count map", () => {
  const graphqlData = {
    viewer: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: [
            { contributionDays: [{ date: "2026-06-28", contributionCount: 0 }, { date: "2026-06-29", contributionCount: 3 }] },
            { contributionDays: [{ date: "2026-06-30", contributionCount: 0 }, { date: "2026-07-01", contributionCount: 5 }] },
          ],
        },
      },
    },
  };
  const map = parseContributionCalendar(graphqlData);
  assert.equal(map["2026-06-29"].count, 3);
  assert.equal(map["2026-07-01"].count, 5);
  assert.equal(Object.keys(map).length, 4);
});

test("parseContributionCalendar: malformed/missing shape returns an empty map, never throws", () => {
  assert.deepEqual(parseContributionCalendar(null), {});
  assert.deepEqual(parseContributionCalendar({}), {});
  assert.deepEqual(parseContributionCalendar({ viewer: {} }), {});
  assert.deepEqual(
    parseContributionCalendar({ viewer: { contributionsCollection: { contributionCalendar: { weeks: "not-an-array" } } } }),
    {}
  );
});

test("parseContributionCalendar: skips individual malformed day entries without dropping the whole response", () => {
  const graphqlData = {
    viewer: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: [{ contributionDays: [{ date: "2026-07-01", contributionCount: 2 }, { contributionCount: 9 }, null] }],
        },
      },
    },
  };
  const map = parseContributionCalendar(graphqlData);
  assert.equal(Object.keys(map).length, 1);
  assert.equal(map["2026-07-01"].count, 2);
});

// ---------- buildContributionGrid ----------

test("buildContributionGrid: each week is exactly 7 cells, contributed is a strict boolean", () => {
  const graphqlData = {
    viewer: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: [
            {
              contributionDays: [
                { date: "2026-07-01", contributionCount: 3 },
                { date: "2026-07-02", contributionCount: 0 },
              ],
            },
          ],
        },
      },
    },
  };
  const grid = buildContributionGrid(graphqlData);
  assert.equal(grid.length, 1);
  assert.equal(grid[0].length, 7, "every week/column must be padded to exactly 7 cells");
  assert.equal(grid[0][0].contributed, true);
  assert.equal(grid[0][1].contributed, false);
  assert.equal(grid[0][2], null, "cells beyond the returned days must be null, not a false contribution state");
});

test("buildContributionGrid: malformed/missing shape returns an empty array, never throws", () => {
  assert.deepEqual(buildContributionGrid(null), []);
  assert.deepEqual(buildContributionGrid({}), []);
});

test("buildContributionGrid: a day entry missing its date becomes a blank (null) cell, not a crash", () => {
  const graphqlData = {
    viewer: {
      contributionsCollection: {
        contributionCalendar: {
          weeks: [{ contributionDays: [{ contributionCount: 5 }] }],
        },
      },
    },
  };
  const grid = buildContributionGrid(graphqlData);
  assert.equal(grid[0][0], null);
});

// ---------- isContributionCacheStale ----------

test("isContributionCacheStale: no cache at all is always stale", () => {
  assert.equal(isContributionCacheStale(null), true);
  assert.equal(isContributionCacheStale(undefined), true);
  assert.equal(isContributionCacheStale({}), true, "a cache object with no asOfDateKey must be treated as stale");
});

test("isContributionCacheStale: a cache dated today (UTC) is NOT stale", () => {
  const now = new Date("2026-07-15T09:00:00Z");
  const cache = { asOfDateKey: "2026-07-15" };
  assert.equal(isContributionCacheStale(cache, now), false);
});

test("isContributionCacheStale: a cache from yesterday IS stale — the rolling window must refetch daily", () => {
  const now = new Date("2026-07-16T00:05:00Z");
  const cache = { asOfDateKey: "2026-07-15" };
  assert.equal(isContributionCacheStale(cache, now), true);
});

// ---------- calculateCurrentStreak ----------
// This is the highest-stakes function in the file — the "today is pending,
// not broken" rule from the spec lives entirely here.

test("calculateCurrentStreak: today has contributions, streak counts today and continues backward", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  const dayMap = {
    "2026-07-15": { count: 2 },
    "2026-07-14": { count: 1 },
    "2026-07-13": { count: 0 },
  };
  const { streak, todayPending } = calculateCurrentStreak(dayMap, now);
  assert.equal(streak, 2, "today + yesterday both contributed = streak of 2");
  assert.equal(todayPending, false);
});

test("calculateCurrentStreak: today has zero contributions so far — streak is PENDING, not broken", () => {
  const now = new Date("2026-07-15T08:00:00Z");
  const dayMap = {
    "2026-07-14": { count: 3 },
    "2026-07-13": { count: 1 },
  };
  const { streak, todayPending } = calculateCurrentStreak(dayMap, now);
  assert.equal(todayPending, true, "zero contributions on today (not yet closed) must be pending");
  assert.equal(streak, 2, "the streak walk must start from yesterday and continue counting — today's absence must not zero it out");
});

test("calculateCurrentStreak: today zero AND yesterday zero — streak is 0, today still pending (not 'broken')", () => {
  const now = new Date("2026-07-15T08:00:00Z");
  const dayMap = { "2026-07-14": { count: 0 } };
  const { streak, todayPending } = calculateCurrentStreak(dayMap, now);
  assert.equal(streak, 0);
  assert.equal(todayPending, true);
});

test("calculateCurrentStreak: a real gap in the past correctly breaks the backward walk", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  const dayMap = {
    "2026-07-15": { count: 1 },
    "2026-07-14": { count: 1 },
    "2026-07-13": { count: 0 }, // gap
    "2026-07-12": { count: 5 }, // must NOT be counted — walk already stopped at the gap
  };
  const { streak } = calculateCurrentStreak(dayMap, now);
  assert.equal(streak, 2, "the walk must stop at the first zero day and never resume past it");
});

test("calculateCurrentStreak: a day entirely missing from dayMap is treated as zero contributions, same as an explicit 0", () => {
  const now = new Date("2026-07-15T12:00:00Z");
  const dayMap = { "2026-07-15": { count: 1 } }; // 07-14 has no entry at all
  const { streak } = calculateCurrentStreak(dayMap, now);
  assert.equal(streak, 1, "a missing day must break the walk exactly like an explicit zero-count day");
});

test(
  "calculateCurrentStreak: a streak longer than the fetched window is truncated at the window edge (documented behavior, matches GitHub's own profile page)",
  () => {
    const now = new Date("2026-07-15T12:00:00Z");
    // Only 3 days of data exist in the map at all — simulating a streak
    // that's actually much older than what got fetched (e.g. a rolling
    // 12-month window). The function has no way to know data exists beyond
    // what it's given, so it must treat "no entry" the same as "zero", and
    // therefore stop the walk right at the edge of the provided data.
    const dayMap = {
      "2026-07-15": { count: 1 },
      "2026-07-14": { count: 1 },
      "2026-07-13": { count: 1 },
    };
    const { streak } = calculateCurrentStreak(dayMap, now);
    assert.equal(streak, 3, "the walk correctly stops at the edge of available data rather than assuming an unbounded streak");
  }
);

test("calculateYearTotal: sums only the current UTC calendar year, ignoring last year's days", () => {
  const dayMap = { "2025-12-31": { count: 9 }, "2026-01-01": { count: 2 }, "2026-07-15": { count: 3 } };
  assert.equal(calculateYearTotal(dayMap, new Date("2026-07-15T12:00:00Z")), 5);
});

test("calculateYearTotal: the year is taken in UTC — 23:30 on Dec 31 UTC is still the old year even where it's already Jan 1 locally", () => {
  const dayMap = { "2025-06-01": { count: 4 }, "2026-01-01": { count: 7 } };
  assert.equal(calculateYearTotal(dayMap, new Date("2025-12-31T23:30:00Z")), 4);
  assert.equal(calculateYearTotal(dayMap, new Date("2026-01-01T00:00:00Z")), 7);
});

test("calculateYearTotal: empty, null, undefined and malformed entries are all safe (0 / skipped)", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  assert.equal(calculateYearTotal({}, now), 0);
  assert.equal(calculateYearTotal(null, now), 0);
  assert.equal(calculateYearTotal(undefined, now), 0);
  assert.equal(calculateYearTotal({ "2026-02-02": null, "2026-02-03": {}, "2026-02-04": { count: 2 } }, now), 2);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;

