// lib/progression/store.js
// Persistence for the progression system. Two chrome.storage.local keys, no
// IndexedDB (the data is tiny: ~1 ledger entry per week; see the scale test):
//
//   gsProgression         account-bound state: who, since when, the XP ledger,
//                         streak high-water marks. Written ONLY by sync()/reset()/import.
//   gsProgressionConfig   preferences (weekly target, daily streak on/off). Written
//                         ONLY by setConfig(). Separate key => a preference change can
//                         never lose a sync's write, or vice versa.
//
// The ledger is the single source of truth for XP. There is NO stored balance,
// level or streak counter: they are computed from the ledger / the day map, so
// there is nothing that can fall out of sync, and a half-finished write cannot
// leave a "ledger says X, balance says Y" state.
//
// Concurrency. In-process, mutations run through one promise queue per adapter
// (same pattern as projectStore). Across processes (popup vs. a future service
// worker) chrome.storage has no compare-and-swap, but sync() is convergent:
// awards are derived deterministically from the same data under unique keys, so
// two overlapping syncs append the same entries and a lost write is simply
// re-derived on the next run. That property is tested, not assumed.
//
// Privacy. Everything stays in chrome.storage.local (never .sync). The ledger
// holds rule ids, amounts and dates only — no repo names, no URLs.

import { isValidDateKey } from "./dateKeys.js";
import {
  RULES, RULES_VERSION, DEFAULT_CURVE, balanceOf, deriveAwards, explainAward, levelFromXp,
} from "./xp.js";
import { clampWeeklyTarget, computeStreaks, WEEKLY_TARGET_DEFAULT } from "./streaks.js";

export const PROGRESSION_KEY = "gsProgression";
export const CONFIG_KEY = "gsProgressionConfig";
export const SCHEMA_VERSION = 1;
export const MAX_LEDGER = 5_000; // ~80 years at the real rate (~60 entries/yr); a guard against runaway growth, ~1 MB
export const EXPORT_FORMAT = "gitstreak-progression";

const queues = new WeakMap();
function enqueueFor(adapter, task) {
  const tail = queues.get(adapter) || Promise.resolve();
  const run = tail.then(task);
  queues.set(adapter, run.catch(() => {}));
  return run;
}

export const DEFAULT_CONFIG = Object.freeze({
  weeklyTarget: WEEKLY_TARGET_DEFAULT,
  dailyEnabled: false, // design decision: weekly is the default model
  dailyEnabledSinceKey: null,
});

export function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const since = isValidDateKey(c.dailyEnabledSinceKey) ? c.dailyEnabledSinceKey : null;
  return {
    weeklyTarget: clampWeeklyTarget(c.weeklyTarget ?? DEFAULT_CONFIG.weeklyTarget),
    dailyEnabled: c.dailyEnabled === true,
    dailyEnabledSinceKey: c.dailyEnabled === true ? since : null,
  };
}

/** Returns an error string, or null if `state` is a structurally valid progression state. */
export function validateState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "state is not an object";
  if (state.schemaVersion !== SCHEMA_VERSION) return `unsupported schemaVersion ${state.schemaVersion}`;
  if (typeof state.userId !== "string" || !state.userId) return "missing userId";
  if (!isValidDateKey(state.trackingStartKey)) return "invalid trackingStartKey";
  if (!Array.isArray(state.preclaimed) || !state.preclaimed.every((x) => typeof x === "string")) return "invalid preclaimed";
  if (!Array.isArray(state.ledger)) return "ledger is not an array";
  if (state.ledger.length > MAX_LEDGER) return "ledger too large";
  const seen = new Set();
  for (const e of state.ledger) {
    if (!e || typeof e.key !== "string" || !e.key) return "ledger entry without key";
    if (seen.has(e.key)) return `duplicate ledger key ${e.key}`;
    seen.add(e.key);
    if (typeof e.ruleId !== "string" || !Number.isFinite(e.amount)) return `bad ledger entry ${e.key}`;
    if (!isValidDateKey(e.occurredOn)) return `bad occurredOn on ${e.key}`;
  }
  const hw = state.highWater;
  if (!hw || typeof hw !== "object" || typeof hw.weekly !== "object" || !Number.isFinite(hw.daily)) return "invalid highWater";
  return null;
}

/** GitHub's numeric database id (or a string form of it). Anything else is "no identity". */
export function normalizeUserId(id) {
  if (typeof id === "number") return Number.isSafeInteger(id) && id > 0 ? String(id) : "";
  if (typeof id === "string") return /^[0-9A-Za-z_=-]{1,64}$/.test(id.trim()) ? id.trim() : "";
  return "";
}

function freshState({ userId, todayKey, trackedRepoCount, nowIso }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    userId,
    trackingStartKey: todayKey, // XP is live-only: nothing before today can ever earn it
    createdAt: nowIso,
    // Repos that were already tracked at onboarding must not pay "first tracked repo".
    preclaimed: trackedRepoCount > 0 ? ["first-tracked-repo"] : [],
    ledger: [],
    highWater: { weekly: {}, daily: 0 },
  };
}

export function createProgressionStore(adapter) {
  const mutate = (task) => enqueueFor(adapter, task);

  async function readRaw() {
    const data = await adapter.get([PROGRESSION_KEY, CONFIG_KEY]);
    return { raw: data[PROGRESSION_KEY] ?? null, config: normalizeConfig(data[CONFIG_KEY]) };
  }

  const getConfig = async () => (await readRaw()).config;

  /** The persisted state, or null when absent. Throws nothing; a damaged state reads as null here
   * (sync() reports it as "corrupt" instead of overwriting it). */
  async function getState() {
    const { raw } = await readRaw();
    return raw && validateState(raw) === null ? raw : null;
  }

  /**
   * Evaluate the day map against the rules and append whatever is newly earned.
   * Called after a successful GitHub fetch; safe to call any number of times.
   *
   * @returns {Promise<{status:"ok",newAwards:Array,state:object}
   *   |{status:"no-identity"}|{status:"account-mismatch"}|{status:"corrupt",reason:string}>}
   */
  function sync({ userId, dayMap, todayKey, trackedRepoCount = 0, now = new Date() }) {
    return mutate(async () => {
      const uid = normalizeUserId(userId);
      if (!uid) return { status: "no-identity" };
      if (!isValidDateKey(todayKey)) throw new Error("sync: todayKey must be a YYYY-MM-DD date key");
      const nowIso = now.toISOString();

      const { raw, config } = await readRaw();
      let state;
      let dirty = false;
      if (raw === null) {
        state = freshState({ userId: uid, todayKey, trackedRepoCount, nowIso });
        dirty = true;
      } else {
        const problem = validateState(raw);
        // Never overwrite something we can't read: it may be recoverable (export/import).
        if (problem) return { status: "corrupt", reason: problem };
        if (raw.userId !== uid) return { status: "account-mismatch" };
        state = { ...raw, ledger: raw.ledger.slice(), highWater: { weekly: { ...raw.highWater.weekly }, daily: raw.highWater.daily } };
      }

      const known = new Set(state.ledger.map((e) => e.key));
      const candidates = deriveAwards({
        dayMap, todayKey, trackingStartKey: state.trackingStartKey, config, trackedRepoCount,
        preclaimed: state.preclaimed, existing: state.ledger,
      });
      const newAwards = [];
      for (const c of candidates) {
        if (known.has(c.key)) continue;
        if (state.ledger.length + newAwards.length >= MAX_LEDGER) break;
        newAwards.push({ ...c, awardedAt: nowIso });
        known.add(c.key);
      }
      if (newAwards.length) {
        state.ledger.push(...newAwards);
        dirty = true;
      }

      // High-water marks only ever rise, so a streak that has scrolled out of the
      // 12-month window (or been broken) is still remembered as a personal best.
      const streaks = computeStreaks(dayMap, { todayKey, target: config.weeklyTarget });
      const tKey = String(config.weeklyTarget);
      if (streaks.weekly.longest > (state.highWater.weekly[tKey] || 0)) {
        state.highWater.weekly[tKey] = streaks.weekly.longest;
        dirty = true;
      }
      if (streaks.daily.longest > state.highWater.daily) {
        state.highWater.daily = streaks.daily.longest;
        dirty = true;
      }

      if (dirty) await adapter.set({ [PROGRESSION_KEY]: state }); // one key => one atomic write
      return { status: "ok", newAwards, state };
    });
  }

  /** Update preferences. Enabling the daily streak starts its XP eligibility today. */
  function setConfig(patch, { todayKey }) {
    return mutate(async () => {
      if (!isValidDateKey(todayKey)) throw new Error("setConfig: todayKey must be a YYYY-MM-DD date key");
      const current = (await readRaw()).config;
      const next = { ...current };
      if (patch && "weeklyTarget" in patch) next.weeklyTarget = clampWeeklyTarget(patch.weeklyTarget);
      if (patch && "dailyEnabled" in patch) {
        const on = patch.dailyEnabled === true;
        if (on && !current.dailyEnabled) next.dailyEnabledSinceKey = todayKey;
        next.dailyEnabled = on;
        if (!on) next.dailyEnabledSinceKey = null;
      }
      const normalized = normalizeConfig(next);
      await adapter.set({ [CONFIG_KEY]: normalized });
      return normalized;
    });
  }

  /**
   * Read-only view for the UI: balance, level, streaks, recent awards with reasons.
   * Computes streaks even before the first sync so Pulse can show them immediately.
   */
  async function snapshot({ dayMap, todayKey, curve = DEFAULT_CURVE, recent = 5 }) {
    const { raw, config } = await readRaw();
    const state = raw && validateState(raw) === null ? raw : null;
    const streaks = computeStreaks(dayMap, { todayKey, target: config.weeklyTarget });
    const hwWeekly = state?.highWater.weekly[String(config.weeklyTarget)] || 0;
    const balance = state ? balanceOf(state.ledger) : 0;
    return {
      initialized: !!state,
      config,
      xp: { balance, ...levelFromXp(balance, curve) },
      week: streaks.week,
      weekly: { ...streaks.weekly, longest: Math.max(streaks.weekly.longest, hwWeekly) },
      daily: {
        enabled: config.dailyEnabled,
        ...streaks.daily,
        longest: Math.max(streaks.daily.longest, state?.highWater.daily || 0),
      },
      coverage: streaks.coverage,
      recent: state
        ? state.ledger.slice(-recent).reverse().map((e) => ({ ...e, reason: explainAward(e) }))
        : [],
    };
  }

  /** A JSON-safe backup. XP can't be re-derived from GitHub (it is live-only), so this is the recovery path. */
  async function exportData(now = new Date()) {
    const { raw, config } = await readRaw();
    return { format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), state: raw, config };
  }

  /** Replaces local progression with a validated backup. Rejects anything malformed; changes nothing on failure. */
  function importData(payload) {
    return mutate(async () => {
      if (!payload || payload.format !== EXPORT_FORMAT) throw new Error("Not a GITSTREAK progression backup.");
      if (payload.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported backup version ${payload.schemaVersion}.`);
      if (payload.state != null) {
        const problem = validateState(payload.state);
        if (problem) throw new Error(`Backup is damaged: ${problem}.`);
      }
      await adapter.set({ [PROGRESSION_KEY]: payload.state ?? null, [CONFIG_KEY]: normalizeConfig(payload.config) });
    });
  }

  /** Deletes the account-bound progression (XP, ledger, high-water marks). Preferences are kept. */
  function reset() {
    return mutate(async () => {
      await adapter.set({ [PROGRESSION_KEY]: null });
    });
  }

  return { sync, setConfig, getConfig, getState, snapshot, exportData, importData, reset };
}

export { RULES, RULES_VERSION };
