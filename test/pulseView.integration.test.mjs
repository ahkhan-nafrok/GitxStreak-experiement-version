// test/pulseView.integration.test.mjs
// The REAL pulseView.js against a strict fake DOM/chrome (test/helpers/
// fakeDom.mjs), real vault + connection.js over a fake IndexedDB, and a mocked
// GitHub (GraphQL + /user/repos).
//
// The clock is pinned and the process timezone is set to Pacific/Honolulu
// (UTC-10) for the whole file: at the pinned instant the LOCAL date is a day
// behind the UTC date, which is exactly the case the old local-time
// todayDateKey()/getMonth() got wrong.
//
// Run with: node test/pulseView.integration.test.mjs
process.env.TZ = "Pacific/Honolulu";

import assert from "node:assert/strict";
import { mock } from "node:test";
import { setup, waitFor, settle, jsonResponse } from "./helpers/fakeDom.mjs";

if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;

const { initPulseView } = await import("../pulseView.js");
const { initToast } = await import("../toast.js");
const { chromeStorageAdapter: adapter } = await import("../lib/storageAdapter.js");
const { saveConnection, disconnect } = await import("../lib/connection.js");
const { getConnectionId, getAuthFailed, setAuthFailed } = await import("../lib/authState.js");
const { PULSE_CACHE_KEY } = await import("../lib/accountData.js");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}

// 2026-07-15 05:00 UTC  ==  2026-07-14 19:00 in Honolulu.
const NOW = Date.parse("2026-07-15T05:00:00Z");
let clockOk = true;
try { mock.timers.enable({ apis: ["Date"], now: NOW }); } catch { clockOk = false; console.log("  SKIP  - this Node build can't mock Date; the UTC-key test is skipped"); }

const originalFetch = globalThis.fetch;
const GRAPHQL = "https://api.github.com/graphql";

/** A GraphQL response whose last two weeks are known: 07-13 and 07-14 contributed, 07-15 (today, UTC) has 0. */
function graphqlBody() {
  const day = (date, contributionCount) => ({ date, contributionCount });
  return {
    data: { viewer: { contributionsCollection: { contributionCalendar: { weeks: [
      { contributionDays: [day("2026-06-28", 0), day("2026-06-29", 0), day("2026-06-30", 1), day("2026-07-01", 2), day("2026-07-02", 0), day("2026-07-03", 0), day("2026-07-04", 0)] },
      { contributionDays: [day("2026-07-05", 0), day("2026-07-06", 0), day("2026-07-07", 0), day("2026-07-08", 0), day("2026-07-09", 0), day("2026-07-10", 0), day("2026-07-11", 0)] },
      { contributionDays: [day("2026-07-12", 0), day("2026-07-13", 3), day("2026-07-14", 4), day("2026-07-15", 0)] },
    ] } } } },
  };
}
const repo = (n, pushed) => ({ full_name: `me/${n}`, private: false, pushed_at: pushed, html_url: `https://github.com/me/${n}` });

/** Routes GraphQL + /user/repos; each can be overridden per test. */
function mockGitHub({ graphql, repos } = {}) {
  const calls = { graphql: 0, repos: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === GRAPHQL) { calls.graphql++; return graphql ? graphql(calls.graphql) : jsonResponse(graphqlBody()); }
    if (u.includes("/user/repos")) { calls.repos++; return repos ? repos(calls.repos) : jsonResponse([repo("alpha", "2026-07-14T10:00:00Z"), repo("beta", "2026-07-13T10:00:00Z")]); }
    throw new Error(`Unhandled mock URL: ${u}`);
  };
  return calls;
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function boot({ connected = true, scopes = ["read:user"], seedCache, init = true } = {}) {
  const w = setup();
  initToast();
  w.watch("gitstreak:auth-changed");
  if (connected) await saveConnection(adapter, "ghp_abcdefgh12345678", { scopes });
  if (seedCache) await adapter.set({ [PULSE_CACHE_KEY]: { connectionId: await getConnectionId(adapter), ...seedCache } });
  if (init) initPulseView();
  return w;
}
const rendered = (w) => !w.el("pulse-calendar-wrap").hidden;
const cacheOnDisk = (w) => w.store[PULSE_CACHE_KEY];

const STALE_SEED = { asOfDateKey: "2026-07-01", dayMap: { "2026-07-14": { count: 1 } }, grid: [[{ date: "2026-07-14", contributed: true }, null, null, null, null, null, null]], lastPushedRepos: [{ fullName: "me/cached-repo", isPrivate: false, pushedAt: "2026-07-01T00:00:00Z" }], fetchedAt: "2026-07-01T00:00:00Z" };

// ---------------------------------------------------------------- empty state

await test("no connection: Connect CTA shown, nothing rendered, no network call", async () => {
  const calls = mockGitHub();
  const w = await boot({ connected: false });
  await waitFor(() => !w.el("pulse-token-prompt").hidden, "empty state");
  assert.equal(rendered(w), false);
  assert.equal(w.el("pulse-stats-row").hidden, true);
  assert.equal(w.el("pulse-refresh-btn").disabled, false);
  assert.equal(calls.graphql + calls.repos, 0);
});

await test("the Connect CTA asks to open Settings", async () => {
  mockGitHub();
  const w = await boot({ connected: false });
  w.watch("gitstreak:open-settings");
  await waitFor(() => !w.el("pulse-token-prompt").hidden, "empty state");
  await w.el("pulse-token-cta").dispatch("click");
  assert.ok(w.events.includes("gitstreak:open-settings"));
});

// ---------------------------------------------------------------- first fetch

await test("first load: fetches, renders calendar/streak/year/last-pushed, and STAMPS the cache with the connection id", async () => {
  mockGitHub();
  const w = await boot();
  await waitFor(() => rendered(w) && w.el("pulse-streak").textContent !== "—" && cacheOnDisk(w), "first render + cache write");
  assert.equal(cacheOnDisk(w).connectionId, await getConnectionId(adapter), "cache must be stamped (this was the missing wiring)");
  assert.equal(w.el("pulse-streak").textContent, "2 days", "07-13 + 07-14; today (07-15 UTC) has 0 so it is pending, not broken");
  assert.match(w.el("pulse-streak-note").textContent, /isn't logged yet/);
  assert.equal(w.el("pulse-year-total").textContent, "10");
  assert.match(w.el("plp-list").innerHTML, /me\/alpha/);
  assert.equal(w.el("pulse-last-pushed").hidden, false);
  assert.equal(w.el("pulse-update-btn-label").textContent, "Updated");
  assert.equal(await getAuthFailed(adapter), false);
});

if (clockOk) {
  await test("today's ember ring and month labels use UTC: with local=Honolulu the local date is a day BEHIND, and the ring still lands on 07-15", async () => {
    mockGitHub();
    const w = await boot();
    await waitFor(() => rendered(w) && w.el("pulse-calendar-grid").innerHTML.includes("gh-cal-cell"), "grid");
    const html = w.el("pulse-calendar-grid").innerHTML;
    const todayCells = [...html.matchAll(/class="([^"]*is-today[^"]*)" title="([^"]+)"/g)];
    assert.equal(todayCells.length, 1, "exactly one ringed cell");
    assert.equal(todayCells[0][2], "2026-07-15", "UTC today — the old local-time key would have picked 2026-07-14");

    // Week 1 starts 2026-06-28 (JUN), week 3 starts 2026-07-05... month label changes at 07-05's column? Labels follow the FIRST dated cell of each week.
    // Honolulu local-time parsing would shift 2026-07-01-style dates back a day and mislabel boundaries; check the first label is JUN, then JUL.
    const labels = [...w.el("pulse-calendar-months").innerHTML.matchAll(/gh-cal-month-label">([A-Z]*)</g)].map((m) => m[1]);
    assert.deepEqual(labels, ["JUN", "JUL", ""], "JUN then JUL, from UTC dates");
  });
}

// ---------------------------------------------------------------- cache trust

await test("a fresh, matching cache renders and is NOT refetched", async () => {
  const calls = mockGitHub();
  const w = await boot({ seedCache: { ...STALE_SEED, asOfDateKey: "2026-07-15" } });
  await waitFor(() => rendered(w), "cache render");
  await settle();
  assert.equal(calls.graphql, 0);
  assert.match(w.el("plp-list").innerHTML, /cached-repo/);
});

await test("another connection's cache is NEVER shown: ignored, cleared from the DOM, and refetched", async () => {
  const calls = mockGitHub();
  const w = await boot({ init: false });
  await adapter.set({ [PULSE_CACHE_KEY]: { connectionId: "SOMEONE-ELSES-CONNECTION", ...STALE_SEED, asOfDateKey: "2026-07-15", lastPushedRepos: [{ fullName: "other-account/secret-repo", isPrivate: true, pushedAt: "2026-07-14T00:00:00Z" }] } });
  initPulseView();
  await waitFor(() => calls.graphql === 1, "refetch");
  await waitFor(() => cacheOnDisk(w).connectionId !== "SOMEONE-ELSES-CONNECTION", "cache replaced");
  assert.equal(calls.graphql, 1, "a same-day cache from a different connection must still trigger a fetch");
  assert.ok(!w.el("plp-list").innerHTML.includes("secret-repo"), "the other account's repo must not be rendered");
  assert.ok(!JSON.stringify(w.store).includes("secret-repo"), "...and is overwritten on disk");
});

await test("a legacy cache with no connection stamp is treated as absent (one refetch), not trusted", async () => {
  const calls = mockGitHub();
  const w = await boot({ init: false });
  await adapter.set({ [PULSE_CACHE_KEY]: { ...STALE_SEED, asOfDateKey: "2026-07-15" } }); // no connectionId
  initPulseView();
  await waitFor(() => calls.graphql === 1 && cacheOnDisk(w).connectionId, "refetch + stamp");
  assert.equal(cacheOnDisk(w).connectionId, await getConnectionId(adapter));
});

await test("an install that connected before connection ids existed gets one minted on first load", async () => {
  mockGitHub();
  const w = await boot({ init: false });
  delete w.store.ghConnectionId; // legacy install: token present, no id
  initPulseView();
  await waitFor(() => cacheOnDisk(w)?.connectionId, "stamped cache");
  assert.ok(await getConnectionId(adapter));
});

// ---------------------------------------------------------------- failure behaviour

await test("INVARIANT 5: a failed refresh never blanks the UI — cached data stays, error is shown", async () => {
  mockGitHub({ graphql: () => { throw new TypeError("fetch failed"); } });
  const w = await boot({ seedCache: STALE_SEED });
  await waitFor(() => w.el("pulse-status").textContent !== "", "error status");
  assert.equal(rendered(w), true);
  assert.match(w.el("plp-list").innerHTML, /cached-repo/);
  assert.equal(w.el("pulse-refresh-btn").disabled, false, "button must not be stuck on Updating...");
  assert.deepEqual(cacheOnDisk(w).lastPushedRepos.map((r) => r.fullName), ["me/cached-repo"], "cache untouched");
});

await test("401 on a silent load: flagged failed + badge event, cache stays on screen, NO toast", async () => {
  mockGitHub({ graphql: () => jsonResponse({}, { status: 401, statusText: "Unauthorized" }) });
  const w = await boot({ seedCache: STALE_SEED });
  await waitFor(() => w.events.includes("gitstreak:auth-changed"), "auth-changed");
  assert.equal(await getAuthFailed(adapter), true);
  assert.equal(rendered(w), true);
  assert.equal(w.el("app-toast").hidden, true, "silent refreshes must not toast");
});

await test("401 on an explicit Update click: same, PLUS the toast pointing at Settings", async () => {
  let n = 0;
  mockGitHub({ graphql: () => (++n === 1 ? jsonResponse(graphqlBody()) : jsonResponse({}, { status: 401 })) });
  const w = await boot();
  await waitFor(() => rendered(w) && cacheOnDisk(w), "first render");
  await waitFor(() => !w.el("pulse-refresh-btn").disabled, "button idle");
  await w.el("pulse-refresh-btn").dispatch("click");
  await waitFor(() => !w.el("app-toast").hidden, "toast");
  assert.match(w.el("app-toast-msg").textContent, /stopped working/);
  assert.equal(await getAuthFailed(adapter), true);
  assert.equal(rendered(w), true, "calendar still on screen");
});

await test("a failing 'Last Pushed' call keeps the previous list instead of overwriting it with []", async () => {
  mockGitHub({ repos: () => jsonResponse({}, { status: 500, statusText: "Server Error" }) });
  const w = await boot({ seedCache: STALE_SEED });
  await waitFor(() => cacheOnDisk(w)?.dayMap?.["2026-07-14"]?.count === 4, "fresh calendar written");
  assert.deepEqual(cacheOnDisk(w).lastPushedRepos.map((r) => r.fullName), ["me/cached-repo"]);
  assert.match(w.el("plp-list").innerHTML, /cached-repo/);
});

await test("a cache written before lastPushedRepos existed is treated as stale and refetched", async () => {
  const calls = mockGitHub();
  const { lastPushedRepos, ...legacy } = STALE_SEED;
  const w = await boot({ seedCache: { ...legacy, asOfDateKey: "2026-07-15" } });
  await waitFor(() => calls.graphql === 1, "refetch");
  await waitFor(() => Array.isArray(cacheOnDisk(w).lastPushedRepos), "list written");
});

// ---------------------------------------------------------------- races

await test("RACE: disconnect while a fetch is in flight -> the result is dropped and NOTHING from the old account lands on disk", async () => {
  const gate = deferred();
  mockGitHub({ graphql: () => gate.promise });
  const w = await boot();
  await waitFor(() => w.el("pulse-refresh-btn").disabled, "fetch in flight");
  await disconnect(adapter);
  w.emit("gitstreak:disconnected");
  gate.resolve(jsonResponse(graphqlBody()));
  await settle(80);
  assert.equal(cacheOnDisk(w), null, "no cache may be written for a connection that no longer exists");
  assert.equal(rendered(w), false);
  assert.equal(w.el("pulse-token-prompt").hidden, false);
  assert.equal(w.el("pulse-refresh-btn").disabled, false);
});

await test("RACE: reconnect while a fetch is in flight -> the old connection's late 401 does NOT flag the NEW token as failed", async () => {
  const gate = deferred();
  mockGitHub({ graphql: () => gate.promise });
  const w = await boot();
  await waitFor(() => w.el("pulse-refresh-btn").disabled, "fetch in flight");
  await saveConnection(adapter, "ghp_newaccounttoken0000", { scopes: ["read:user"] }); // new connection id
  gate.resolve(jsonResponse({}, { status: 401, statusText: "Unauthorized" }));
  await settle(80);
  assert.equal(await getAuthFailed(adapter), false, "a stale 401 must not poison the healthy new connection");
  assert.equal(w.el("app-toast").hidden, true);
});

await test("RACE: reconnect while a fetch is in flight -> the old account's data is never rendered or cached under the new connection", async () => {
  const gate = deferred();
  let n = 0;
  mockGitHub({ graphql: () => (++n === 1 ? gate.promise : jsonResponse(graphqlBody())), repos: () => jsonResponse([repo("old-account-repo", "2026-07-14T00:00:00Z")]) });
  const w = await boot();
  await waitFor(() => w.el("pulse-refresh-btn").disabled, "fetch in flight");
  await saveConnection(adapter, "ghp_newaccounttoken0000", { scopes: ["read:user"] });
  w.emit("gitstreak:token-saved");
  gate.resolve(jsonResponse(graphqlBody()));
  await waitFor(() => cacheOnDisk(w)?.connectionId === w.store.ghConnectionId, "cache stamped with the NEW connection");
  assert.equal(cacheOnDisk(w).connectionId, await getConnectionId(adapter));
});

await test("two overlapping loads: the newer wins and the button isn't left stuck on 'Updating...'", async () => {
  const first = deferred();
  let n = 0;
  mockGitHub({ graphql: () => (++n === 1 ? first.promise : jsonResponse(graphqlBody())) });
  const w = await boot();
  await waitFor(() => w.el("pulse-refresh-btn").disabled, "first fetch in flight");
  w.emit("gitstreak:token-saved"); // a newer load supersedes the first
  await waitFor(() => rendered(w) && cacheOnDisk(w), "newer load rendered");
  first.resolve(jsonResponse(graphqlBody()));
  await settle(60);
  await waitFor(() => !w.el("pulse-refresh-btn").disabled, "button idle");
});

// ---------------------------------------------------------------- events

await test("token-saved reloads for the new connection; disconnected clears everything rendered", async () => {
  mockGitHub();
  const w = await boot();
  await waitFor(() => rendered(w) && cacheOnDisk(w), "first render");

  await disconnect(adapter);
  w.emit("gitstreak:disconnected");
  await waitFor(() => !w.el("pulse-token-prompt").hidden, "empty state after disconnect");
  assert.equal(rendered(w), false);
  assert.equal(w.el("plp-list").innerHTML, "", "old account's repos removed from the DOM, not just hidden");
  assert.equal(w.el("pulse-calendar-grid").innerHTML, "");

  await saveConnection(adapter, "ghp_secondaccount111111", { scopes: ["read:user"] });
  w.emit("gitstreak:token-saved");
  await waitFor(() => rendered(w) && cacheOnDisk(w)?.connectionId === w.store.ghConnectionId, "reloaded for the new connection");
  assert.equal(w.el("pulse-token-prompt").hidden, true);
});

await test("INVARIANT 12: a full load dispatches auth-changed at most once, and Pulse never reacts to it (no loop)", async () => {
  mockGitHub();
  const w = await boot();
  await waitFor(() => rendered(w) && cacheOnDisk(w), "first render");
  await settle(80);
  const count = w.events.filter((e) => e === "gitstreak:auth-changed").length;
  assert.equal(count, 1);
  w.emit("gitstreak:auth-changed"); // some other view announcing a change
  await settle(80);
  assert.equal(w.events.filter((e) => e === "gitstreak:auth-changed").length, 2, "only our own emit — Pulse must not respond by dispatching more");
});

await test("an explicit Update click gives immediate feedback and double-clicks make one request, not two", async () => {
  const gate = deferred();
  let n = 0;
  const calls = mockGitHub({ graphql: () => (++n === 1 ? jsonResponse(graphqlBody()) : gate.promise) });
  const w = await boot();
  await waitFor(() => rendered(w) && cacheOnDisk(w), "first render");
  await waitFor(() => !w.el("pulse-refresh-btn").disabled, "idle");
  const before = calls.graphql;
  // Both handlers run synchronously (a very fast double-click). The fake
  // dispatch awaits the handler, so don't await before releasing the gate.
  const c1 = w.el("pulse-refresh-btn").dispatch("click");
  const c2 = w.el("pulse-refresh-btn").dispatch("click");
  assert.equal(w.el("pulse-refresh-btn").disabled, true, "disabled synchronously, before the vault is even read");
  gate.resolve(jsonResponse(graphqlBody()));
  await Promise.all([c1, c2]);
  await settle(60);
  assert.equal(calls.graphql - before, 1, "the second click supersedes the first before it reaches the network");
});

mock.timers.reset();
globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
