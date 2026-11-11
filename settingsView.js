// settingsView.js
// Settings panel — two ways to connect: GitHub Device Flow (primary,
// "Connect GitHub" button) and a manual PAT-paste form (collapsed under
// "Use a personal access token instead").
//
// Device Flow's actual polling is alarm-driven and storage-backed inside
// background.js (Chrome kills an idle MV3 worker, so a long in-memory loop
// can't work) — it saves the connection directly the moment GitHub approves,
// independent of whether this popup is even open. This view's job is:
//   (1) tell background.js to start a flow (and which scope tier to ask for),
//   (2) render whatever LIVE status background.js broadcasts,
//   (3) while a code is showing, nudge the worker to poll every
//       interval+1s so approval is noticed in seconds when the popup stays
//       open (the worker's own rate guard makes extra nudges harmless),
//   (4) on init, ask background.js for any in-progress/unacked terminal
//       status so a popup that missed live updates can resync, and
//   (5) treat the vault (getToken) as the source of truth for "connected".
//
// Connect/disconnect side effects go ONLY through lib/connection.js
// (invariant 9) — this file never writes the token, connection id, scopes or
// auth flags itself.
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { getToken, maskToken, testConnection } from "./lib/tokenVault.js";
import { getAuthFailed, getHasEverConnected, getGrantedScopes } from "./lib/authState.js";
import { saveConnection, disconnect } from "./lib/connection.js";
import { describeAccess } from "./lib/scopes.js";

const GITHUB_LINK_PREFIX = "https://github.com/";
const PUBLIC_ONLY_WARNING =
  "Without private-repo access, GITSTREAK can't see pushes to your private repos, so “Last Pushed” will only " +
  "show public repos, and private repos can't be listed or tracked.\n\nContinue with public access only?";
const DEFAULT_POLL_SECONDS = 5;

export function initSettingsView() {
  const adapter = chromeStorageAdapter;
  const byId = (id) => document.getElementById(id);

  const tokenCard = byId("settings-token-card");
  const introBanner = byId("settings-intro-banner");
  const introText = byId("settings-intro-text");
  const tokenEntry = byId("settings-token-entry");
  const tokenInput = byId("settings-token-input");
  const testBtn = byId("settings-test-btn");
  const saveBtn = byId("settings-save-btn");
  const revokeBtn = byId("settings-revoke-btn");
  const statusEl = byId("settings-status");
  const connectedRow = byId("settings-connected-row");
  const connectedLabel = byId("settings-connected-label");
  const scopesEl = byId("settings-scopes");
  const accessNote = byId("settings-access-note");

  // Device Flow elements
  const deviceConnectBtn = byId("settings-device-connect-btn");
  const deviceStatusEl = byId("settings-device-status");
  const deviceCodeEl = byId("settings-device-code");
  const deviceCodeValueEl = deviceCodeEl.querySelector(".device-code-value");
  const deviceLinkEl = byId("settings-device-link");
  const deviceCancelBtn = byId("settings-device-cancel-btn");
  const privateRow = byId("settings-private-row");
  const includePrivateBox = byId("settings-include-private");

  let lastValidated = null; // { login, scopes, isFineGrained } from the latest successful Test Connection
  let deviceFlowActive = false; // a code is requested/showing — don't let a refresh overwrite the button
  let reconnectMode = false; // connected, but the saved token is failing auth
  let devicePollTimer = null;
  let refreshSeq = 0;

  const emit = (name) => window.dispatchEvent(new CustomEvent(name));
  const connectLabel = () => (reconnectMode ? "Reconnect GitHub" : "Connect GitHub");

  /** Promise-returning wrapper so a missing worker never throws synchronously. */
  function sendToWorker(message) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function setStatus(msg, isError = false) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle("error", isError);
  }

  /**
   * Reads every piece of state first, then applies it to the DOM in one
   * synchronous pass. A sequence number drops the result of any call that was
   * overtaken by a newer one, so two overlapping refreshes (e.g. an
   * auth-changed event landing mid-save) can never apply stale state last.
   */
  async function refreshConnectedState() {
    const seq = ++refreshSeq;
    const [token, authFailed, everConnected, scopes] = await Promise.all([
      getToken(adapter),
      getAuthFailed(adapter),
      getHasEverConnected(adapter),
      getGrantedScopes(adapter),
    ]);
    if (seq !== refreshSeq) return;

    const isConnected = !!token;
    reconnectMode = isConnected && authFailed;
    const showConnectOptions = !isConnected || reconnectMode;

    // `is-connected` is the fully-healthy look; a failing token keeps the
    // connect options visible above the connected row, so it needs the border.
    tokenCard.classList.toggle("is-connected", isConnected && !reconnectMode);
    tokenEntry.hidden = !showConnectOptions;
    deviceConnectBtn.hidden = !showConnectOptions;
    privateRow.hidden = !showConnectOptions;
    connectedRow.hidden = !isConnected;
    connectedRow.classList.toggle("is-authfailed", reconnectMode);

    if (!deviceFlowActive) {
      deviceConnectBtn.textContent = connectLabel();
      deviceConnectBtn.disabled = false;
    }

    if (isConnected) {
      introBanner.hidden = true;
      connectedLabel.textContent = reconnectMode
        ? `Connected as ${maskToken(token)} — last check failed, reconnect`
        : `Connected as ${maskToken(token)}`;
    } else {
      introText.textContent = everConnected
        ? "Your GitHub connection was removed or stopped working. Reconnect below."
        : "Welcome to GITSTREAK — connect your GitHub account to see your contribution activity, streak, and tracked repos.";
      introBanner.hidden = false;
    }

    const note = isConnected ? describeAccess(scopes) : "";
    accessNote.textContent = note;
    accessNote.hidden = !note;

    saveBtn.disabled = !lastValidated;
  }

  // ------------------------------------------------------------------
  // Device Flow
  // ------------------------------------------------------------------

  function renderDeviceStatus(msg) {
    deviceStatusEl.hidden = !msg;
    deviceStatusEl.textContent = msg;
  }

  function stopDevicePolling() {
    if (devicePollTimer !== null) {
      clearInterval(devicePollTimer);
      devicePollTimer = null;
    }
  }

  function startDevicePolling(intervalSec) {
    stopDevicePolling();
    const seconds = Number(intervalSec) > 0 ? Number(intervalSec) : DEFAULT_POLL_SECONDS;
    devicePollTimer = setInterval(() => {
      sendToWorker({ type: "gitstreak:poll-device-flow-now" }).catch(() => {});
    }, (seconds + 1) * 1000);
  }

  function resetDeviceUI() {
    stopDevicePolling();
    deviceFlowActive = false;
    deviceCodeEl.hidden = true;
    deviceCancelBtn.hidden = true;
    deviceConnectBtn.disabled = false;
    deviceConnectBtn.textContent = connectLabel();
    includePrivateBox.disabled = false;
  }

  function ackDeviceStatus() {
    sendToWorker({ type: "gitstreak:ack-device-flow-status" }).catch(() => {});
  }

  async function handleDeviceStatus(msg) {
    if (!msg) return;

    if (msg.status === "code_ready") {
      // Defense in depth: the runner already rejects off-origin links, but
      // this value becomes a clickable link next to a code we tell the user
      // to type, so it is checked again at the point of use.
      if (typeof msg.verificationUri !== "string" || !msg.verificationUri.startsWith(GITHUB_LINK_PREFIX)) {
        sendToWorker({ type: "gitstreak:cancel-device-flow" }).catch(() => {});
        resetDeviceUI();
        renderDeviceStatus("GitHub returned an unexpected verification link — try again.");
        return;
      }
      deviceFlowActive = true;
      deviceCodeEl.hidden = false;
      deviceCodeValueEl.textContent = msg.userCode;
      deviceLinkEl.href = msg.verificationUri;
      deviceLinkEl.textContent = msg.verificationUri.replace(/^https?:\/\//, "");
      deviceCancelBtn.hidden = false;
      deviceConnectBtn.disabled = true;
      deviceConnectBtn.textContent = "Waiting...";
      includePrivateBox.disabled = true;
      renderDeviceStatus("Waiting for approval on GitHub — this can take up to a minute to register once you approve.");
      startDevicePolling(msg.interval);
    } else if (msg.status === "pending") {
      // keep showing the same waiting copy
    } else if (msg.status === "slow_down") {
      renderDeviceStatus("Still waiting — checking a little less often now.");
    } else if (msg.status === "success") {
      // The worker already saved the connection — just reflect it, via the
      // same source of truth (the vault) everything else uses.
      resetDeviceUI();
      renderDeviceStatus("");
      await refreshConnectedState();
      emit("gitstreak:auth-changed");
      emit("gitstreak:token-saved"); // popup.js routes back to Pulse; Pulse reloads
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

  deviceConnectBtn.addEventListener("click", () => {
    deviceFlowActive = true;
    deviceConnectBtn.disabled = true;
    deviceConnectBtn.textContent = "Connecting...";
    includePrivateBox.disabled = true;
    renderDeviceStatus("Requesting a code from GitHub...");
    // Only a strict boolean `true` widens the request (see lib/scopes.js).
    // The popup default is ticked; the worker's own default stays public-only.
    sendToWorker({ type: "gitstreak:start-device-flow", includePrivate: includePrivateBox.checked === true }).catch(() => {
      resetDeviceUI();
      renderDeviceStatus("Couldn't reach the extension's background service — reload the extension and try again.");
    });
  });

  // The box is ticked by default (see popup.html). Unticking is the one
  // choice with a visible cost, so it needs an explicit yes; "Cancel" puts
  // the box back to the recommended state. The box is disabled while a flow
  // is running, so this can't fire mid-flow.
  includePrivateBox.addEventListener("change", () => {
    if (includePrivateBox.checked) return;
    if (!confirm(PUBLIC_ONLY_WARNING)) includePrivateBox.checked = true;
  });

  deviceCancelBtn.addEventListener("click", () => {
    sendToWorker({ type: "gitstreak:cancel-device-flow" }).catch(() => {});
    resetDeviceUI();
    renderDeviceStatus("");
  });

  // Live updates while this popup instance stays open.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "gitstreak:device-flow-status") return;
    handleDeviceStatus(msg);
  });

  // Resync on open — catches a code still waiting for approval, or an
  // error/cancellation that happened while this popup was closed. Success
  // needs no special case: refreshConnectedState() (called below) already
  // reflects a connection the worker saved while this popup was closed.
  chrome.runtime.sendMessage({ type: "gitstreak:query-device-flow-status" }, (status) => {
    if (chrome.runtime.lastError) return; // background not ready yet, harmless
    if (status) handleDeviceStatus(status);
  });

  // ------------------------------------------------------------------
  // Manual PAT entry (fallback path)
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
    const scopes = lastValidated.scopes; // array for classic PATs, null (unknown) for fine-grained
    saveBtn.disabled = true;
    setStatus("Saving...");
    try {
      await saveConnection(adapter, raw, { scopes });
      tokenInput.value = "";
      lastValidated = null;
      scopesEl.hidden = true;
      setStatus("Token saved.");
      await refreshConnectedState();
      emit("gitstreak:auth-changed");
      emit("gitstreak:token-saved");
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
    revokeBtn.disabled = true;
    try {
      // Stop any in-progress Device Flow first so a late approval can't
      // silently reconnect right after the user chose to disconnect.
      await sendToWorker({ type: "gitstreak:cancel-device-flow" }).catch(() => {});
      resetDeviceUI();
      renderDeviceStatus("");

      await disconnect(adapter); // token + key + cache + connection id + scopes + private repos
      lastValidated = null;
      setStatus("Disconnected locally.");
      await refreshConnectedState();
      emit("gitstreak:auth-changed");
      emit("gitstreak:disconnected"); // Pulse and Projects re-render without the old account's data
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      revokeBtn.disabled = false;
    }
  });

  // Another view can change connection health while Settings is closed (Pulse
  // or Projects hitting a 401). Re-read on those events so opening Settings
  // never shows stale "Connected" copy. refreshConnectedState dispatches
  // nothing, so this cannot loop (invariant 12).
  window.addEventListener("gitstreak:auth-changed", () => {
    refreshConnectedState();
  });
  window.addEventListener("gitstreak:open-settings", () => {
    refreshConnectedState();
  });

  refreshConnectedState();
}
