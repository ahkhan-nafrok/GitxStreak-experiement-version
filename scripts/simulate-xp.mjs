// scripts/simulate-xp.mjs — economy check for design doc §5.7 ("simulate before locking").
// Runs the REAL rules (deriveAwards) over synthetic two-year histories for typical
// developer patterns and reports how long levels take. Not part of `npm test`.
//   node scripts/simulate-xp.mjs
import { deriveAwards, levelFromXp } from "../lib/progression/xp.js";
import { addDays, weekdayIndex } from "../lib/progression/dateKeys.js";
import { mulberry32 } from "../test/helpers/memoryAdapter.mjs";

const START = "2026-01-05"; // Monday
const WEEKS = 104;
const END = addDays(START, WEEKS * 7 - 1);

function persona(name, pickDays, { daily = false } = {}) {
  const rand = mulberry32(name.length * 977);
  const dayMap = {};
  for (let w = 0; w < WEEKS; w++) {
    const monday = addDays(START, w * 7);
    for (const i of pickDays(w, rand)) dayMap[addDays(monday, i)] = { count: 1 + Math.floor(rand() * 8) };
  }
  return { name, dayMap, daily };
}
const sample = (n, pool, rand) => { const p = [...pool], out = []; while (out.length < n && p.length) out.push(p.splice(Math.floor(rand() * p.length), 1)[0]); return out; };
const ALL = [0, 1, 2, 3, 4, 5, 6];

const personas = [
  persona("1 day/week", (_, r) => sample(1, ALL, r)),
  persona("2 days/week", (_, r) => sample(2, ALL, r)),
  persona("3 days/week (the default target)", (_, r) => sample(3, ALL, r)),
  persona("5 days/week (weekdays)", () => [0, 1, 2, 3, 4]),
  persona("7 days/week, daily streak ON", () => ALL, { daily: true }),
  persona("bursty: 5 days, then 3 weeks off", (w) => (w % 4 === 0 ? [0, 1, 2, 3, 4] : [])),
];

const curves = {
  "current   100 + 25(L-1)": { base: 100, step: 25 },
  "flatter    50 + 10(L-1)": { base: 50, step: 10 },
};
const marks = [2, 5, 10, 15, 20];

function xpTimeline(p) {
  const cfg = { weeklyTarget: 3, dailyEnabled: p.daily, dailyEnabledSinceKey: START };
  const awards = deriveAwards({ dayMap: p.dayMap, todayKey: END, trackingStartKey: START, config: cfg, trackedRepoCount: 1 });
  const byWeek = new Array(WEEKS).fill(0);
  for (const a of awards) byWeek[Math.min(WEEKS - 1, Math.floor((new Date(a.occurredOn) - new Date(START)) / 6048e5))] += a.amount;
  const cum = []; let s = 0; for (const x of byWeek) cum.push((s += x));
  return { cum, total: s, awards };
}

console.log(`Simulated ${WEEKS} weeks per persona using the live rule table.\n`);
for (const [cname, curve] of Object.entries(curves)) {
  console.log(`Curve: ${cname}`);
  console.log(`${"persona".padEnd(36)}${"XP/wk".padStart(7)}${"2y XP".padStart(8)}${"2y lvl".padStart(8)}  weeks to level ${marks.join(" / ")}`);
  for (const p of personas) {
    const { cum, total } = xpTimeline(p);
    const when = marks.map((L) => { const i = cum.findIndex((x) => levelFromXp(x, curve).level >= L); return i < 0 ? "—" : i + 1; });
    console.log(`${p.name.padEnd(36)}${(total / WEEKS).toFixed(1).padStart(7)}${String(total).padStart(8)}${String(levelFromXp(total, curve).level).padStart(8)}  ${when.join(" / ")}`);
  }
  console.log();
}
