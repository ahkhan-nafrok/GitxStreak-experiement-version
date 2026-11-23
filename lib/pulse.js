// lib/pulse.js
// Pure, deterministic logic for Tab 1 (Pulse): a rolling-last-12-months
// contribution calendar (matching GitHub's own default profile view, not a
// calendar-year window) and a "current streak" calculation. No network
// calls live here — fetching is lib/github.js's job (ghGraphQL), storage is
// pulseView.js's job. Fully unit-testable without a browser or a live token.
//
// Replaces the old lib/githubOverview.js, which was scoped to a single
// current UTC month. That file's shape (GraphQL query, parseContribution-
// Calendar day-flattening) is preserved where it still applies; the
// month-grid-building and month-based staleness functions are replaced with
// rolling-range equivalents.

/** Zero-padded UTC date key, e.g. "2026-07-04". */
export function toDateKeyUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Rolling last-12-months range ending today (UTC), as a [from, to)
 * DateTime range for GraphQL — matches GitHub's own default profile view.
 * `to` is exclusive and set to the start of tomorrow so today is included.
 */
export function getRolling12MonthRange(now = new Date()) {
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(todayUTC);
  from.setUTCFullYear(from.getUTCFullYear() - 1);
  from.setUTCDate(from.getUTCDate() + 1); // inclusive 365/366-day window ending today

  const to = new Date(todayUTC);
  to.setUTCDate(to.getUTCDate() + 1); // exclusive upper bound = start of tomorrow

  return { from: from.toISOString(), to: to.toISOString(), asOfDateKey: toDateKeyUTC(todayUTC) };
}

/** Same shape as before — viewer's own contribution calendar over a date range. */
export const CONTRIBUTION_QUERY = `
  query($from: DateTime!, $to: DateTime!) {
    viewer {
      id
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

/** The viewer's GitHub node id (stable across username changes), or null. Progression is keyed by it. */
export function parseViewerId(graphqlData) {
  const id = graphqlData?.viewer?.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Flatten a raw GraphQL contributionCalendar response into a flat
 * { "YYYY-MM-DD": { count } } map. Defensive: any malformed or missing
 * shape returns an empty map rather than throwing.
 */
export function parseContributionCalendar(graphqlData) {
  const dayMap = {};
  const weeks = graphqlData?.viewer?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) return dayMap;

  for (const week of weeks) {
    const days = week?.contributionDays;
    if (!Array.isArray(days)) continue;
    for (const day of days) {
      if (!day?.date) continue;
      dayMap[day.date] = { count: day.contributionCount || 0 };
    }
  }
  return dayMap;
}

/**
 * Builds the heatmap grid directly from GitHub's own week structure in the
 * raw GraphQL response — GitHub already returns weeks aligned Sun..Sat for
 * exactly the requested range, so there's no need to recompute month
 * boundaries by hand (unlike the old single-month version). Each week is a
 * length-7 array; days outside the actual data (shouldn't normally happen
 * within GitHub's own response, but defensively handled) are `null`.
 * `contributed` is a plain boolean (count > 0) — binary only.
 */
export function buildContributionGrid(graphqlData) {
  const weeks = graphqlData?.viewer?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) return [];

  return weeks.map((week) => {
    const days = Array.isArray(week?.contributionDays) ? week.contributionDays : [];
    const cells = days.map((day) =>
      day?.date ? { date: day.date, contributed: !!(day.contributionCount > 0) } : null
    );
    while (cells.length < 7) cells.push(null);
    return cells;
  });
}

// ---------------------------------------------------------------------------
// Intensity levels + tooltip text (pure; the view only paints their output)
// ---------------------------------------------------------------------------

/** Number of non-empty intensity levels (1..4); level 0 means no contributions. */
export const CONTRIBUTION_LEVELS = 4;

/** Share of active days the shading scale covers; days above it simply cap at level 4. */
export const SCALE_PERCENTILE = 0.95;

/**
 * The count that maps to the brightest level: the 95th percentile of the
 * window's ACTIVE days (nearest-rank), not the single busiest day. With a
 * plain maximum, one 200-commit spike pushes every ordinary day down to the
 * faintest shade, which hides exactly the "busy vs quiet" contrast this view
 * is for. Here a spike just caps at level 4. 0 when there are no active days.
 */
export function contributionScale(dayMap) {
  const counts = [];
  for (const entry of Object.values(dayMap || {})) {
    const c = entry?.count;
    if (typeof c === "number" && c > 0) counts.push(c);
  }
  if (counts.length === 0) return 0;
  counts.sort((a, b) => a - b);
  return counts[Math.ceil(SCALE_PERCENTILE * counts.length) - 1];
}

/**
 * Intensity of one day, 0..4, against the window's scale (contributionScale):
 * proportional, so a 2-contribution day is clearly dimmer than a 12-
 * contribution one; a steady one-a-day user sees every active day at full
 * strength; a day above the scale caps at 4. Non-numeric / non-positive
 * input is level 0, and a real contribution is never below level 1.
 */
export function getContributionLevel(count, scale) {
  if (typeof count !== "number" || typeof scale !== "number" || !(count > 0) || !(scale > 0)) return 0;
  const level = Math.ceil((count / scale) * CONTRIBUTION_LEVELS);
  return Math.min(CONTRIBUTION_LEVELS, Math.max(1, level));
}

const FULL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd". */
export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

/**
 * GitHub-style tooltip text: "1 contribution on November 16th." / "No
 * contributions on …". The year is added only for days outside the current
 * UTC year, so the common case stays short. Returns "" for a malformed date.
 * Pure UTC arithmetic — never goes through a local-time Date.
 */
export function formatContributionTooltip(dateKey, count, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!m) return "";
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const lead = n === 0 ? "No contributions" : `${n} contribution${n === 1 ? "" : "s"}`;
  const yearPart = year === now.getUTCFullYear() ? "" : `, ${year}`;
  return `${lead} on ${FULL_MONTH_NAMES[month - 1]} ${ordinal(day)}${yearPart}.`;
}

/**
 * Is a stored contribution cache stale? True if there's no cache, or its
 * `asOfDateKey` isn't today (UTC) — a rolling window needs a same-day
 * refetch to stay accurate (yesterday's "last day in window" rolls off,
 * today's slot needs to exist). A manual refresh always refetches regardless.
 */
export function isContributionCacheStale(cache, now = new Date()) {
  if (!cache || !cache.asOfDateKey) return true;
  return cache.asOfDateKey !== toDateKeyUTC(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

/**
 * Current streak: consecutive days with >=1 contribution, counted backward
 * from today. Today counts as "pending" (not counted, not breaking) if it
 * has zero contributions so far — the streak only breaks once a day
 * actually closes with nothing logged. So: if today has contributions,
 * count it and keep walking backward; if today has none, skip it (don't
 * break on it) and start the backward walk from yesterday instead.
 *
 * Returns { streak, todayPending }. `todayPending` is true when today has
 * zero contributions so far, purely for UI messaging ("today not logged
 * yet") — it does not affect the numeric streak beyond the walk described
 * above.
 */
export function calculateCurrentStreak(dayMap, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayKey = toDateKeyUTC(today);
  const todayCount = dayMap[todayKey]?.count || 0;
  const todayPending = todayCount === 0;

  let streak = 0;
  const cursor = new Date(today);

  if (!todayPending) {
    streak = 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  } else {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  while (true) {
    const key = toDateKeyUTC(cursor);
    const count = dayMap[key]?.count || 0;
    if (count <= 0) break;
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return { streak, todayPending };
}

/**
 * Sums contribution counts for the current calendar year (Jan 1 through
 * today, UTC) out of a flat dayMap. Safe to rely on with the rolling
 * 12-month window specifically: a 12-month lookback from any date always
 * fully covers Jan 1 of the current year through today, so this never
 * silently under-counts due to data falling outside the fetched range.
 */
export function calculateYearTotal(dayMap, now = new Date()) {
  const yearPrefix = `${now.getUTCFullYear()}-`;
  let total = 0;
  for (const [dateKey, entry] of Object.entries(dayMap || {})) {
    if (dateKey.startsWith(yearPrefix)) {
      total += entry?.count || 0;
    }
  }
  return total;
}

