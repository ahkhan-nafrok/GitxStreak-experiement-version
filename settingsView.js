// settingsView.js
// Settings panel — the token entry/test/revoke flow described in the
// GITSTREAK security layer: masked input, never redisplayed in full,
// test-connection before save, revoke wipes both the encrypted blob and
// the vault key.
//
// This pass: added an intro banner that reads differently depending on
// whether this install has ever connected a token before (first-run vs.
// revisiting-after-disconnect), and wired up the events popup.js listens
// for — 'gitstreak:auth-changed' (badge dot refresh) and
// 'gitstreak:token-saved' (forces the return-from-Settings destination to
// Pulse). Also shows "last check failed, reconnect" on the connected row
// when ghTokenAuthFailed is set, without hiding the row or blocking
// anything — this is a soft-degrade notice, not a lock.
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { saveToken, getToken, revokeToken, maskToken, testConnection } from "./lib/tokenVault.js";
import { getAuthFailed, setAuthFailed, getHasEverConnected, setHasEverConnected } from "./lib/authState.js";

export function initSettingsView() {
  const tokenCard = document.getElementById("settings-token-card");
  const introBanner = document.getElementById("settings-intro-banner");
  const introText = document.getElementById("settings-intro-text");
  const tokenEntry = document.getElementById("settings-token-entry");
  const tokenInput = document.getElementById("settings-token-input");
  const testBtn = document.getElementById("settings-test-btn");
  const saveBtn = document.getElementById("settings-save-btn");
  const revokeBtn = document.getElementById("settings-revoke-btn");
  const statusEl = document.getElementById("settings-status");
  const connectedRow = document.getElementById("settings-connected-row");
  const connectedLabel = document.getElementById("settings-connected-label");
  const scopesEl = document.getElementById("settings-scopes");

  let lastValidated = null; // { login, scopes, isFineGrained } from the most recent successful test-connection

  function setStatus(msg, isError = false) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
  }

  async function refreshConnectedState() {
    const token = await getToken(chromeStorageAdapter);
    const isConnected = !!token;

    tokenCard.classList.toggle("is-connected", isConnected);
    tokenEntry.hidden = isConnected;
    connectedRow.hidden = !isConnected;

    // Intro banner: only relevant while disconnected. Once connected,
    // there's nothing to onboard them into — hide it outright rather than
    // leaving stale first-run copy sitting above a working connection.
    if (isConnected) {
      introBanner.hidden = true;
    } else {
      const everConnected = await getHasEverConnected(chromeStorageAdapter);
      introText.textContent = everConnected
        ? "Your GitHub token was removed or stopped working. Add a new one below to reconnect."
        : "Welcome to GITSTREAK — connect a GitHub token to see your contribution activity, streak, and tracked repos.";
      introBanner.hidden = false;
    }

    if (!isConnected) {
      saveBtn.disabled = true;
      return;
    }

    const authFailed = await getAuthFailed(chromeStorageAdapter);
    connectedRow.classList.toggle("is-authfailed", authFailed);
    connectedLabel.textContent = authFailed
      ? `Connected as ${maskToken(token)} — last check failed, reconnect`
      : `Connected as ${maskToken(token)}`;
  }

  testBtn.addEventListener("click", async () => {
    const raw = tokenInput.value;
    testBtn.disabled = true;
    saveBtn.disabled = true;
    setStatus("Testing connection...");
    scopesEl.hidden = true;
    try {
      const result = await testConnection(raw);
      lastValidated = result;
      const scopeText = result.isFineGrained
        ? "Fine-grained token — scopes aren't exposed via this check, but the connection is valid."
        : `Scopes: ${result.scopes.length ? result.scopes.join(", ") : "(none granted)"}`;
      scopesEl.textContent = `Signed in as ${result.login}. ${scopeText}`;
      scopesEl.hidden = false;
      setStatus("");
      saveBtn.disabled = false;
    } catch (e) {
      lastValidated = null;
      setStatus(e.message, true);
      saveBtn.disabled = true;
    } finally {
      testBtn.disabled = false;
    }
  });

  // Editing the token after a successful test invalidates that test — force
  // re-verification before allowing save, so what's saved is always what
  // was actually checked.
  tokenInput.addEventListener("input", () => {
    lastValidated = null;
    saveBtn.disabled = true;
    scopesEl.hidden = true;
  });

  saveBtn.addEventListener("click", async () => {
    const raw = tokenInput.value;
    if (!lastValidated) {
      setStatus("Test the connection first.", true);
      return;
    }
    saveBtn.disabled = true;
    setStatus("Saving...");
    try {
      await saveToken(chromeStorageAdapter, raw);
      await setAuthFailed(chromeStorageAdapter, false); // a fresh save always clears the failing-token flag
      await setHasEverConnected(chromeStorageAdapter, true); // permanent — never cleared by revoke
      tokenInput.value = "";
      lastValidated = null;
      scopesEl.hidden = true;
      setStatus("Token saved.");
      await refreshConnectedState();
      window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
      window.dispatchEvent(new CustomEvent("gitstreak:token-saved")); // popup.js routes back to Pulse
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      saveBtn.disabled = true; // re-enabled only after a fresh test-connection
    }
  });

  revokeBtn.addEventListener("click", async () => {
    if (!confirm("Remove the saved GitHub token from this browser? Pulse and private-repo tracking will stop working until you add a new one. This does not revoke the token on GitHub's side — do that at github.com/settings/tokens if needed.")) {
      return;
    }
    try {
      await revokeToken(chromeStorageAdapter);
      await setAuthFailed(chromeStorageAdapter, false); // no token means "no auth-failed state" either
      // Deliberately NOT clearing hasEverConnected here — this is what
      // makes the intro banner say "reconnect" instead of "welcome" on
      // the next visit to Settings.
      setStatus("Token removed locally.");
      await refreshConnectedState();
      window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  refreshConnectedState();
}