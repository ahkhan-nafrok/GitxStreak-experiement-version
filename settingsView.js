// settingsView.js
// Settings panel — two ways to connect: GitHub Device Flow (primary,
// "Connect GitHub" button) and a manual PAT-paste form (collapsed under
// "Use a personal access token instead").
//
// Device Flow's actual polling is alarm-driven and storage-backed inside
// background.js (see that file's header comment for why) — it saves the
// token directly to the vault the moment GitHub approves, independent of
// whether this popup is even open. This view's job is now just:
//   (1) tell background.js to start a flow,
//   (2) render whatever LIVE status background.js broadcasts, if this
//       popup happens to be open at the time,
//   (3) on init, ask background.js for any in-progress/unacked terminal
//       status so a popup that missed live updates can resync, and
//   (4) always call refreshConnectedState() — which reads the vault
//       directly via getToken() — as the actual source of truth for
//       "are we connected." This is what makes success work correctly
//       even if this popup was fully closed for the entire approval wait.
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

  // Device Flow elements
  const deviceConnectBtn = document.getElementById("settings-device-connect-btn");
  const deviceStatusEl = document.getElementById("settings-device-status");
  const deviceCodeEl = document.getElementById("settings-device-code");
  const deviceCodeValueEl = deviceCodeEl?.querySelector(".device-code-value");
  const deviceLinkEl = document.getElementById("settings-device-link");
  const deviceCancelBtn = document.getElementById("settings-device-cancel-btn");

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
    if (deviceConnectBtn) deviceConnectBtn.hidden = isConnected;

    if (isConnected) {
      introBanner.hidden = true;
    } else {
      const everConnected = await getHasEverConnected(chromeStorageAdapter);
      introText.textContent = everConnected
        ? "Your GitHub connection was removed or stopped working. Reconnect below."
        : "Welcome to GITSTREAK — connect your GitHub account to see your contribution activity, streak, and tracked repos.";
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

  // ------------------------------------------------------------------
  // Device Flow
  // ------------------------------------------------------------------

  function renderDeviceStatus(msg) {
    if (!deviceStatusEl) return;
    deviceStatusEl.hidden = !msg;
    deviceStatusEl.textContent = msg;
  }

  function resetDeviceUI() {
    if (!deviceCodeEl) return;
    deviceCodeEl.hidden = true;
    deviceCancelBtn.hidden = true;
    deviceConnectBtn.disabled = false;
    deviceConnectBtn.textContent = "Connect GitHub";
  }

  function ackDeviceStatus() {
    chrome.runtime.sendMessage({ type: "gitstreak:ack-device-flow-status" }).catch(() => {});
  }

  async function handleDeviceStatus(msg) {
    if (!msg) return;

    if (msg.status === "code_ready") {
      deviceCodeEl.hidden = false;
      deviceCodeValueEl.textContent = msg.userCode;
      deviceLinkEl.href = msg.verificationUri;
      deviceLinkEl.textContent = msg.verificationUri.replace(/^https?:\/\//, "");
      deviceCancelBtn.hidden = false;
      deviceConnectBtn.disabled = true;
      deviceConnectBtn.textContent = "Waiting...";
      renderDeviceStatus("Waiting for approval on GitHub — this can take a minute or so to register once you approve.");
    } else if (msg.status === "pending") {
      // no-op, keep showing the same waiting copy
    } else if (msg.status === "slow_down") {
      renderDeviceStatus("Still waiting — checking a little less often now.");
    } else if (msg.status === "success") {
      // background.js already saved the token directly to the vault —
      // this view's job now is purely to reflect that, via the same
      // source of truth (getToken()) everything else uses.
      resetDeviceUI();
      renderDeviceStatus("");
      await refreshConnectedState();
      window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
      window.dispatchEvent(new CustomEvent("gitstreak:token-saved")); // popup.js routes back to Pulse
    } else if (msg.status === "cancelled") {
      resetDeviceUI();
      renderDeviceStatus("");
      ackDeviceStatus();
    } else if (msg.status === "error") {
      resetDeviceUI();
      renderDeviceStatus(msg.message);
      ackDeviceStatus();
    }
  }

  if (deviceConnectBtn) {
    deviceConnectBtn.addEventListener("click", () => {
      deviceConnectBtn.disabled = true;
      deviceConnectBtn.textContent = "Connecting...";
      renderDeviceStatus("Requesting a code from GitHub...");
      chrome.runtime.sendMessage({ type: "gitstreak:start-device-flow" });
    });

    deviceCancelBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "gitstreak:cancel-device-flow" });
      resetDeviceUI();
      renderDeviceStatus("");
    });

    // Live updates while this popup instance stays open.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== "gitstreak:device-flow-status") return;
      handleDeviceStatus(msg);
    });

    // Resync on open — catches a code still waiting for approval, or an
    // error/cancellation that happened while this popup was closed.
    // Success does NOT need to be caught here: refreshConnectedState()
    // below (called unconditionally at the end of this function) already
    // reflects a token background.js saved while this popup was closed.
    chrome.runtime.sendMessage({ type: "gitstreak:query-device-flow-status" }, (status) => {
      if (chrome.runtime.lastError) return; // background not ready yet, harmless
      if (status) handleDeviceStatus(status);
    });
  }

  // ------------------------------------------------------------------
  // Manual PAT entry (fallback path — unchanged logic, same functions)
  // ------------------------------------------------------------------

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
      await setAuthFailed(chromeStorageAdapter, false);
      await setHasEverConnected(chromeStorageAdapter, true);
      tokenInput.value = "";
      lastValidated = null;
      scopesEl.hidden = true;
      setStatus("Token saved.");
      await refreshConnectedState();
      window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
      window.dispatchEvent(new CustomEvent("gitstreak:token-saved"));
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      saveBtn.disabled = true;
    }
  });

  revokeBtn.addEventListener("click", async () => {
    if (!confirm("Remove the saved GitHub connection from this browser? Pulse and private-repo tracking will stop working until you reconnect. This does not revoke anything on GitHub's side — do that at github.com/settings/tokens or github.com/settings/applications if needed.")) {
      return;
    }
    try {
      await revokeToken(chromeStorageAdapter);
      await setAuthFailed(chromeStorageAdapter, false);
      setStatus("Disconnected locally.");
      await refreshConnectedState();
      window.dispatchEvent(new CustomEvent("gitstreak:auth-changed"));
    } catch (e) {
      setStatus(e.message, true);
    }
  });

  refreshConnectedState();
}