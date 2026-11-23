// lib/progression/streaks.js
// The Streak Engine: pure functions from a { "YYYY-MM-DD": { count } } day map
// (exactly what Pulse already caches) to weekly and daily consistency stats.
// Nothing here is persisted — it is recomputed on demand over at most ~53
// weeks, so there is no streak state that can drift, desync or need repair.
//
// Definitions (kept deliberately distinct, never interchangeable):
//   Active day     a UTC date key with count > 0. Ten commits = one active day.
//   Weekly target  N active days within one ISO week (Mon..Sun). Default 3.
//   Weekly streak  consecutive ISO weeks that met the target. The CURRENT week
//                  is "in progress": met -> it counts, unmet -> it neither
//                  counts nor breaks (it can still be met).
//   Daily streak   consecutive active days. Today with no activity is
//                  "pending", never a break (same rule as lib/pulse.js).
//
// Data-window honesty: the fetched calendar covers ~12 months. Weeks that
// start before that window are not fully observed, so the weekly walk begins
// at the first FULLY covered week, and `truncated` says when a streak runs
// right up to that edge (it may really be longer).

import {
  addDays, diffDays, eachDay, isValidDateKey, isoWeekId, weekStartKey, weekdayIndex,
} from "./dateKeys.js";

export const WEEKLY_TARGET_DEFAULT = 3;
export const WEEKLY_TARGET_MIN = 1;
export const WEEKLY_TARGET_MAX = 7;

export function clampWeeklyTarget(n) {
  const v = Number(n);
  if (!Number.isInteger(v)) return WEEKLY_TARGET_DEFAULT;
  return Math.min(WEEKLY_TARGET_MAX, Math.max(WEEKLY_TARGET_MIN, v));
}

function assertKey(key, label) {
  if (!isValidDateKey(key)) throw new Error(`${label} must be a YYYY-MM-DD date key, got ${key}`);
}

/** Sorted, de-duplicated active date keys in [fromKey, todayKey]. */
export function activeDayKeys(dayMap, { todayKey, fromKey = null }) {
  const out = [];
  for (const key of Object.keys(dayMap || {})) {
    if (!isValidDateKey(key) || key > todayKey || (fromKey && key < fromKey)) continue;
    const c = dayMap[key]?.count;
    if (typeof c === "number" && c > 0) out.push(key);
  }
  out.sort(); // YYYY-MM-DD sorts chronologically
  return out;
}

/** Earliest key present in the map (the start of the observed window), or null. */
export function coverageStartOf(dayMap) {
  let min = null;
  for (const key of Object.keys(dayMap || {})) {
    if (isValidDateKey(key) && (min === null || key < min)) min = key;
  }
  return min;
}

/** Groups sorted active keys by Monday week start -> sorted day list. */
function groupByWeek(activeKeys) {
  const weeks = new Map();
  for (const key of activeKeys) {
    const ws = weekStartKey(key);
    const list = weeks.get(ws);
    if (list) list.push(key);
    else weeks.set(ws, [key]);
  }
  return weeks;
}

/** Consecutive-day runs over sorted active keys: [{ startKey, endKey, length }]. */
export function dailyRuns(activeKeys) {
  const runs = [];
  let start = null;
  let prev = null;
  for (const key of activeKeys) {
    if (prev !== null && diffDays(prev, key) === 1) {
      prev = key;
      continue;
    }
    if (start !== null) runs.push({ startKey: start, endKey: prev, length: diffDays(start, prev) + 1 });
    start = key;
    prev = key;
  }
  if (start !== null) runs.push({ startKey: start, endKey: prev, length: diffDays(start, prev) + 1 });
  return runs;
}

/**
 * Every week whose active-day count reached `target`, counting only days on or
 * after `fromKey`. `reachedOn` is the day the target-th active day happened —
 * the moment the week was "completed". Used by the XP engine, which passes the
 * tracking-start date so pre-onboarding days can never earn anything.
 */
export function weeklyTargetHits(dayMap, { target, todayKey, fromKey = null }) {
  assertKey(todayKey, "todayKey");
  const t = clampWeeklyTarget(target);
  const hits = [];
  for (const [weekStart, days] of groupByWeek(activeDayKeys(dayMap, { todayKey, fromKey }))) {
    if (days.length >= t) {
      hits.push({ weekId: isoWeekId(weekStart), weekStart, reachedOn: days[t - 1], activeDays: days.length });
    }
  }
  hits.sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  return hits;
}

/**
 * Full streak picture for display. `target` is clamped to 1..7.
 *
 * @returns {{
 *   coverage: {startKey:string,endKey:string}|null,
 *   week: {id:string,startKey:string,endKey:string,activeDays:number,target:number,met:boolean,days:boolean[]},
 *   weekly: {current:number,longest:number,truncated:boolean,weeksEvaluated:number},
 *   daily: {current:number,longest:number,todayPending:boolean,truncated:boolean},
 * }}
 */
export function computeStreaks(dayMap, { todayKey, target = WEEKLY_TARGET_DEFAULT }) {
  assertKey(todayKey, "todayKey");
  const t = clampWeeklyTarget(target);
  const coverageStart = coverageStartOf(dayMap);
  const active = activeDayKeys(dayMap, { todayKey });
  const byWeek = groupByWeek(active);
  const activeSet = new Set(active);

  // ---- current week (always evaluable from whatever days we have) ----
  const currentWeekStart = weekStartKey(todayKey);
  const currentDays = byWeek.get(currentWeekStart) || [];
  const week = {
    id: isoWeekId(currentWeekStart),
    startKey: currentWeekStart,
    endKey: addDays(currentWeekStart, 6),
    activeDays: currentDays.length,
    target: t,
    met: currentDays.length >= t,
    // Mon..Sun, true where active — lets a UI draw the week without recomputing.
    days: Array.from({ length: 7 }, (_, i) => activeSet.has(addDays(currentWeekStart, i))),
  };

  // ---- weekly streak ----
  let weekly = { current: 0, longest: 0, truncated: false, weeksEvaluated: 0 };
  if (coverageStart !== null) {
    // First FULLY observed week: the one starting on/after the window's first day.
    let firstWeek = weekStartKey(coverageStart);
    if (firstWeek < coverageStart) firstWeek = addDays(firstWeek, 7);
    if (firstWeek > currentWeekStart) firstWeek = currentWeekStart; // window shorter than a week

    let run = 0;
    let longest = 0;
    let evaluated = 0;
    for (let ws = firstWeek; ws < currentWeekStart; ws = addDays(ws, 7)) {
      evaluated++;
      if ((byWeek.get(ws)?.length || 0) >= t) {
        run++;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    }
    evaluated++; // the current week
    if (week.met) {
      run++;
      if (run > longest) longest = run;
    }
    weekly = { current: run, longest, truncated: run > 0 && run === evaluated, weeksEvaluated: evaluated };
  }

  // ---- daily streak ----
  const todayActive = activeSet.has(todayKey);
  const anchor = todayActive ? todayKey : addDays(todayKey, -1);
  let current = 0;
  for (let k = anchor; activeSet.has(k); k = addDays(k, -1)) current++;
  const runs = dailyRuns(active);
  let dLongest = 0;
  for (const r of runs) if (r.length > dLongest) dLongest = r.length;
  const daily = {
    current,
    longest: dLongest,
    todayPending: !todayActive,
    truncated: current > 0 && coverageStart !== null && addDays(anchor, -(current - 1)) === coverageStart,
  };

  return {
    coverage: coverageStart === null ? null : { startKey: coverageStart, endKey: todayKey },
    week,
    weekly,
    daily,
  };
}

export { eachDay, weekdayIndex };
