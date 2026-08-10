// projectsView.js
// Tab 2 — Projects. A manually curated tracked-repo list: add any public
// repo, or your own private repos (needs a token with private-repo scope).
// Pin up to 4; the rest sort as "recently pushed" by commit recency. Change
// tracking (lastCheckedAt, commitHistory, never-checked-bubbles-up) is
// unchanged from the old Project Knowledge Manager — just rewired onto this
// tracked-repo model instead of GitHub's own "pinned profile" concept.
//
// The old account-level "GitHub Overview" block (contribution calendar +
// recently-pushed-via-/user/repos) that used to live at the bottom of this
// tab is gone — the calendar moved to Pulse (Tab 1), and "recently pushed"
// here is now just this same tracked list's unpinned tail, sorted by commit
// recency (sortProjectsForList already does this).
//
// This tab is deliberately NOT gated on having a token — public repos work
// fully unauthenticated, and browsing/pinning/adding never touch GitHub at
// all. The only place a token matters is the actual "Check for Updates"
// network call, which now distinguishes an auth failure (GitHubAuthError,
// e.g. an expired/revoked token) from any other error and surfaces it as a
// dismissible toast pointing at Settings, instead of a plain inline error
// line — nothing here blocks or locks based on token state.
import { getLatestCommit, getRepoMeta, parseRepoInput, GitHubAuthError } from "./lib/github.js";
import { createProjectStore } from "./lib/projectStore.js";
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
   * Shared check logic used by both the new-project flow and the manual
   * refresh button.
   *
   * `lastCheckedAt` is stamped FIRST, before the network call — per spec,
   * it must be stamped "every time you check a repo, regardless of
   * outcome." Stamping it only after a successful fetch would mean a repo
   * that keeps failing (rate limit, network blip, revoked token) silently
   * stops showing as recently checked, which defeats the point of that
   * field: you'd have no way to tell "checked recently, no changes" apart
   * from "hasn't been reachable in days."
   *
   * If the commit fetch throws, it propagates to the caller (both callers
   * already catch and surface it) — but the stamp above has already been
   * saved, so the failure is visible without corrupting change-tracking
   * facts. Token is read from the vault so private repos work when a
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

  newBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const repo = repoInput.value.trim();
    if (!name || !repo) {
      alert("Give the project a name and a repo (owner/repo).");
      return;
    }
    const id = slugify(name);
    try {
      await store.create(id, name, repo);
      nameInput.value = "";
      repoInput.value = "";
      newForm.open = false;
      await renderList();
      await openProject(id);

      // Immediately fetch commit #1 + repo meta so the card isn't empty on
      // first open. Non-blocking: if this fails (bad repo name, rate
      // limit, private repo with no token), the project still exists —
      // just surface the error inline, no rollback. lastCheckedAt will
      // still have been stamped inside checkForUpdates even on failure.
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
        await setAuthFailed(chromeStorageAdapter, true);
        window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
        setStatus(pdStatus, "");
        showToast("GitHub rejected your token — reconnect it in Settings for private-repo checks.", {
          actionLabel: "Open Settings",
          onAction: () => window.dispatchEvent(new CustomEvent("gitstreak:open-settings")),
          key: "projects-auth-failed",
        });
      } else {
        setStatus(pdStatus, e.message, true);
      }
    } finally {
      pdRefreshBtn.disabled = false;
    }
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