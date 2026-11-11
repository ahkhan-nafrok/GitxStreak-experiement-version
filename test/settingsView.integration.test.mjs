// test/settingsView.integration.test.mjs
// The REAL settingsView.js against a strict fake DOM/chrome (test/helpers/
// fakeDom.mjs), with the real vault, lib/connection.js and project store over
// a fake IndexedDB — so assertions are about what actually ends up on "disk",
// not about mocks.
// Run with: node test/settingsView.integration.test.mjs
import assert from "node:assert/strict";
import { setup, waitFor, settle, jsonResponse } from "./helpers/fakeDom.mjs";

if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) globalThis.crypto = (await import("node:crypto")).webcrypto;

const { initSettingsView } = await import("../settingsView.js");
const { chromeStorageAdapter: adapter } = await import("../lib/storageAdapter.js");
const { saveConnection } = await import("../lib/connection.js");
const { getToken } = await import("../lib/tokenVault.js");
const { getConnectionId, getGrantedScopes, getHasEverConnected, getAuthFailed, setAuthFailed } = await import("../lib/authState.js");
const { createProjectStore } = await import("../lib/projectStore.js");
const { PULSE_CACHE_KEY } = await import("../lib/accountData.js");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}

const STATUS = "gitstreak:device-flow-status";
const CODE_READY = { type: STATUS, status: "code_ready", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", interval: 5 };
const originalFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

/** Fresh world + the view, initialised and past its first render. */
async function boot({ connected = false, scopes = null, authFailed = false, responder } = {}) {
  const w = setup();
  if (responder) w.setResponder(responder);
  if (connected) {
    await saveConnection(adapter, "ghp_abcdefgh12345678", { scopes });
    if (authFailed) await setAuthFailed(adapter, true);
  }
  w.watch("gitstreak:auth-changed");
  w.watch("gitstreak:token-saved");
  w.watch("gitstreak:disconnected");
  initSettingsView();
  await waitFor(() => !w.el("settings-intro-banner").hidden || !w.el("settings-connected-row").hidden, "first render");
  return w;
}

/** Replace setInterval/clearInterval with recorders for the duration of fn. */
async function withTimerSpy(fn) {
  const timers = [], cleared = [];
  globalThis.setInterval = (cb, ms) => { const h = { cb, ms }; timers.push(h); return h; };
  globalThis.clearInterval = (h) => cleared.push(h);
  try { await fn({ timers, cleared }); }
  finally { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; }
}

// ---------------------------------------------------------------- first run

await test("first run: welcome banner, Connect GitHub visible, PAT fallback visible, nothing 'connected'", async () => {
  const w = await boot();
  assert.match(w.el("settings-intro-text").textContent, /Welcome to GITSTREAK/);
  assert.equal(w.el("settings-device-connect-btn").hidden, false);
  assert.equal(w.el("settings-device-connect-btn").textContent, "Connect GitHub");
  assert.equal(w.el("settings-token-entry").hidden, false);
  assert.equal(w.el("settings-private-row").hidden, false);
  assert.equal(w.el("settings-connected-row").hidden, true);
  assert.equal(w.el("settings-access-note").hidden, true);
  assert.equal(w.el("settings-save-btn").disabled, true);
});

// ---------------------------------------------------------------- scope tier opt-in

await test("the private-repos box starts TICKED, and Connect then requests the private tier with a strict boolean true, with no confirm shown", async () => {
  const w = await boot();
  assert.equal(w.el("settings-include-private").checked, true, "default must be ticked (taken from popup.html)");
  await w.el("settings-device-connect-btn").dispatch("click");
  const [msg] = w.sentOfType("gitstreak:start-device-flow");
  assert.strictEqual(msg.includePrivate, true);
  assert.equal(w.dialogs.confirms.length, 0, "the default path must never interrupt the user");
  assert.equal(w.el("settings-device-connect-btn").disabled, true);
  assert.equal(w.el("settings-device-connect-btn").textContent, "Connecting...");
  assert.equal(w.el("settings-include-private").disabled, true, "can't change the tier mid-request");
});

await test("unticking asks for confirmation that names what is lost (Last Pushed + tracking)", async () => {
  const w = await boot();
  w.el("settings-include-private").checked = false;
  await w.el("settings-include-private").dispatch("change");
  assert.equal(w.dialogs.confirms.length, 1);
  assert.match(w.dialogs.confirms[0], /Last Pushed/);
  assert.match(w.dialogs.confirms[0], /private repos can't be listed or tracked/);
});

await test("unticking and CONFIRMING: stays unticked, and Connect requests the public tier (includePrivate:false)", async () => {
  const w = await boot();
  w.dialogs.confirmAnswer = true;
  w.el("settings-include-private").checked = false;
  await w.el("settings-include-private").dispatch("change");
  assert.equal(w.el("settings-include-private").checked, false);
  await w.el("settings-device-connect-btn").dispatch("click");
  const [msg] = w.sentOfType("gitstreak:start-device-flow");
  assert.strictEqual(msg.includePrivate, false);
  assert.equal(w.dialogs.confirms.length, 1, "asked once at untick, not again at Connect");
});

await test("unticking and CANCELLING: the box snaps back to ticked and Connect still requests the private tier", async () => {
  const w = await boot();
  w.dialogs.confirmAnswer = false;
  w.el("settings-include-private").checked = false;
  await w.el("settings-include-private").dispatch("change");
  assert.equal(w.el("settings-include-private").checked, true);
  await w.el("settings-device-connect-btn").dispatch("click");
  assert.strictEqual(w.sentOfType("gitstreak:start-device-flow")[0].includePrivate, true);
});

await test("re-ticking the box never prompts", async () => {
  const w = await boot();
  w.dialogs.confirmAnswer = true;
  w.el("settings-include-private").checked = false;
  await w.el("settings-include-private").dispatch("change");
  const asked = w.dialogs.confirms.length;
  w.el("settings-include-private").checked = true;
  await w.el("settings-include-private").dispatch("change");
  assert.equal(w.dialogs.confirms.length, asked);
});

await test("the Reconnect path keeps the same default: ticked", async () => {
  const w = await boot({ connected: true, scopes: ["read:user"], authFailed: true });
  assert.equal(w.el("settings-include-private").checked, true);
});

// ---------------------------------------------------------------- device flow UI

await test("code_ready: shows the code + github link, locks controls, and nudges the worker every interval+1s", async () => {
  await withTimerSpy(async ({ timers }) => {
    const w = await boot();
    w.broadcast(CODE_READY);
    await waitFor(() => !w.el("settings-device-code").hidden, "code to show");
    assert.equal(w.el("settings-device-code").querySelector(".device-code-value").textContent, "ABCD-1234");
    assert.equal(w.el("settings-device-link").href, "https://github.com/login/device");
    assert.equal(w.el("settings-device-link").textContent, "github.com/login/device");
    assert.equal(w.el("settings-device-cancel-btn").hidden, false);
    assert.equal(w.el("settings-device-connect-btn").textContent, "Waiting...");
    assert.equal(w.el("settings-include-private").disabled, true);

    assert.equal(timers.length, 1, "exactly one poll timer");
    assert.equal(timers[0].ms, 6000, "interval (5s) + 1s");
    timers[0].cb();
    assert.equal(w.sentOfType("gitstreak:poll-device-flow-now").length, 1);
  });
});

await test("Cancel: stops the poll timer, tells the worker, and fully resets the controls", async () => {
  await withTimerSpy(async ({ timers, cleared }) => {
    const w = await boot();
    w.broadcast(CODE_READY);
    await waitFor(() => !w.el("settings-device-code").hidden, "code to show");
    await w.el("settings-device-cancel-btn").dispatch("click");
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0], timers[0]);
    assert.equal(w.sentOfType("gitstreak:cancel-device-flow").length, 1);
    assert.equal(w.el("settings-device-code").hidden, true);
    assert.equal(w.el("settings-device-connect-btn").disabled, false);
    assert.equal(w.el("settings-device-connect-btn").textContent, "Connect GitHub");
    assert.equal(w.el("settings-include-private").disabled, false);
  });
});

await test("an off-origin verification link is NEVER rendered: no link, no timer, flow cancelled, user told", async () => {
  await withTimerSpy(async ({ timers }) => {
    const w = await boot();
    for (const bad of ["https://evil.example/login/device", "http://github.com/login/device", "javascript:alert(1)", undefined]) {
      w.broadcast({ ...CODE_READY, verificationUri: bad });
    }
    await settle();
    assert.equal(w.el("settings-device-link").href, "");
    assert.equal(w.el("settings-device-code").hidden, true, "the code box must stay hidden");
    assert.equal(timers.length, 0);
    assert.equal(w.sentOfType("gitstreak:cancel-device-flow").length, 4);
    assert.match(w.el("settings-device-status").textContent, /unexpected verification link/);
  });
});

await test("terminal error status: message shown, controls reset, error acknowledged to the worker", async () => {
  const w = await boot();
  w.broadcast({ type: STATUS, status: "error", message: "You declined the request on GitHub." });
  await waitFor(() => w.el("settings-device-status").textContent.includes("declined"), "error text");
  assert.equal(w.el("settings-device-connect-btn").disabled, false);
  assert.equal(w.sentOfType("gitstreak:ack-device-flow-status").length, 1);
});

await test("resync on open: a code still waiting in the worker is shown immediately", async () => {
  await withTimerSpy(async () => {
    const w = await boot({
      responder: (m) => (m.type === "gitstreak:query-device-flow-status" ? { status: "code_ready", userCode: "WXYZ-9876", verificationUri: "https://github.com/login/device", interval: 5 } : undefined),
    });
    await waitFor(() => !w.el("settings-device-code").hidden, "resynced code");
    assert.equal(w.el("settings-device-code").querySelector(".device-code-value").textContent, "WXYZ-9876");
  });
});

await test("worker success: reflects the saved connection, shows the access note, routes back via token-saved", async () => {
  const w = await boot();
  await saveConnection(adapter, "ghp_abcdefgh12345678", { scopes: ["read:user"] }); // what the worker does itself
  w.broadcast({ type: STATUS, status: "success" });
  await waitFor(() => w.events.includes("gitstreak:token-saved"), "token-saved event");
  assert.ok(w.events.includes("gitstreak:auth-changed"));
  assert.equal(w.el("settings-connected-row").hidden, false);
  assert.match(w.el("settings-connected-label").textContent, /^Connected as ghp_••••5678$/);
  assert.equal(w.el("settings-device-connect-btn").hidden, true);
  assert.equal(w.el("settings-intro-banner").hidden, true);
  assert.match(w.el("settings-access-note").textContent, /public data only/i);
  assert.equal(w.el("settings-access-note").hidden, false);
});

// ---------------------------------------------------------------- access note

await test("access note: private scope is described as read/write-capable; unknown scopes say nothing", async () => {
  const a = await boot({ connected: true, scopes: ["repo", "read:user"] });
  assert.match(a.el("settings-access-note").textContent, /private repos/i);
  assert.match(a.el("settings-access-note").textContent, /could write/i);
  const b = await boot({ connected: true, scopes: null });
  assert.equal(b.el("settings-access-note").hidden, true);
});

// ---------------------------------------------------------------- PAT path

await test("PAT: Test (deadline applied) -> Save goes through saveConnection: token, connection id, scopes and flags all set", async () => {
  const fetched = [];
  globalThis.fetch = async (url, opts) => { fetched.push({ url, opts }); return jsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "repo, read:user" } }); };
  try {
    const w = await boot();
    w.el("settings-token-input").value = "  ghp_pastedtoken99887766  ";
    await w.el("settings-test-btn").dispatch("click");
    assert.equal(fetched[0].url, "https://api.github.com/user");
    assert.ok(fetched[0].opts.signal, "Test Connection must carry a deadline (invariant 11)");
    assert.match(w.el("settings-scopes").textContent, /Signed in as octocat\. Scopes: repo, read:user/);
    assert.equal(w.el("settings-save-btn").disabled, false);

    await w.el("settings-save-btn").dispatch("click");
    await waitFor(() => w.events.includes("gitstreak:token-saved"), "token-saved");
    assert.equal(await getToken(adapter), "ghp_pastedtoken99887766", "stored trimmed");
    assert.ok(await getConnectionId(adapter), "a connection id was minted (this was the missing wiring)");
    assert.deepEqual(await getGrantedScopes(adapter), ["repo", "read:user"]);
    assert.equal(await getHasEverConnected(adapter), true);
    assert.equal(w.el("settings-token-input").value, "");
    assert.ok(w.events.includes("gitstreak:auth-changed"));
  } finally { globalThis.fetch = originalFetch; }
});

await test("PAT: a fine-grained token records scopes as UNKNOWN (null), never as 'none' — and shows no access note", async () => {
  globalThis.fetch = async () => jsonResponse({ login: "octocat" }, { headers: {} });
  try {
    const w = await boot();
    w.el("settings-token-input").value = "github_pat_finegrained";
    await w.el("settings-test-btn").dispatch("click");
    await w.el("settings-save-btn").dispatch("click");
    await waitFor(() => w.events.includes("gitstreak:token-saved"), "token-saved");
    assert.equal(await getGrantedScopes(adapter), null);
    assert.equal(w.el("settings-access-note").hidden, true);
  } finally { globalThis.fetch = originalFetch; }
});

await test("PAT: Save is refused until the token has been tested, and editing the token invalidates the test", async () => {
  globalThis.fetch = async () => jsonResponse({ login: "octocat" }, { headers: { "x-oauth-scopes": "read:user" } });
  try {
    const w = await boot();
    w.el("settings-token-input").value = "ghp_x1234567890";
    await w.el("settings-save-btn").dispatch("click");
    assert.equal(await getToken(adapter), null);
    assert.match(w.el("settings-status").textContent, /Test the connection first/);

    await w.el("settings-test-btn").dispatch("click");
    assert.equal(w.el("settings-save-btn").disabled, false);
    await w.el("settings-token-input").dispatch("input");
    assert.equal(w.el("settings-save-btn").disabled, true, "typing after a test must force a re-test");
  } finally { globalThis.fetch = originalFetch; }
});

await test("PAT: a rejected token (401) shows the error and saves nothing", async () => {
  globalThis.fetch = async () => jsonResponse({}, { status: 401, statusText: "Unauthorized" });
  try {
    const w = await boot();
    w.el("settings-token-input").value = "ghp_bad";
    await w.el("settings-test-btn").dispatch("click");
    assert.match(w.el("settings-status").textContent, /rejected this token \(401\)/);
    assert.equal(w.el("settings-save-btn").disabled, true);
    assert.equal(await getToken(adapter), null);
  } finally { globalThis.fetch = originalFetch; }
});

// ---------------------------------------------------------------- disconnect

async function seedAccountData() {
  const store = createProjectStore(adapter);
  await store.create("me/priv", "Priv", "me/priv");
  await store.create("me/pub", "Pub", "me/pub");
  await store.updateRepoMeta("me/priv", { private: true });
  await store.updateRepoMeta("me/pub", { private: false });
  await adapter.set({ [PULSE_CACHE_KEY]: { connectionId: await getConnectionId(adapter), lastPushedRepos: [{ fullName: "me/priv" }] } });
}

await test("Disconnect goes through disconnect(): token, vault key, cache, id, scopes and PRIVATE repos are gone; public repos and 'ever connected' stay", async () => {
  const w = await boot({ connected: true, scopes: ["repo", "read:user"] });
  await seedAccountData();
  assert.equal(w.fakeDb._inspectRawStore("gitstreak_vault", "keys").has("token-key"), true, "sanity: key exists before");

  await w.el("settings-revoke-btn").dispatch("click");
  await waitFor(() => w.events.includes("gitstreak:disconnected"), "disconnected event");

  assert.equal(await getToken(adapter), null);
  assert.equal(w.fakeDb._inspectRawStore("gitstreak_vault", "keys").has("token-key"), false, "vault key deleted too");
  assert.equal(w.store[PULSE_CACHE_KEY], null, "Pulse cache wiped (this was the privacy leak)");
  assert.equal(await getConnectionId(adapter), null);
  assert.equal(await getGrantedScopes(adapter), null);
  assert.deepEqual((await createProjectStore(adapter).list()).map((p) => p.id), ["me/pub"], "private repo removed, public kept");
  assert.equal(await getHasEverConnected(adapter), true);
  assert.ok(!JSON.stringify(w.store).includes("me/priv"), "no private repo name left anywhere on disk");

  assert.equal(w.sentOfType("gitstreak:cancel-device-flow").length, 1, "any in-flight Device Flow is cancelled first");
  assert.match(w.el("settings-intro-text").textContent, /removed or stopped working/);
  assert.equal(w.el("settings-connected-row").hidden, true);
  assert.equal(w.el("settings-device-connect-btn").hidden, false);
  assert.ok(w.events.includes("gitstreak:auth-changed"));
});

await test("Disconnect: answering 'Cancel' to the confirm changes nothing at all", async () => {
  const w = await boot({ connected: true, scopes: ["read:user"] });
  w.dialogs.confirmAnswer = false;
  await w.el("settings-revoke-btn").dispatch("click");
  await settle();
  assert.equal(await getToken(adapter), "ghp_abcdefgh12345678");
  assert.ok(!w.events.includes("gitstreak:disconnected"));
  assert.equal(w.sentOfType("gitstreak:cancel-device-flow").length, 0);
});

// ---------------------------------------------------------------- reconnect UX

await test("failing token: connect options reappear as 'Reconnect GitHub', label emphasised, card not 'healthy'", async () => {
  const w = await boot({ connected: true, scopes: ["read:user"], authFailed: true });
  assert.equal(w.el("settings-device-connect-btn").hidden, false);
  assert.equal(w.el("settings-device-connect-btn").textContent, "Reconnect GitHub");
  assert.equal(w.el("settings-token-entry").hidden, false);
  assert.equal(w.el("settings-private-row").hidden, false);
  assert.equal(w.el("settings-connected-row").hidden, false);
  assert.equal(w.el("settings-connected-row").classList.contains("is-authfailed"), true);
  assert.equal(w.el("settings-token-card").classList.contains("is-connected"), false);
  assert.match(w.el("settings-connected-label").textContent, /last check failed, reconnect/);
  assert.equal(w.el("settings-intro-banner").hidden, true, "the banner is for the disconnected state only");
});

await test("auth-changed from another view re-reads state: healthy -> failing -> reconnected, with no event loop", async () => {
  const w = await boot({ connected: true, scopes: ["read:user"] });
  assert.equal(w.el("settings-device-connect-btn").hidden, true);

  await setAuthFailed(adapter, true); // e.g. Pulse just got a 401
  w.emit("gitstreak:auth-changed");
  await waitFor(() => w.el("settings-device-connect-btn").textContent === "Reconnect GitHub" && !w.el("settings-device-connect-btn").hidden, "reconnect UX");

  await saveConnection(adapter, "ghp_newtoken00001111", { scopes: ["read:user"] }); // reconnect clears the flag
  w.emit("gitstreak:auth-changed");
  await waitFor(() => w.el("settings-device-connect-btn").hidden, "healthy again");
  assert.equal(w.el("settings-connected-row").classList.contains("is-authfailed"), false);
  assert.equal(await getAuthFailed(adapter), false);

  await settle();
  // The only auth-changed events are the two this test emitted itself. If the
  // Settings handler re-dispatched, the count would be higher (invariant 12).
  assert.equal(w.events.filter((e) => e === "gitstreak:auth-changed").length, 2);
});

await test("a refresh landing during an in-progress Device Flow does not clobber the 'Waiting...' button", async () => {
  await withTimerSpy(async () => {
    const w = await boot();
    w.broadcast(CODE_READY);
    await waitFor(() => !w.el("settings-device-code").hidden, "code to show");
    w.emit("gitstreak:auth-changed");
    await settle();
    assert.equal(w.el("settings-device-connect-btn").textContent, "Waiting...");
    assert.equal(w.el("settings-device-connect-btn").disabled, true);
  });
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
