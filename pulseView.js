// pulseView.js
// Tab 1 — Pulse. Rolling last-12-months contribution calendar + current
// streak + this-year total + last-pushed repos. Requires a connected
// GitHub token (GraphQL has no unauthenticated tier), read through the
// vault — never plaintext.
//
// This pass: "Last Pushed" now shows the 3 most recently pushed repos
// (account-wide, via getRecentlyPushedRepos) instead of just 1, rendered
// as a compact list of name + relative-pushed-time rows — no description,
// badge, or language shown anymore. Cache field renamed lastPushedRepo ->
// lastPushedRepos (array).
//
// Carried over from the prior pass: cached data renders BEFORE any
// staleness/fetch logic runs — a stale cache used to skip straight into
// the fetch attempt with nothing shown first, so a failed fetch (e.g. an
// expired token) left the UI blank even with good cached data sitting in
// storage. The last known calendar/streak/stats/last-pushed always render
// immediately, and a subsequent auth failure (GitHubAuthError) leaves that
// render untouched — it never wipes the cache, just flags it as
// stale-because-of-auth and (only on an explicit Update click, not a
// silent background refresh) shows a toast pointing at Settings. Also the
// empty-state "Connect GitHub" CTA, wired to the same open-settings event
// popup.js listens for.
import { ghGraphQL, getRecentlyPushedRepos, GitHubAuthError } from "./lib/github.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { getToken } from "./lib/tokenVault.js";
import { setAuthFailed, ensureConnectionId, getConnectionId } from "./lib/authState.js";
import { PULSE_CACHE_KEY, cacheBelongsTo } from "./lib/accountData.js";
import { showToast } from "./toast.js";
import {
  getRolling12MonthRange,
  toDateKeyUTC,
  CONTRIBUTION_QUERY,
  parseContributionCalendar,
  buildContributionGrid,
  isContributionCacheStale,
  calculateCurrentStreak,
  calculateYearTotal,
} from "./lib/pulse.js";

const LAST_PUSHED_COUNT = 3;
const SUCCESS_STATE_MS = 1600;
const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function initPulseView() {
  const tokenPrompt = document.getElementById("pulse-token-prompt");
  const tokenCtaBtn = document.getElementById("pulse-token-cta");
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
  const plpListEl = document.getElementById("plp-list");

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

  /** Today's date-key in the same YYYY-MM-DD shape as cell.date, so a single
   * string comparison marks the current-day cell for the ember ring. UTC, to
   * match GitHub's calendar days and every other date in the app — a local
   * key put the ring on the wrong cell (or none) for hours each day. */
  function todayDateKey() {
    return toDateKeyUTC(new Date());
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
          const month = new Date(firstDated.date).getUTCMonth();
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

  /** Renders up to LAST_PUSHED_COUNT repos as compact single-line rows —
   * icon + repo name (truncated with ellipsis if long) + right-aligned
   * relative pushed time. No description/badge/language — those were
   * dropped from both the fetched shape (lib/github.js) and this render
   * on purpose, per the "name + time only" design. */
  function renderLastPushed(repos) {
    if (!Array.isArray(repos) || repos.length === 0) {
      lastPushedEl.hidden = true;
      return;
    }
    lastPushedEl.hidden = false;
    plpListEl.innerHTML = repos
      .map(
        (repo) => `
        <div class="plp-row">
          <div class="plp-row-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          </div>
          <span class="plp-row-name mono" title="${escapeHtml(repo.fullName)}">${escapeHtml(repo.fullName)}</span>
          <span class="plp-row-time">${repo.pushedAt ? escapeHtml(formatRelativeTime(repo.pushedAt)) : ""}</span>
        </div>`
      )
      .join("");
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
    renderLastPushed(cache.lastPushedRepos || []);
    renderLastUpdated(cache.fetchedAt || null);
  }

  /** Wipes everything rendered from account data. Used when there is no
   * connection (a disconnected popup must not keep the old account's repos and
   * streak in the DOM) and when the cache on disk belongs to a different
   * connection than the current one. */
  function clearRendered() {
    calendarWrap.hidden = true;
    statsRow.hidden = true;
    lastPushedEl.hidden = true;
    lastUpdatedEl.hidden = true;
    gridEl.innerHTML = "";
    monthsEl.innerHTML = "";
    plpListEl.innerHTML = "";
  }

  const emitAuthChanged = () => window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
  const stillConnected = async (connectionId) => (await getConnectionId(chromeStorageAdapter)) === connectionId;

  // Bumped by every load(). A load that finds it was overtaken by a newer one
  // (token-saved / disconnected arriving mid-flight, a second click) drops its
  // result instead of rendering over the newer state.
  let loadGen = 0;

  async function load(forceRefresh = false) {
    const gen = ++loadGen;
    const superseded = () => gen !== loadGen;

    // An explicit click gets feedback (and double-click protection) at once,
    // not after the vault has been read.
    setUpdateBtnState(forceRefresh ? "loading" : "idle");

    const token = await getToken(chromeStorageAdapter);
    if (superseded()) return;
    if (!token) {
      clearRendered();
      tokenPrompt.hidden = false;
      setStatus("");
      setUpdateBtnState("idle");
      return;
    }
    tokenPrompt.hidden = true;

    const connectionId = await ensureConnectionId(chromeStorageAdapter);
    const stored = (await chromeStorageAdapter.get([PULSE_CACHE_KEY]))[PULSE_CACHE_KEY] || null;
    if (superseded()) return;

    // A cache is trusted only if it was written under the CURRENT connection.
    // Another account's data, data from before a disconnect, and data from
    // before connection ids existed are all treated as absent (one refetch).
    const cache = cacheBelongsTo(stored, connectionId) ? stored : null;

    // Cached data renders FIRST, unconditionally, before any freshness check
    // or network call, so a failed fetch (expired token, offline, rate limit)
    // never blanks the UI (invariant 5). With no trusted cache, whatever the
    // DOM still holds belongs to a previous account — clear it.
    if (cache) renderAll(cache);
    else clearRendered();

    const stale = isContributionCacheStale(cache) || (cache && !Array.isArray(cache.lastPushedRepos));
    if (!forceRefresh && !stale) {
      setStatus("");
      return;
    }

    setUpdateBtnState("loading");
    setStatus(cache ? "" : "Fetching your latest activity...");
    try {
      const range = getRolling12MonthRange();
      const [contribData, pushed] = await Promise.all([
        ghGraphQL(CONTRIBUTION_QUERY, { from: range.from, to: range.to }, token),
        // null (not []) on failure, so a flaky second call can't erase a good list.
        getRecentlyPushedRepos(token, LAST_PUSHED_COUNT).catch(() => null),
      ]);

      const sameConnection = await stillConnected(connectionId);
      if (superseded()) return;
      if (!sameConnection) {
        // The account changed while this request was in flight. The result
        // belongs to the old connection: drop it, then show the current one.
        setUpdateBtnState("idle");
        load(false).catch(reportLoadFailure);
        return;
      }

      const newCache = {
        connectionId,
        asOfDateKey: range.asOfDateKey,
        dayMap: parseContributionCalendar(contribData),
        grid: buildContributionGrid(contribData),
        lastPushedRepos: pushed ?? cache?.lastPushedRepos ?? [],
        fetchedAt: new Date().toISOString(),
      };
      await chromeStorageAdapter.set({ [PULSE_CACHE_KEY]: newCache });

      // A disconnect can land between the check above and this write. If it
      // did, don't leave the old account's data on disk.
      if (!(await stillConnected(connectionId))) {
        await chromeStorageAdapter.set({ [PULSE_CACHE_KEY]: null });
        if (!superseded()) {
          setUpdateBtnState("idle");
          load(false).catch(reportLoadFailure);
        }
        return;
      }
      if (superseded()) return;

      renderAll(newCache);
      setStatus("");
      setUpdateBtnState("success");
      await setAuthFailed(chromeStorageAdapter, false);
      emitAuthChanged();
    } catch (e) {
      if (superseded()) return;
      if (e instanceof GitHubAuthError) {
        // Only blame the CURRENT connection: a 401 for a token that has since
        // been replaced says nothing about the new one.
        const sameConnection = await stillConnected(connectionId);
        if (superseded()) return;
        if (sameConnection) {
          await setAuthFailed(chromeStorageAdapter, true);
          emitAuthChanged();
        }
        setUpdateBtnState("idle");
        setStatus("");
        // The cache already rendered above and is left exactly as-is. The
        // toast fires only on an explicit click (forceRefresh) — a silent
        // background refresh failing on every popup open would spam it.
        if (sameConnection && forceRefresh) {
          showToast("Your GitHub token stopped working — reconnect it to keep this up to date.", {
            actionLabel: "Open Settings",
            onAction: () => window.dispatchEvent(new CustomEvent("gitstreak:open-settings")),
            key: "pulse-auth-failed",
          });
        }
      } else {
        setStatus(e.message, true);
        setUpdateBtnState("idle");
      }
    }
  }

  /** load() can reject if chrome.storage itself fails; never leave an
   * unhandled rejection or a button stuck on "Updating...". */
  function reportLoadFailure(e) {
    console.error("GITSTREAK pulse:", e);
    setStatus("Couldn't load your data — try again.", true);
    setUpdateBtnState("idle");
  }
  const runLoad = (force) => load(force).catch(reportLoadFailure);

  enableDragScroll(calendarWrap);
  refreshBtn.addEventListener("click", () => runLoad(true));
  tokenCtaBtn?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("gitstreak:open-settings")));

  // A new connection (token-saved) or a removed one (disconnected) changes
  // which account's data this tab may show. Deliberately NOT auth-changed:
  // this view dispatches that event, so handling it would loop (invariant 12).
  window.addEventListener("gitstreak:token-saved", () => runLoad(false));
  window.addEventListener("gitstreak:disconnected", () => runLoad(false));

  runLoad(false);
}

/** Click-and-drag / touch-swipe horizontal scroll for the calendar wrap,
 * with momentum: on release, the last-known drag velocity decays via
 * friction into continued scrolling, eased out — the same feel as a
 * native scroll surface (and GitHub's own contribution graph). Mouse
 * listeners stay on `window` for move/up so a drag leaving the element's
 * bounds doesn't get stuck "down." */
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
