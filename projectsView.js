// projectsView.js
// Tab 2 — Projects. A manually curated tracked-repo list: add any public
// repo, or your own private repos (needs a token with private-repo scope).
// Pin up to 4; the rest sort as "recently pushed" by commit recency. Change
// tracking (lastCheckedAt, commitHistory, never-checked-bubbles-up) is
// unchanged from the old Project Knowledge Manager — just rewired onto this
// tracked-repo model instead of GitHub's own "pinned profile" concept.
//
// This pass: added the "Add from GitHub" picker (#github-picker), a second
// entry point onto the exact same createTrackedProject()/checkForUpdates()
// path the URL-form (#new-project-btn) already used, so there's one write
// path with two UIs rather than two divergent ones.
//
// The button is always visible — clicking it never silently no-ops.
// Gating happens in stages, cheapest first, all before any picker UI shows:
//   1. MAX_TRACKED cap (no network call needed) — toast, picker never opens.
//   2. No token saved (no network call needed) — toast pointing at
//      Settings, picker never opens.
//   3. Token present but rejected by GitHub (401, revoked/expired) — only
//      discoverable once the picker's first fetch actually runs. On that,
//      the picker closes and this fires the SAME setAuthFailed +
//      gitstreak:auth-changed + toast sequence pdRefreshBtn's
//      GitHubAuthError handler already uses below (same toast `key`, so
//      the two paths can't double up a duplicate notice).
// This keeps exactly one "your GitHub auth needs attention" UX in the app,
// regardless of which button triggered it.
//
// This tab is otherwise deliberately NOT gated on having a token for its
// existing manual-add/browse/pin flows — public repos work fully
// unauthenticated. The only things that ever require a token are: private
// repos, "Check for Updates" against a private repo, and the new picker
// (which only ever lists the authenticated account's own repos, so it
// always needs one).
import { getLatestCommit, getRepoMeta, parseRepoInput, listUserRepos, GitHubAuthError } from "./lib/github.js";
import { createProjectStore, MAX_TRACKED } from "./lib/projectStore.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { getToken } from "./lib/tokenVault.js";
import { setAuthFailed } from "./lib/authState.js";
import { showToast } from "./toast.js";

const store = createProjectStore(chromeStorageAdapter);

let activeProjectId = null;

const ICON_PIN =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2a1 1 0 0 0-1 1v11l4.5-2.7L12.5 14V3a1 1 0 0 0-1-1h-7Z" fill="currentColor"/></svg>';
const ICON_X =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_CHECK =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PLUS =
  '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

/**
 * Order projects for the list view:
 *   1. Pinned projects first (max 4), ordered by commit recency among themselves.
 *   2. Unpinned projects after — this is the "recently pushed" section — also
 *      ordered by commit recency.
 * Within either group, a project that has never been checked (no lastCommitAt
 * yet) sorts first in that group — it needs attention first. Pure and
 * exported so it's unit-testable without a DOM.
 */
export function sortProjectsForList(projects) {
  return [...projects].sort((a, b) => {
    const aPinned = !!a.pinned;
    const bPinned = !!b.pinned;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return compareByCommitRecency(a, b);
  });
}

function compareByCommitRecency(a, b) {
  const aChecked = !!a.lastCommitAt;
  const bChecked = !!b.lastCommitAt;
  if (aChecked !== bChecked) return aChecked ? 1 : -1; // never-checked bubbles to the top of its group
  if (!aChecked) return a.name.localeCompare(b.name);
  return new Date(b.lastCommitAt).getTime() - new Date(a.lastCommitAt).getTime();
}

/** Normalizes a stored `repo` field (URL, shorthand, whatever) down to a
 * lowercase "owner/repo" key, for cross-referencing against GitHub API
 * results. Malformed entries are just skipped — never block the picker. */
function normalizeRepoKey(repoField) {
  try {
    const { owner, repo } = parseRepoInput(repoField);
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    return null;
  }
}

export function initProjectsView() {
  const listEl = document.getElementById("project-list");
  const projectsCountEl = document.getElementById("projects-count");
  const newBtn = document.getElementById("new-project-btn");
  const nameInput = document.getElementById("new-project-name");
  const repoInput = document.getElementById("new-project-repo");
  const newForm = document.getElementById("new-project-form");

  const detailEl = document.getElementById("project-detail");
  const pdCloseBtn = document.getElementById("pd-close-btn");
  const pdName = document.getElementById("pd-name");
  const pdRepo = document.getElementById("pd-repo");
  const pdMeta = document.getElementById("pd-meta");
  const pdLastChecked = document.getElementById("pd-last-checked");
  const pdLastCommit = document.getElementById("pd-last-commit");
  const pdPinBtn = document.getElementById("pd-pin-btn");
  const pdRefreshBtn = document.getElementById("pd-refresh-btn");
  const pdStatus = document.getElementById("pd-status");
  const pdHistory = document.getElementById("pd-history");

  // "Add from GitHub" picker elements
  const githubImportBtn = document.getElementById("github-import-btn");
  const pickerEl = document.getElementById("github-picker");
  const gpCloseBtn = document.getElementById("gp-close-btn");
  const gpSearch = document.getElementById("gp-search");
  const gpStatus = document.getElementById("gp-status");
  const gpList = document.getElementById("gp-list");
  const gpLoadMoreBtn = document.getElementById("gp-load-more-btn");
  const gpCapNote = document.getElementById("gp-cap-note");

  let pickerRepos = [];
  let pickerPage = 0;
  let pickerHasNextPage = false;
  let pickerLoading = false;
  let trackedKeySet = new Set();

  function setStatus(el, msg, isError = false) {
    el.hidden = !msg;
    el.textContent = msg;
    el.classList.toggle("error", isError);
  }

  function repoMetaLine(p) {
    if (!p.repoMeta) return "";
    const parts = [];
    parts.push(p.repoMeta.isPrivate ? "Private" : "Public");
    if (p.repoMeta.language) parts.push(p.repoMeta.language);
    if (typeof p.repoMeta.stars === "number") parts.push(`★ ${p.repoMeta.stars}`);
    return parts.join(" · ");
  }

  /** Closes the detail card back to the list — the "back/cancel" affordance. */
  function closeProjectDetail() {
    activeProjectId = null;
    detailEl.hidden = true;
  }

  async function renderList() {
    const projects = sortProjectsForList(await store.list());
    if (projectsCountEl) projectsCountEl.textContent = String(projects.length);
    listEl.innerHTML = "";
    if (!projects.length) {
      listEl.innerHTML = `<div class="empty-state"><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2a1 1 0 0 0-1 1v11l4.5-2.7L12.5 14V3a1 1 0 0 0-1-1h-7Z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg><p class="hint">No repos tracked yet — add one below.</p></div>`;
      return;
    }
    for (const p of projects) {
      const neverChecked = !p.lastCommitAt;
      const row = document.createElement("div");
      row.className = "project-list-item" + (p.pinned ? " is-pinned" : "") + (neverChecked ? " is-pending" : "");
      const metaLine = repoMetaLine(p);
      row.innerHTML = `
        <button class="p-pin ${p.pinned ? "is-pinned" : ""}" title="${p.pinned ? "Unpin" : "Pin to top (max 4)"}">${ICON_PIN}</button>
        <div class="p-body">
          <div class="p-name">${escapeHtml(p.name)}${neverChecked ? '<span class="badge-pending">not checked yet</span>' : ""}</div>
          <div class="p-meta">${escapeHtml(p.repo)} · ${p.lastCommitAt ? "last commit " + timeAgo(p.lastCommitAt) : "GitHub staleness unknown"}</div>
          ${metaLine ? `<div class="p-meta p-meta-repo">${escapeHtml(metaLine)}</div>` : ""}
        </div>
        <button class="p-delete" title="Stop tracking">${ICON_X}</button>
      `;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".p-delete") || e.target.closest(".p-pin")) return;
        openProject(p.id);
      });
      row.querySelector(".p-pin").addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await store.setPinned(p.id, !p.pinned);
          await renderList();
          if (activeProjectId === p.id) await openProject(p.id);
        } catch (err) {
          alert(err.message);
        }
      });
      row.querySelector(".p-delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Stop tracking "${p.name}"? This only removes it from GITSTREAK — nothing on GitHub is affected.`)) return;
        await store.remove(p.id);
        if (activeProjectId === p.id) closeProjectDetail();
        renderList();
      });
      listEl.appendChild(row);
    }
  }

  async function openProject(id) {
    activeProjectId = id;
    const p = await store.get(id);
    if (!p) return;

    pdName.textContent = p.name;
    pdRepo.textContent = p.repo;
    pdMeta.textContent = repoMetaLine(p);
    pdMeta.hidden = !repoMetaLine(p);

    pdLastChecked.textContent = p.lastCheckedAt
      ? `Last checked: ${timeAgo(p.lastCheckedAt)}`
      : "Last checked: never";

    pdLastCommit.textContent = p.lastCommitAt
      ? `Last GitHub commit: ${timeAgo(p.lastCommitAt)}`
      : "Last GitHub commit: unknown";
    pdLastCommit.className = "fact-line" + (p.lastCommitAt ? "" : " unknown");

    pdPinBtn.innerHTML = `${ICON_PIN}<span>${p.pinned ? "Pinned" : "Pin"}</span>`;
    pdPinBtn.classList.toggle("is-pinned", !!p.pinned);

    setStatus(pdStatus, "");

    pdHistory.innerHTML = p.commitHistory.length
      ? "<strong>Commit history</strong>" +
        p.commitHistory
          .map(
            (h) =>
              `<div class="history-entry">${
                h.sha ? escapeHtml(h.sha.slice(0, 7)) : "unknown sha"
              } — ${h.commitDate ? new Date(h.commitDate).toLocaleString() : "unknown date"}</div>`
          )
          .join("")
      : `<p class="hint">No commit history yet — click Check for Updates.</p>`;

    detailEl.hidden = false;
  }

  /**
   * Shared check logic used by the new-project flow (both the URL form and
   * the GitHub picker) and the manual refresh button.
   *
   * `lastCheckedAt` is stamped FIRST, before the network call — per spec,
   * it must be stamped "every time you check a repo, regardless of
   * outcome." Token is read from the vault so private repos work when a
   * token with private scope is connected; a public repo still works fine
   * with token=null.
   */
  async function checkForUpdates(id) {
    const p = await store.get(id);
    if (!p) return;
    const { owner, repo } = parseRepoInput(p.repo);
    const token = await getToken(chromeStorageAdapter);

    await store.updateLastChecked(id);

    const latest = await getLatestCommit(owner, repo, token);
    await store.addCommitHistoryEntry(id, latest);

    try {
      const meta = await getRepoMeta(owner, repo, token);
      await store.updateRepoMeta(id, meta);
    } catch (e) {
      // Repo-meta is display-only — a failure here must never block or
      // corrupt the change-tracking facts already saved above.
      console.warn(`Couldn't refresh repo metadata for ${p.repo}: ${e.message}`);
    }
  }

  /**
   * The one write path onto projectStore.create — used by both the
   * URL-form add and the GitHub picker's add, so there's a single place
   * that turns "a name + a repo" into a tracked project. Propagates
   * store.create's errors (duplicate id, MAX_TRACKED cap) untouched —
   * callers decide how to surface them (alert vs. inline picker message).
   */
  async function createTrackedProject(name, repoFullName) {
    const id = slugify(name);
    await store.create(id, name, repoFullName);
    return id;
  }

  newBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const repo = repoInput.value.trim();
    if (!name || !repo) {
      alert("Give the project a name and a repo (owner/repo).");
      return;
    }
    try {
      const id = await createTrackedProject(name, repo);
      nameInput.value = "";
      repoInput.value = "";
      newForm.open = false;
      await renderList();
      await openProject(id);

      try {
        await checkForUpdates(id);
        await renderList();
        if (activeProjectId === id) await openProject(id);
      } catch (err) {
        await renderList();
        if (activeProjectId === id) await openProject(id);
        setStatus(pdStatus, `Project added, but the first check failed: ${err.message}`, true);
      }
    } catch (e) {
      alert(e.message);
    }
  });

  pdCloseBtn.addEventListener("click", () => {
    closeProjectDetail();
  });

  pdPinBtn.addEventListener("click", async () => {
    if (!activeProjectId) return;
    const p = await store.get(activeProjectId);
    try {
      await store.setPinned(activeProjectId, !p.pinned);
      await renderList();
      await openProject(activeProjectId);
    } catch (e) {
      alert(e.message);
    }
  });

  pdRefreshBtn.addEventListener("click", async () => {
    if (!activeProjectId) return;
    setStatus(pdStatus, "Checking GitHub...");
    pdRefreshBtn.disabled = true;
    try {
      await checkForUpdates(activeProjectId);
      setStatus(pdStatus, "");
      await renderList();
      await openProject(activeProjectId);
    } catch (e) {
      await renderList();
      await openProject(activeProjectId);
      if (e instanceof GitHubAuthError) {
        await handleAuthFailure();
      } else {
        setStatus(pdStatus, e.message, true);
      }
    } finally {
      pdRefreshBtn.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // "Add from GitHub" picker
  // ------------------------------------------------------------------

  /** The single place that reacts to a GitHubAuthError, so every entry
   * point (refresh button, picker fetch) produces the identical toast +
   * state change — same `key`, so repeated triggers can't stack notices. */
  async function handleAuthFailure() {
    await setAuthFailed(chromeStorageAdapter, true);
    window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
    showToast("GitHub rejected your token — reconnect it in Settings.", {
      actionLabel: "Open Settings",
      onAction: () => window.dispatchEvent(new CustomEvent("gitstreak:open-settings")),
      key: "gitstreak-auth-failed",
    });
  }

  function closePicker() {
    pickerEl.hidden = true;
    gpSearch.value = "";
    pickerRepos = [];
    pickerPage = 0;
    pickerHasNextPage = false;
    gpList.innerHTML = "";
    gpLoadMoreBtn.hidden = true;
    setStatus(gpStatus, "");
    if (gpCapNote) gpCapNote.hidden = true;
  }

  async function buildTrackedKeySet() {
    const projects = await store.list();
    const set = new Set();
    for (const p of projects) {
      const key = normalizeRepoKey(p.repo);
      if (key) set.add(key);
    }
    return set;
  }

  function renderPickerList() {
    const query = gpSearch.value.trim().toLowerCase();
    const filtered = query
      ? pickerRepos.filter((r) => r.fullName.toLowerCase().includes(query))
      : pickerRepos;

    if (!filtered.length) {
      gpList.innerHTML = `<p class="hint gp-empty">${
        query ? "No repos match that filter." : "No repos found on this account."
      }</p>`;
      return;
    }

    gpList.innerHTML = "";
    for (const repo of filtered) {
      const key = repo.fullName.toLowerCase();
      const isTracked = trackedKeySet.has(key);
      const row = document.createElement("div");
      row.className = "gp-row" + (isTracked ? " is-tracked" : "");
      const metaParts = [repo.isPrivate ? "Private" : "Public"];
      if (repo.language) metaParts.push(repo.language);
      if (typeof repo.stars === "number") metaParts.push(`★ ${repo.stars}`);
      row.innerHTML = `
        <div class="gp-row-body">
          <div class="gp-row-name">${escapeHtml(repo.fullName)}</div>
          <div class="gp-row-meta">${escapeHtml(metaParts.join(" · "))}</div>
        </div>
        <span class="gp-row-action">${isTracked ? `${ICON_CHECK}<span>Tracked</span>` : `${ICON_PLUS}<span>Add</span>`}</span>
      `;
      if (!isTracked) {
        row.addEventListener("click", () => handlePickerAdd(repo, row));
      }
      gpList.appendChild(row);
    }
  }

  async function handlePickerAdd(repo, rowEl) {
    if (trackedKeySet.has(repo.fullName.toLowerCase()) || rowEl.classList.contains("is-loading")) return;

    const projects = await store.list();
    if (projects.length >= MAX_TRACKED) {
      showToast(`You're tracking the max of ${MAX_TRACKED} repos — remove one first.`, {
        key: "gitstreak-cap-reached",
      });
      if (gpCapNote) gpCapNote.hidden = false;
      return;
    }

    rowEl.classList.add("is-loading");
    try {
      const id = await createTrackedProject(repo.name, repo.fullName);
      // We already have description/language/stars/pushedAt from the
      // picker's own listUserRepos call — save it immediately so the card
      // isn't empty even before checkForUpdates' own getRepoMeta returns.
      await store.updateRepoMeta(id, {
        description: repo.description,
        language: repo.language,
        stargazers_count: repo.stars,
        private: repo.isPrivate,
        pushed_at: repo.pushedAt,
      });
      trackedKeySet.add(repo.fullName.toLowerCase());
      renderPickerList();
      await renderList();

      try {
        await checkForUpdates(id);
        await renderList();
      } catch (e) {
        console.warn(`First check after picker-add failed for ${repo.fullName}: ${e.message}`);
      }
    } catch (e) {
      alert(e.message);
    } finally {
      rowEl.classList.remove("is-loading");
    }
  }

  async function loadPickerPage(page) {
    if (pickerLoading) return;
    pickerLoading = true;
    gpLoadMoreBtn.disabled = true;
    setStatus(gpStatus, page === 1 ? "Loading your repos..." : "Loading more...");

    try {
      const token = await getToken(chromeStorageAdapter);
      if (!token) {
        // Shouldn't normally happen (checked before opening), but a token
        // could be revoked in another tab while the picker sits open.
        closePicker();
        showToast("Connect your GitHub account in Settings to add repos this way.", {
          actionLabel: "Open Settings",
          onAction: () => window.dispatchEvent(new CustomEvent("gitstreak:open-settings")),
          key: "gitstreak-no-token",
        });
        return;
      }

      const { repos, hasNextPage } = await listUserRepos(token, { page, perPage: 30 });
      pickerRepos = page === 1 ? repos : [...pickerRepos, ...repos];
      pickerPage = page;
      pickerHasNextPage = hasNextPage;
      setStatus(gpStatus, "");
      renderPickerList();
      gpLoadMoreBtn.hidden = !hasNextPage;
    } catch (e) {
      if (e instanceof GitHubAuthError) {
        closePicker();
        await handleAuthFailure();
      } else {
        setStatus(gpStatus, e.message, true);
      }
    } finally {
      pickerLoading = false;
      gpLoadMoreBtn.disabled = false;
    }
  }

  async function openPicker() {
    const projects = await store.list();
    if (projects.length >= MAX_TRACKED) {
      showToast(`You're tracking the max of ${MAX_TRACKED} repos — remove one first.`, {
        key: "gitstreak-cap-reached",
      });
      return;
    }

    const token = await getToken(chromeStorageAdapter);
    if (!token) {
      showToast("Connect your GitHub account in Settings to add repos this way.", {
        actionLabel: "Open Settings",
        onAction: () => window.dispatchEvent(new CustomEvent("gitstreak:open-settings")),
        key: "gitstreak-no-token",
      });
      return;
    }

    trackedKeySet = await buildTrackedKeySet();
    pickerEl.hidden = false;
    await loadPickerPage(1);
  }

  githubImportBtn.addEventListener("click", () => {
    openPicker();
  });

  gpCloseBtn.addEventListener("click", () => {
    closePicker();
  });

  gpSearch.addEventListener("input", () => {
    renderPickerList();
  });

  gpLoadMoreBtn.addEventListener("click", () => {
    if (pickerHasNextPage) loadPickerPage(pickerPage + 1);
  });

  renderList();
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}