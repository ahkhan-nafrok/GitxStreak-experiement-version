// pulseView.js
// Tab 1 — Pulse. Rolling last-12-months contribution calendar + current
// streak + this-year total + last-pushed repo. Requires a connected GitHub
// token (GraphQL has no unauthenticated tier), read through the vault —
// never plaintext.
//
// Redesign pass (this session): drag-scroll now has real momentum instead
// of stopping dead on release (see enableDragScroll below — this was the
// single biggest source of the "clunky" feel). Added a month-label row
// that scrolls in sync with the grid. Today's cell gets a ring in the
// ember accent (the ONLY other place besides the streak stat that uses
// color — everything else stays monochrome, per the locked Theme B rule).
// The "Updated Xm ago" freshness caption now renders into a nested span
// inside the Update button itself rather than a separate header element —
// see renderLastUpdated().
import { ghGraphQL, getMostRecentlyPushedRepo } from "./lib/github.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { getToken } from "./lib/tokenVault.js";
import {
  getRolling12MonthRange,
  CONTRIBUTION_QUERY,
  parseContributionCalendar,
  buildContributionGrid,
  isContributionCacheStale,
  calculateCurrentStreak,
  calculateYearTotal,
} from "./lib/pulse.js";

const CACHE_KEY = "ghContributionCache";
const SUCCESS_STATE_MS = 1600;
const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function initPulseView() {
  const tokenPrompt = document.getElementById("pulse-token-prompt");
  const calendarWrap = document.getElementById("pulse-calendar-wrap");
  const monthsEl = document.getElementById("pulse-calendar-months");
  const gridEl = document.getElementById("pulse-calendar-grid");
  const statsRow = document.getElementById("pulse-stats-row");
  const streakEl = document.getElementById("pulse-streak");
  const streakNoteEl = document.getElementById("pulse-streak-note");
  const yearTotalEl = document.getElementById("pulse-year-total");
  const statusEl = document.getElementById("pulse-status");
  const refreshBtn = document.getElementById("pulse-refresh-btn");
  const updateLabelEl = document.getElementById("pulse-update-btn-label");
  const lastUpdatedEl = document.getElementById("pulse-last-updated");
  const lastUpdatedTextEl = document.getElementById("pulse-last-updated-text");
  const lastPushedEl = document.getElementById("pulse-last-pushed");
  const plpRepoNameEl = document.getElementById("plp-repo-name");
  const plpRepoBadgeEl = document.getElementById("plp-repo-badge");
  const plpRepoDescEl = document.getElementById("plp-repo-desc");
  const plpPushedAtEl = document.getElementById("plp-pushed-at");
  const plpLanguageEl = document.getElementById("plp-language");

  let successTimer = null;

  function setStatus(msg, isError = false) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
  }

  function setUpdateBtnState(state) {
    clearTimeout(successTimer);
    refreshBtn.classList.remove("is-loading", "is-success");
    if (state === "loading") {
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-loading");
      updateLabelEl.textContent = "Updating...";
    } else if (state === "success") {
      refreshBtn.disabled = false;
      refreshBtn.classList.add("is-success");
      updateLabelEl.textContent = "Updated";
      successTimer = setTimeout(() => {
        refreshBtn.classList.remove("is-success");
        updateLabelEl.textContent = "Click to Update";
      }, SUCCESS_STATE_MS);
    } else {
      refreshBtn.disabled = false;
      updateLabelEl.textContent = "Click to Update";
    }
  }

  /** Today's date-key in the same YYYY-MM-DD shape as cell.date, so a
   * single string comparison marks the current-day cell for the ember
   * ring — no changes to lib/pulse.js's data shape needed. */
  function todayDateKey() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function renderGrid(weeks) {
    const todayKey = todayDateKey();
    gridEl.innerHTML = weeks
      .map((week) => {
        const cellsHtml = week
          .map((cell) => {
            if (!cell) return '<div class="gh-cal-cell is-blank"></div>';
            const classes = ["gh-cal-cell", cell.contributed ? "is-active" : "is-empty"];
            if (cell.date === todayKey) classes.push("is-today");
            return `<div class="${classes.join(" ")}" title="${escapeHtml(cell.date)}"></div>`;
          })
          .join("");
        return `<div class="gh-cal-col">${cellsHtml}</div>`;
      })
      .join("");
    renderMonthLabels(weeks);
    scrollToPresent();
  }

  /** One label per week-column, shown only when the month changes from
   * the previous column (mirrors how GitHub's own contribution graph
   * avoids repeating the same month name every single week). Lives in
   * its own row inside the same scrollable wrap as the grid so both move
   * together under drag. */
  function renderMonthLabels(weeks) {
    if (!monthsEl) return;
    let lastMonth = null;
    monthsEl.innerHTML = weeks
      .map((week) => {
        const firstDated = week.find((c) => c && c.date);
        let label = "";
        if (firstDated) {
          const month = new Date(firstDated.date).getMonth();
          if (month !== lastMonth) {
            label = MONTH_NAMES[month];
            lastMonth = month;
          }
        }
        return `<div class="gh-cal-month-label">${label}</div>`;
      })
      .join("");
  }

  function scrollToPresent() {
    requestAnimationFrame(() => {
      calendarWrap.scrollLeft = calendarWrap.scrollWidth;
    });
  }

  function renderStreak(dayMap) {
    const { streak, todayPending } = calculateCurrentStreak(dayMap);
    streakEl.textContent = `${streak} day${streak === 1 ? "" : "s"}`;
    streakNoteEl.textContent = todayPending
      ? "Today isn't logged yet — streak holds until the day ends."
      : "";
  }

  function renderYearTotal(dayMap) {
    yearTotalEl.textContent = String(calculateYearTotal(dayMap));
  }

  function renderLastPushed(repo) {
    if (!repo) {
      lastPushedEl.hidden = true;
      return;
    }
    lastPushedEl.hidden = false;
    plpRepoNameEl.textContent = repo.fullName;
    plpRepoBadgeEl.hidden = !repo.isPrivate;
    plpRepoDescEl.textContent = repo.description || "No description";
    plpPushedAtEl.textContent = repo.pushedAt ? `Pushed ${formatRelativeTime(repo.pushedAt)}` : "";
    plpLanguageEl.textContent = repo.language || "";
  }

  /** Freshness caption now renders into the nested text span inside the
   * Update button (see popup.html: #pulse-last-updated wraps a live-dot +
   * #pulse-last-updated-text), rather than a standalone header element,
   * so the fact and the action that changes it read as one unit. */
  function renderLastUpdated(fetchedAt) {
    if (!fetchedAt) {
      lastUpdatedEl.hidden = true;
      return;
    }
    lastUpdatedEl.hidden = false;
    lastUpdatedTextEl.textContent = `Updated ${formatRelativeTime(fetchedAt)}`;
  }

  function renderAll(cache) {
    calendarWrap.hidden = false;
    statsRow.hidden = false;
    renderGrid(Array.isArray(cache.grid) ? cache.grid : []);
    renderStreak(cache.dayMap || {});
    renderYearTotal(cache.dayMap || {});
    renderLastPushed(cache.lastPushedRepo || null);
    renderLastUpdated(cache.fetchedAt || null);
  }

  async function load(forceRefresh = false) {
    const token = await getToken(chromeStorageAdapter);
    if (!token) {
      tokenPrompt.hidden = false;
      calendarWrap.hidden = true;
      statsRow.hidden = true;
      lastPushedEl.hidden = true;
      lastUpdatedEl.hidden = true;
      setStatus("");
      return;
    }
    tokenPrompt.hidden = true;

    const stored = await chromeStorageAdapter.get([CACHE_KEY]);
    const cache = stored[CACHE_KEY] || null;
    const stale = isContributionCacheStale(cache) || (cache && !cache.lastPushedRepo);

    if (!forceRefresh && !stale) {
      renderAll(cache);
      setStatus("");
      return;
    }

    setUpdateBtnState("loading");
    setStatus("Fetching your latest activity...");
    try {
      const range = getRolling12MonthRange();
      const [contribData, lastPushedRepo] = await Promise.all([
        ghGraphQL(CONTRIBUTION_QUERY, { from: range.from, to: range.to }, token),
        getMostRecentlyPushedRepo(token).catch(() => null),
      ]);
      const dayMap = parseContributionCalendar(contribData);
      const grid = buildContributionGrid(contribData);
      const newCache = {
        asOfDateKey: range.asOfDateKey,
        dayMap,
        grid,
        lastPushedRepo,
        fetchedAt: new Date().toISOString(),
      };
      await chromeStorageAdapter.set({ [CACHE_KEY]: newCache });
      renderAll(newCache);
      setStatus("");
      setUpdateBtnState("success");
    } catch (e) {
      setStatus(e.message, true);
      setUpdateBtnState("idle");
    }
  }

  enableDragScroll(calendarWrap);
  refreshBtn.addEventListener("click", () => load(true));

  load(false);
}

/** Click-and-drag / touch-swipe horizontal scroll for the calendar wrap,
 * now WITH momentum: on release, the last-known drag velocity decays via
 * friction into continued scrolling, eased out — the same feel as a
 * native scroll surface (and GitHub's own contribution graph). The
 * previous version was strict 1:1 drag with zero carry-over, so motion
 * stopped dead the instant the pointer lifted; that abruptness was the
 * single largest contributor to the "clunky" feedback this redesign was
 * asked to fix. Mouse listeners stay on `window` for move/up so a drag
 * leaving the element's bounds doesn't get stuck "down." */
function enableDragScroll(el) {
  let isDown = false;
  let startX = 0;
  let scrollLeftStart = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0; // px/ms
  let momentumFrame = null;

  function stopMomentum() {
    if (momentumFrame !== null) {
      cancelAnimationFrame(momentumFrame);
      momentumFrame = null;
    }
  }

  function start(x) {
    stopMomentum();
    isDown = true;
    el.classList.add("is-dragging");
    startX = x;
    scrollLeftStart = el.scrollLeft;
    lastX = x;
    lastT = performance.now();
    velocity = 0;
  }

  function move(x) {
    if (!isDown) return;
    el.scrollLeft = scrollLeftStart - (x - startX);
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) velocity = (x - lastX) / dt;
    lastX = x;
    lastT = now;
  }

  function end() {
    if (!isDown) return;
    isDown = false;
    el.classList.remove("is-dragging");

    let v = velocity * 16; // approximate px-per-frame at 60fps from px/ms
    const FRICTION = 0.94;
    const MIN_VELOCITY = 0.4;

    function step() {
      if (Math.abs(v) < MIN_VELOCITY) {
        momentumFrame = null;
        return;
      }
      el.scrollLeft -= v;
      v *= FRICTION;
      momentumFrame = requestAnimationFrame(step);
    }
    momentumFrame = requestAnimationFrame(step);
  }

  el.addEventListener("mousedown", (e) => {
    start(e.pageX);
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => move(e.pageX));
  window.addEventListener("mouseup", end);

  el.addEventListener("touchstart", (e) => start(e.touches[0].pageX), { passive: true });
  el.addEventListener("touchmove", (e) => move(e.touches[0].pageX), { passive: true });
  el.addEventListener("touchend", end);
}

function formatRelativeTime(isoString, now = new Date()) {
  if (!isoString) return "";
  const thenMs = new Date(isoString).getTime();
  const diffMs = now.getTime() - thenMs;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "";

  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}