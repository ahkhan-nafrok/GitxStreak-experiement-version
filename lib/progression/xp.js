// lib/progression/xp.js
// The XP Engine, as pure functions. There is no event bus: XP is DERIVED.
// `deriveAwards` looks at the day map + config and returns every award that
// the data currently justifies, each with a stable idempotency key. The store
// appends only keys it hasn't seen. Re-running with the same data yields the
// same keys, so polling, re-fetching, restarts and concurrent windows can
// never double-pay — idempotency is a property of the keys, not of timing.
//
// Policy (explicit, per design §5.5 / §10.1):
//   * No retroactive XP: only days on/after `trackingStartKey` are considered.
//   * One award per (rule, subject). Different rules may stack on the same day;
//     within a rule nothing repeats (weekly = per ISO week, run = per streak).
//   * No per-commit or per-repo-day rule exists yet, so nothing here can be
//     farmed by volume: the ceiling is one weekly reward per week.
//   * `RULES_VERSION` is stamped on every ledger entry; changing an amount
//     never rewrites old entries.

import { addDays, maxKey } from "./dateKeys.js";
import { activeDayKeys, dailyRuns, weeklyTargetHits, clampWeeklyTarget } from "./streaks.js";

export const RULES_VERSION = 1;

export const RULES = Object.freeze({
  "first-active-day": { category: "consistency", amount: 5 },
  "weekly-target": { category: "consistency", amount: 20 },
  "daily-streak-7": { category: "consistency", amount: 20, runLength: 7 },
  "first-tracked-repo": { category: "building", amount: 15 },
});

/** Level curve: reaching level L+1 from L costs base + step*(L-1) XP. Provisional (design §5.7). */
export const DEFAULT_CURVE = Object.freeze({ base: 100, step: 25 });

export function levelFromXp(xp, curve = DEFAULT_CURVE) {
  const total = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
  let level = 1;
  let spent = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    const cost = curve.base + curve.step * (level - 1);
    if (total < spent + cost) {
      const into = total - spent;
      return { level, xpIntoLevel: into, xpForNext: cost, pct: into / cost, totalAtLevelStart: spent };
    }
    spent += cost;
    level++;
  }
  throw new Error("levelFromXp: curve never terminates");
}

export function balanceOf(ledger) {
  let sum = 0;
  for (const e of ledger || []) if (Number.isFinite(e?.amount)) sum += e.amount;
  return sum;
}

const candidate = (ruleId, subject, occurredOn, detail = {}) => ({
  key: subject ? `${ruleId}:${subject}` : ruleId,
  ruleId,
  ruleVersion: RULES_VERSION,
  category: RULES[ruleId].category,
  amount: RULES[ruleId].amount,
  occurredOn,
  detail,
});

/**
 * @param {object} input
 * @param {Record<string,{count:number}>} input.dayMap
 * @param {string} input.todayKey               UTC "today"
 * @param {string} input.trackingStartKey       first day that may earn XP
 * @param {{weeklyTarget:number,dailyEnabled:boolean,dailyEnabledSinceKey:string|null}} input.config
 * @param {number} input.trackedRepoCount
 * @param {string[]} [input.preclaimed]         one-time rules already satisfied at onboarding
 * @param {Array} [input.existing]              current ledger (only used to recognise an already-paid streak run)
 * @returns {Array} candidates, deterministic order (date, then key)
 */
export function deriveAwards({ dayMap, todayKey, trackingStartKey, config, trackedRepoCount, preclaimed = [], existing = [] }) {
  const out = [];
  const target = clampWeeklyTarget(config?.weeklyTarget);

  // 1. First active day (one-time).
  const live = activeDayKeys(dayMap, { todayKey, fromKey: trackingStartKey });
  if (live.length > 0) out.push(candidate("first-active-day", null, live[0]));

  // 2. Weekly target, once per ISO week.
  for (const hit of weeklyTargetHits(dayMap, { target, todayKey, fromKey: trackingStartKey })) {
    // `detail` must depend only on WHAT was earned, never on WHEN we noticed it
    // (e.g. no "days so far" count), or the same award would serialize differently
    // for a daily user and a once-a-month user.
    out.push(candidate("weekly-target", hit.weekId, hit.reachedOn, { weekId: hit.weekId, target }));
  }

  // 3. Seven-day daily streak — only while the optional daily streak is enabled,
  //    and only counting days since it was enabled (no fabricated continuity).
  if (config?.dailyEnabled) {
    const from = maxKey(trackingStartKey, config.dailyEnabledSinceKey || trackingStartKey);
    const need = RULES["daily-streak-7"].runLength;
    // A paid run is identified by the first-`need`-day window it was paid for.
    // If GitHub later backfills an earlier day, the run's start moves; matching
    // by overlap keeps it the same run instead of paying twice.
    const paid = existing
      .filter((e) => e?.ruleId === "daily-streak-7" && e.detail?.startKey)
      .map((e) => ({ s: e.detail.startKey, e: addDays(e.detail.startKey, need - 1) }));
    for (const run of dailyRuns(activeDayKeys(dayMap, { todayKey, fromKey: from }))) {
      if (run.length < need) continue;
      const winEnd = addDays(run.startKey, need - 1);
      if (paid.some((p) => p.s <= run.endKey && run.startKey <= p.e)) continue;
      out.push(candidate("daily-streak-7", run.startKey, winEnd, { startKey: run.startKey, endKey: winEnd }));
    }
  }

  // 4. First tracked repository (one-time, skipped if it already existed at onboarding).
  if (trackedRepoCount > 0 && !preclaimed.includes("first-tracked-repo")) {
    out.push(candidate("first-tracked-repo", null, todayKey));
  }

  out.sort((a, b) => (a.occurredOn === b.occurredOn ? (a.key < b.key ? -1 : 1) : a.occurredOn < b.occurredOn ? -1 : 1));
  return out;
}

/** Human-readable reason, rendered from the entry (not stored) so the ledger stays small and wording can improve. */
export function explainAward(entry) {
  const d = entry?.detail || {};
  switch (entry?.ruleId) {
    case "first-active-day":
      return `First active day since GITSTREAK started tracking (${entry.occurredOn}).`;
    case "weekly-target":
      return `Weekly target met: ${d.target ?? "?"} active days in ${d.weekId ?? "that week"}.`;
    case "daily-streak-7":
      return `7 active days in a row, starting ${d.startKey ?? entry.occurredOn}.`;
    case "first-tracked-repo":
      return "Started tracking your first repository.";
    default:
      return `Awarded under rule ${entry?.ruleId ?? "unknown"} (v${entry?.ruleVersion ?? "?"}).`;
  }
}
