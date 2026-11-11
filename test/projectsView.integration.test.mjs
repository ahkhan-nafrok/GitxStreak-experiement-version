// test/projectsView.integration.test.mjs
// Runs the REAL projectsView.js against a fake DOM + fake chrome.storage +
// mocked GitHub fetch (commits + repo-meta endpoints).
//
// Rewritten for the current GITSTREAK architecture: projectsView.js no
// longer owns any GitHub Overview UI (contribution calendar, recently-
// pushed-via-/user/repos) — that moved entirely to pulseView.js (Tab 1).
// This file now only exercises Tab 2: create/pin/check/sort. Element ids
// match the current popup.html exactly, not the old three-section layout.
//
// UI/UX pass (this session): projectsView.js gained a "back to list" close
// button on the detail card (#pd-close-btn) and a live tracked-repo count
// badge (#projects-count). Both element ids were added to the fake DOM
// below — this harness throws a clear "Test harness gap" error for any id
// projectsView.js requests that it doesn't know about, so any new element
// the real code queries via getElementById MUST be registered here or
// initProjectsView() fails immediately on import. New regression coverage
// for both features is added at the bottom of the pinning section.
//
// projectsView.js imports getToken from lib/tokenVault.js, which touches
// `indexedDB` as an ambient global — so a fake indexedDB is wired up even
// though no test here actually saves a token (getToken's null-blob path
// returns early without ever touching it, but this keeps the harness
// robust against that changing later).
//
// Run with: node test/projectsView.integration.test.mjs

import assert from "node:assert/strict";
import { createFakeIndexedDB } from "./helpers/fakeIndexedDB.mjs";

globalThis.indexedDB = createFakeIndexedDB().indexedDB;

// ---------- Fake DOM ----------
function makeFakeElement(id) {
  const listeners = {};
  let _innerHTML = "";
  let _textContent = "";
  const el = {
    id,
    hidden: false,
    disabled: false,
    value: "",
    open: false,
    _children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    async dispatch(type, evt = {}) {
      for (const fn of listeners[type] || []) await fn(evt);
    },
    appendChild(child) {
      el._children.push(child);
    },
    querySelector(sel) {
      // projectsView.js only ever queries ".p-pin" / ".p-delete" within a
      // freshly-built row — return a fresh stub each time, matching how a
      // real querySelector scoped to a detached element would behave.
      const stub = makeFakeElement(`stub-child-${sel}`);
      el._stubChildren = el._stubChildren || {};
      el._stubChildren[sel] = stub;
      return stub;
    },
    querySelectorAll() {
      return [];
    },
  };
  Object.defineProperty(el, "textContent", {
    get() { return _textContent; },
    set(v) {
      _textContent = String(v);
      _innerHTML = _textContent
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() { return _innerHTML; },
    set(v) {
      _innerHTML = v;
      el._children = [];
    },
  });
  Object.defineProperty(el, "className", {
    get() { return [...el.classList._set].join(" "); },
    set(v) { el.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  return el;
}

import { HTML_IDS, HIDDEN_IDS } from "./helpers/fakeDom.mjs";
const elementIds = HTML_IDS; // parsed from the real popup.html: a view asking for an id the HTML lacks still throws below

const elements = {};
for (const id of elementIds) {
  elements[id] = makeFakeElement(id);
  elements[id].hidden = HIDDEN_IDS.has(id);
}

// Rows appended to #project-list are real DOM-like elements built by
// document.createElement("div") inside renderList() — track them so we can
// wire up click listeners on the ACTUAL row objects (not stubs) for the
// multi-project sort scenario below.
const createdRows = [];
globalThis.document = {
  getElementById: (id) => {
    if (!elements[id]) throw new Error(`Test harness gap: projectsView.js requested an element id "${id}" the fake DOM doesn't know about — this itself is a signal the real HTML must have that id.`);
    return elements[id];
  },
  createElement: (tag) => {
    const el = makeFakeElement(`created-${tag}`);
    createdRows.push(el);
    return el;
  },
};

globalThis.window = new EventTarget(); // projectsView registers window listeners
globalThis.alert = (msg) => { throw new Error(`alert() was called (should not happen in this test): ${msg}`); };
globalThis.confirm = () => true;

globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) { cb(chromeStorageMock); },
      set(obj, cb) { Object.assign(chromeStorageMock, obj); cb(); },
    },
  },
  runtime: { lastError: null },
};
let chromeStorageMock = {};

// ---------- Fake GitHub API — commits + repo-meta endpoints only ----------
function jsonResponse(obj) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => obj };
}

let commitCallCount = 0;
let repoMetaCallCount = 0;
let mockSha = "sha-initial";
let mockDate = "2026-07-01T00:00:00Z";
let commitsShouldFail = false;
let mockRepoMeta = {
  description: "A fake test repo",
  language: "JavaScript",
  stargazers_count: 7,
  private: false,
  pushed_at: "2026-07-01T00:00:00Z",
};

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/commits?per_page=1")) {
    commitCallCount++;
    if (commitsShouldFail) throw new Error("simulated GitHub failure");
    return jsonResponse([{ sha: mockSha, commit: { committer: { date: mockDate } } }]);
  }
  if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
    repoMetaCallCount++;
    return jsonResponse(mockRepoMeta);
  }
  throw new Error(`Unhandled mock URL: ${u}`);
};

// ---------- Run the REAL projectsView.js against all of the above ----------
const { initProjectsView } = await import("../projectsView.js");

console.log("=== Basic create + auto-check flow ===");
initProjectsView();
console.log("  ok  - initProjectsView() ran without throwing");

// initProjectsView() fires its initial renderList() without awaiting it
// (matches the real popup.js behavior — nothing in the app awaits this
// either). Let that microtask settle before asserting on anything it sets.
await new Promise((r) => setTimeout(r, 0));

console.log("\nConfirming the empty-state count badge reads 0 before any project exists...");
assert.equal(elements["projects-count"].textContent, "0", "projects-count must read 0 with no tracked repos yet");
console.log("  ok  - projects-count badge starts at 0");

console.log("\nCreating a project via the real 'new project' handler...");
elements["new-project-name"].value = "Fake Project";
elements["new-project-repo"].value = "fake/repo";
await elements["new-project-btn"].dispatch("click");
console.log("  ok  - project created without throwing");

console.log("\nConfirming the first-add auto-check populated history entry #1 and repoMeta immediately...");
assert.equal(commitCallCount, 1, "creating a project must trigger exactly one commit-fetch call, automatically");
assert.equal(repoMetaCallCount, 1, "creating a project must also trigger exactly one repo-meta fetch");
assert.ok(!elements["pd-last-checked"].textContent.includes("never"), "last-checked must no longer read 'never' after the auto-check");
assert.ok(!elements["pd-last-commit"].textContent.includes("unknown"), "last-commit must no longer read 'unknown' after the auto-check");
assert.ok(
  chromeStorageMock.projects["fake/repo"].commitHistory.length === 1,
  "history entry #1 must be recorded in storage immediately on add, not waiting for a manual check"
);
assert.ok(
  chromeStorageMock.projects["fake/repo"].repoMeta,
  "repoMeta must be recorded in storage immediately on add"
);
assert.equal(chromeStorageMock.projects["fake/repo"].repoMeta.language, "JavaScript");
assert.equal(chromeStorageMock.projects["fake/repo"].repoMeta.stars, 7);
console.log(`  ok  - pd-last-checked: "${elements["pd-last-checked"].textContent}"`);
console.log(`  ok  - pd-last-commit: "${elements["pd-last-commit"].textContent}"`);
console.log("  ok  - repoMeta snapshot stored alongside the commit check");

console.log("\nConfirming the count badge ticked up to 1 tracked repo...");
assert.equal(elements["projects-count"].textContent, "1", "projects-count must reflect the newly tracked repo");
console.log("  ok  - projects-count badge reads 1 after the first repo is tracked");

console.log("\n--- REGRESSION: back/cancel button on the detail card ---");
console.log("Detail card should be open (visible) right after creating a project...");
assert.equal(elements["project-detail"].hidden, false, "the detail card must be open after a project is created and auto-opened");
console.log("  ok  - detail card is open");

console.log("Clicking the new #pd-close-btn 'back to list' button...");
await elements["pd-close-btn"].dispatch("click");
assert.equal(elements["project-detail"].hidden, true, "REGRESSION: clicking pd-close-btn must hide the detail card, returning to the list");
console.log("  ok  - REGRESSION: pd-close-btn correctly closes the detail card back to the list");

console.log("Re-opening the project via a list row click, to continue exercising the rest of the flow...");
// The 'Fake Project' row is the only row rendered so far — its click
// handler (registered in renderList) re-opens the same detail view. This
// mirrors how a real user would get back into a project after using the
// new close button.
assert.equal(createdRows.length >= 1, true, "at least one row must have been created by renderList()");
await createdRows[0].dispatch("click", { target: { closest: () => null } });
// The row's click handler calls openProject(p.id) without awaiting it
// (fire-and-forget, same as production) — flush that microtask before
// checking the resulting DOM state.
await new Promise((r) => setTimeout(r, 0));
assert.equal(elements["project-detail"].hidden, false, "clicking a list row must re-open the detail card");
console.log("  ok  - a list row click re-opens the detail card after it was closed");

console.log("\nClicking 'Check for Updates' again with the SAME upstream commit (no-op expected)...");
commitCallCount = 0;
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(commitCallCount, 1, "a manual check must still make exactly one GitHub commits call");
assert.equal(
  chromeStorageMock.projects["fake/repo"].commitHistory.length,
  1,
  "an unchanged commit must not add a duplicate history entry"
);
console.log("  ok  - unchanged commit: lastChecked updates, history stays deduped at 1 entry");

console.log("\nClicking 'Check for Updates' with a NEW upstream commit...");
mockSha = "sha-changed";
mockDate = "2026-07-20T00:00:00Z";
await elements["pd-refresh-btn"].dispatch("click");
assert.equal(
  chromeStorageMock.projects["fake/repo"].commitHistory.length,
  2,
  "a real new commit must append a second history entry"
);
assert.equal(chromeStorageMock.projects["fake/repo"].commitHistory[0].sha, "sha-changed", "newest commit must be first");
assert.ok(elements["pd-history"].innerHTML.includes("sha-cha"), "the rendered history should reflect the new commit");
console.log("  ok  - new commit correctly appended, newest-first");

console.log("\n--- Pinning ---");
console.log("Pinning the active project via the detail-view pin button...");
await elements["pd-pin-btn"].dispatch("click");
assert.equal(chromeStorageMock.projects["fake/repo"].pinned, true, "pin button click must persist pinned=true");
console.log("  ok  - project pinned, persisted to storage");

console.log("\n=== REGRESSION: lastCheckedAt must stamp even when the check fails ===");
console.log("Adding a SECOND project whose auto-check will fail (simulated rate limit / network error)...");
commitsShouldFail = true;
elements["new-project-name"].value = "Zzz Second Project";
elements["new-project-repo"].value = "fake/repo2";
await elements["new-project-btn"].dispatch("click");
commitsShouldFail = false;

assert.equal(
  chromeStorageMock.projects["fake/repo2"] !== undefined,
  true,
  "the project must still be created even though its first auto-check failed"
);
assert.equal(
  chromeStorageMock.projects["fake/repo2"].commitHistory.length,
  0,
  "a failed auto-check must leave commitHistory empty, not crash the add flow"
);
assert.ok(
  chromeStorageMock.projects["fake/repo2"].lastCheckedAt,
  "REGRESSION CHECK: lastCheckedAt must be stamped even though the check failed — the UI must never silently keep showing stale/blank staleness info for a repo that's actually been failing"
);
assert.ok(
  elements["pd-status"].textContent.includes("first check failed"),
  "the failure must be surfaced inline in the UI, not swallowed silently"
);
console.log("  ok  - a failed first-check doesn't block project creation");
console.log("  ok  - REGRESSION: lastCheckedAt is stamped even though the check failed, commitHistory stays empty");
console.log("  ok  - failure is surfaced in the status line");

console.log("\nConfirming the count badge now reads 2 tracked repos...");
assert.equal(elements["projects-count"].textContent, "2", "projects-count must reflect both tracked repos");
console.log("  ok  - projects-count badge reads 2 after the second repo is tracked");

console.log("\n--- Multi-project list scenario (sort check) ---");
const listRows = elements["project-list"]._children;
assert.equal(listRows.length, 2, "both tracked projects should render as rows");
console.log(`  ok  - project-list rendered ${listRows.length} rows`);

assert.ok(listRows[0].innerHTML.includes("Fake Project"), `expected the pinned project first, row 0 was: ${listRows[0].innerHTML.slice(0, 160)}`);
assert.ok(listRows[1].innerHTML.includes("Zzz Second Project"), "the unpinned never-checked project should sort after the pinned one");
assert.ok(listRows[1].innerHTML.includes("badge-pending"), "a never-checked project's row must carry the not-checked badge, based on lastCommitAt not lastCheckedAt");
console.log("  ok  - pinned project sorts first regardless of name or recency");
console.log("  ok  - unpinned never-checked project (by commit, despite having a lastCheckedAt) still shows the not-checked badge");

console.log("\n--- REGRESSION: removing a repo while its detail card is open must also close the card ---");
// The currently active/open project at this point is "Zzz Second Project"
// — it was auto-opened by the new-project handler right after it was
// created (openProject(id) runs immediately after store.create), and
// nothing since (the two refresh clicks and the pin click all targeted the
// then-active project, but creating Zzz Second Project re-pointed
// activeProjectId at it). Deleting THAT project via its list row's delete
// button must close the detail card too, not leave it open pointing at a
// project that no longer exists.
assert.ok(
  elements["pd-status"].textContent.includes("first check failed"),
  "sanity check: the detail card must still be showing Zzz Second Project (its status line) before this delete"
);
assert.equal(elements["project-detail"].hidden, false, "sanity check: detail card should still be open before delete");
const freshRows = elements["project-list"]._children;
const zzzRow = freshRows.find((r) => r.innerHTML.includes("Zzz Second Project"));
assert.ok(zzzRow, "the Zzz Second Project row must exist to test delete-while-open");
const deleteStub = zzzRow._stubChildren[".p-delete"];
await deleteStub.dispatch("click", { stopPropagation: () => {} });
// The delete handler awaits store.remove() and closeProjectDetail(), but
// calls renderList() at the end without awaiting it (same as production)
// — flush that microtask before checking anything renderList() sets.
await new Promise((r) => setTimeout(r, 0));
assert.equal(
  chromeStorageMock.projects["fake/repo2"],
  undefined,
  "the project must be removed from storage"
);
assert.equal(
  elements["project-detail"].hidden,
  true,
  "REGRESSION: deleting the currently-open project must close its detail card, not leave it open pointing at a removed project"
);
console.log("  ok  - REGRESSION: deleting the open project closes its detail card");

console.log("\nConfirming the count badge dropped back to 1 after the delete...");
assert.equal(elements["projects-count"].textContent, "1", "projects-count must reflect the removal");
console.log("  ok  - projects-count badge reads 1 after deleting the open project");

console.log("\nAll projectsView integration checks passed.");

