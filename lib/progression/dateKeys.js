// lib/progression/dateKeys.js
// Pure calendar math on "YYYY-MM-DD" keys. Everything here is UTC string/
// integer arithmetic — no local-time Date, no timezones — because GitHub's
// contribution calendar is already bucketed into days and we only ever need
// to ask "which week is this day in". Weeks are ISO weeks (Monday..Sunday).

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 for a valid key, or null. Rejects 2026-02-31 etc. */
export function keyToDayNumber(key) {
  const m = KEY_RE.exec(String(key));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / MS_PER_DAY);
}

export function dayNumberToKey(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, "0");
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const isValidDateKey = (key) => keyToDayNumber(key) !== null;

export function addDays(key, delta) {
  const n = keyToDayNumber(key);
  if (n === null) throw new Error(`Invalid date key: ${key}`);
  return dayNumberToKey(n + delta);
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  const na = keyToDayNumber(a);
  const nb = keyToDayNumber(b);
  if (na === null || nb === null) throw new Error(`Invalid date key: ${na === null ? a : b}`);
  return nb - na;
}

/** 0 = Monday .. 6 = Sunday. (1970-01-01 was a Thursday.) */
export function weekdayIndex(key) {
  const n = keyToDayNumber(key);
  if (n === null) throw new Error(`Invalid date key: ${key}`);
  return (((n + 3) % 7) + 7) % 7;
}

/** The Monday on or before `key`. */
export function weekStartKey(key) {
  return addDays(key, -weekdayIndex(key));
}

/** ISO 8601 week id, e.g. "2026-W48". The ISO week-year can differ from the
 * calendar year at the edges (2024-12-30 is 2025-W01). */
export function isoWeekId(key) {
  const monday = weekStartKey(key);
  const thursday = addDays(monday, 3); // an ISO week belongs to the year of its Thursday
  const isoYear = Number(thursday.slice(0, 4));
  // The Thursday's 0-based day-of-year, divided into 7-day blocks, is the week.
  const week = Math.floor(diffDays(`${String(isoYear).padStart(4, "0")}-01-01`, thursday) / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Keys from `from` to `to` inclusive. */
export function eachDay(from, to) {
  const out = [];
  const a = keyToDayNumber(from);
  const b = keyToDayNumber(to);
  if (a === null || b === null) return out;
  for (let n = a; n <= b; n++) out.push(dayNumberToKey(n));
  return out;
}

export const maxKey = (a, b) => (a >= b ? a : b); // lexicographic order == chronological for valid keys
