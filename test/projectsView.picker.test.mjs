// test/projectsView.picker.test.mjs
// The REAL projectsView.js on the strict fake popup (test/helpers/fakeDom.mjs)
// with the real vault/connection/store: repo-keyed identity, the duplicate
// guard as the user meets it, the "Add from GitHub" picker (scope note, stale
// results, 401 handling), and what Projects does when GitHub is disconnected.
// Run with: node test/projectsView.picker.test.mjs
import assert from "node:assert/strict";
import { setup, waitFor, settle, jsonResponse } from "./helpers/fakeDom.mjs";

if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;

const { initProjectsView } = await import("../projectsView.js");
const { initToast } = await import("../toast.js");
const { chromeStorageAdapter: adapter } = await import("../lib/storageAdapter.js");
const { saveConnection, disconnect } = await import("../lib/connection.js");
const { getAuthFailed } = await import("../lib/authState.js");
const { createProjectStore } = await import("../lib/projectStore.js");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}

const originalFetch = globalThis.fetch;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const apiRepo = (name, priv = false) => ({ full_name: `me/${name}`, name, private: priv, description: `${name} desc`, language: "JS", stargazers_count: 3, pushed_at: "2026-07-01T00:00:00Z", html_url: `https://github.com/me/${name}` });

/** Mocks commits, repo-meta and /user/repos. `repos` may return a Response or a promise of one. */
function mockGitHub({ repos } = {}) {
  const calls = { commits: 0, meta: 0, repos: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/commits?per_page=1")) { calls.commits++; return jsonResponse([{ sha: "abc1234567", commit: { committer: { date: "2026-07-01T00:00:00Z" } } }]); }
    if (u.includes("/user/repos")) { calls.repos++; return repos ? repos(calls.repos) : jsonResponse([apiRepo("alpha"), apiRepo("beta", true)]); }
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) { calls.meta++; return jsonResponse({ description: "d", language: "JS", stargazers_count: 1, private: false, pushed_at: "2026-07-01T00:00:00Z" }); }
    throw new Error(`Unhandled mock URL: ${u}`);
  };
  return calls;
}

async function boot({ connected = true, scopes = ["read:user"] } = {}) {
  const w = setup();
  initToast();
  w.watch("gitstreak:auth-changed");
  if (connected) await saveConnection(adapter, "ghp_abcdefgh12345678", { scopes });
  initProjectsView();
  await waitFor(() => w.el("projects-count").textContent !== "", "first render");
  return w;
}
const store = () => createProjectStore(adapter);
const ids = async () => (await store().list()).map((p) => p.id).sort();
const pickerRows = (w) => w.el("gp-list")._children;
const addByForm = async (w, name, repo) => {
  w.el("new-project-name").value = name;
  w.el("new-project-repo").value = repo;
  await w.el("new-project-btn").dispatch("click");
};
/** alert() must be observed, not thrown, for the duplicate-guard tests. */
const alerts = (w) => w.dialogs.alerts;

// ---------------------------------------------------------------- identity

await test("a project's id is its lowercase owner/repo, whatever the casing or URL style typed", async () => {
  mockGitHub();
  const w = await boot({ connected: false });
  await addByForm(w, "My Thing", "https://github.com/Octo/Hello.git");
  assert.deepEqual(await ids(), ["octo/hello"]);
  assert.equal((await store().get("octo/hello")).name, "My Thing", "the display name is kept as typed");
});

await test("the same repo can't be added twice — different name, casing and URL style are all caught, with a readable message", async () => {
  mockGitHub();
  const w = await boot({ connected: false });
  await addByForm(w, "First", "octo/hello");
  await addByForm(w, "Totally Different Name", "OCTO/Hello");
  await addByForm(w, "Third", "https://github.com/octo/hello/");
  assert.deepEqual(await ids(), ["octo/hello"], "still exactly one");
  assert.equal(alerts(w).length, 2);
  assert.match(alerts(w)[0], /already tracking/i);
});

await test("two different repos with the same display name no longer collide (the old slug-id bug)", async () => {
  mockGitHub();
  const w = await boot({ connected: false });
  await addByForm(w, "Website", "me/site-a");
  await addByForm(w, "Website", "me/site-b");
  assert.deepEqual(await ids(), ["me/site-a", "me/site-b"]);
  assert.equal(alerts(w).length, 0);
});

await test("unparseable input is rejected with the readable parse error and nothing is stored", async () => {
  mockGitHub();
  const w = await boot({ connected: false });
  await addByForm(w, "Bad", "not a repo");
  assert.deepEqual(await ids(), []);
  assert.match(alerts(w)[0], /Couldn't parse that as a repo/);
});

// ---------------------------------------------------------------- picker basics

await test("picker: no token -> toast to Settings, picker stays closed, no request", async () => {
  const calls = mockGitHub();
  const w = await boot({ connected: false });
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => !w.el("app-toast").hidden, "toast");
  assert.equal(w.el("github-picker").hidden, true);
  assert.equal(calls.repos, 0);
});

await test("picker: lists repos; clicking one adds it under its owner/repo id, saves the picker's metadata, and checks it", async () => {
  const calls = mockGitHub();
  const w = await boot();
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(w).length === 2, "two picker rows");
  assert.equal(w.el("github-picker").hidden, false);
  assert.match(pickerRows(w)[0].innerHTML, /me\/alpha/);

  await pickerRows(w)[0].dispatch("click");
  await waitFor(() => calls.commits === 1, "first check after add");
  assert.deepEqual(await ids(), ["me/alpha"]);
  const p = await store().get("me/alpha");
  assert.equal(p.repoMeta.language, "JS");
  assert.equal(p.commitHistory.length, 1);
  assert.equal(w.el("projects-count").textContent, "1");
});

await test("picker: an already-tracked repo (added by URL in any style) is shown as Tracked and is not clickable", async () => {
  mockGitHub();
  const w = await boot();
  await addByForm(w, "Mine", "https://github.com/ME/Alpha");
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(w).length === 2, "rows");
  const alpha = pickerRows(w).find((r) => r.innerHTML.includes("me/alpha"));
  assert.match(alpha.innerHTML, /Tracked/);
  assert.equal(alpha.classList.contains("is-tracked"), true);
  const before = (await store().list()).length;
  await alpha.dispatch("click");
  await settle();
  assert.equal((await store().list()).length, before);
});

// ---------------------------------------------------------------- scope note

await test("scope note: public-only token says the list is public only; private-capable and unknown-scope tokens say nothing", async () => {
  mockGitHub();
  const pub = await boot({ scopes: ["read:user"] });
  await pub.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(pub).length === 2, "rows");
  assert.equal(pub.el("gp-scope-note").hidden, false);

  const priv = await boot({ scopes: ["repo", "read:user"] });
  await priv.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(priv).length === 2, "rows");
  assert.equal(priv.el("gp-scope-note").hidden, true);

  const unknown = await boot({ scopes: null });
  await unknown.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(unknown).length === 2, "rows");
  assert.equal(unknown.el("gp-scope-note").hidden, true, "unknown scopes must not claim anything");
});

// ---------------------------------------------------------------- failures & races

await test("picker 401: closes the picker, flags the token failed, raises auth-changed and the Settings toast", async () => {
  mockGitHub({ repos: () => jsonResponse({}, { status: 401, statusText: "Unauthorized" }) });
  const w = await boot();
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => w.events.includes("gitstreak:auth-changed"), "auth-changed");
  assert.equal(await getAuthFailed(adapter), true);
  assert.equal(w.el("github-picker").hidden, true);
  assert.match(w.el("app-toast-msg").textContent, /rejected your token/);
});

await test("picker: a non-auth failure shows the message inside the picker and leaves it open for retry", async () => {
  mockGitHub({ repos: () => jsonResponse({}, { status: 500, statusText: "Server Error" }) });
  const w = await boot();
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => !w.el("gp-status").hidden && w.el("gp-status").textContent !== "Loading your repos...", "error text");
  assert.equal(w.el("github-picker").hidden, false);
  assert.equal(w.el("gp-load-more-btn").disabled, false);
});

await test("RACE: disconnect while the picker is loading -> picker closes and the late result NEVER repopulates it", async () => {
  const gate = deferred();
  mockGitHub({ repos: () => gate.promise });
  const w = await boot({ scopes: ["repo", "read:user"] });
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => w.el("gp-status").textContent === "Loading your repos...", "loading");
  await disconnect(adapter);
  w.emit("gitstreak:disconnected");
  await waitFor(() => w.el("github-picker").hidden, "picker closed");
  gate.resolve(jsonResponse([apiRepo("secret-private", true)]));
  await settle(80);
  assert.equal(pickerRows(w).length, 0);
  assert.ok(!w.el("gp-list").innerHTML.includes("secret-private"), "the old account's private repo must not appear");
  assert.equal(w.el("github-picker").hidden, true);
});

await test("a closed picker can be reopened and works (the stale-load guard doesn't leave it locked)", async () => {
  mockGitHub();
  const w = await boot();
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(w).length === 2, "rows");
  await w.el("gp-close-btn").dispatch("click");
  assert.equal(w.el("github-picker").hidden, true);
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(w).length === 2, "rows after reopen");
});

await test("picker add: a 401 on the follow-up check raises the same auth-failure UX instead of only logging", async () => {
  const calls = mockGitHub();
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => (String(url).includes("/commits?per_page=1") ? jsonResponse({}, { status: 401, statusText: "Unauthorized" }) : real(url, o));
  const w = await boot();
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => pickerRows(w).length === 2, "rows");
  await pickerRows(w)[0].dispatch("click");
  await waitFor(() => w.events.includes("gitstreak:auth-changed"), "auth-changed");
  assert.deepEqual(await ids(), ["me/alpha"], "the repo is still added; only the check failed");
});

// ---------------------------------------------------------------- disconnect

await test("disconnect: private tracked repos vanish from the list, public stay, and an open card for a removed repo closes", async () => {
  mockGitHub();
  const w = await boot({ scopes: ["repo", "read:user"] });
  const s = store();
  await s.create("me/priv", "Priv", "me/priv");
  await s.create("me/pub", "Pub", "me/pub");
  await s.updateRepoMeta("me/priv", { private: true });
  await s.updateRepoMeta("me/pub", { private: false });
  w.emit("gitstreak:disconnected"); // force a render that includes both, pre-disconnect
  await waitFor(() => w.el("projects-count").textContent === "2", "both listed");

  const privRow = w.el("project-list")._children.find((r) => r.innerHTML.includes("Priv"));
  await privRow.dispatch("click");
  await waitFor(() => !w.el("project-detail").hidden && w.el("pd-name").textContent === "Priv", "card open on the private repo");

  await disconnect(adapter);
  w.emit("gitstreak:disconnected");
  await waitFor(() => w.el("projects-count").textContent === "1", "list re-rendered");
  assert.equal(w.el("project-detail").hidden, true, "the card for a removed repo must close");
  assert.ok(!w.el("project-list")._children.some((r) => r.innerHTML.includes("Priv")));
  assert.ok(w.el("project-list")._children.some((r) => r.innerHTML.includes("Pub")));
});

await test("disconnect: a card open on a repo that SURVIVES stays open", async () => {
  mockGitHub();
  const w = await boot();
  await store().create("me/pub", "Pub", "me/pub");
  w.emit("gitstreak:disconnected");
  await waitFor(() => w.el("projects-count").textContent === "1", "listed");
  await w.el("project-list")._children[0].dispatch("click");
  await waitFor(() => !w.el("project-detail").hidden, "card open");
  await disconnect(adapter);
  w.emit("gitstreak:disconnected");
  await settle(60);
  assert.equal(w.el("project-detail").hidden, false);
});

await test("INVARIANT 12: Projects raises auth-changed on a 401 but never reacts to it (no loop)", async () => {
  mockGitHub({ repos: () => jsonResponse({}, { status: 401, statusText: "Unauthorized" }) });
  const w = await boot();
  await w.el("github-import-btn").dispatch("click");
  await waitFor(() => w.events.includes("gitstreak:auth-changed"), "auth-changed");
  await settle(80);
  assert.equal(w.events.filter((e) => e === "gitstreak:auth-changed").length, 1);
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
