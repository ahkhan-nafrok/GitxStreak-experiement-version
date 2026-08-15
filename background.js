// background.js — MV3 service worker.
//
// Device Flow polling is now storage-backed and alarm-driven, NOT an
// in-memory loop. Why: Chrome terminates an MV3 service worker after
// roughly 30 seconds of inactivity, even mid-await inside a pending
// setTimeout — a realistic GitHub approval (open tab, navigate, type
// code) reliably takes longer than that, so an in-memory poll loop WILL
// die silently before approval completes. The fix:
//
//   - Flow state (device code, interval, expiry, user code, verification
//     URL) lives in chrome.storage.local, not a JS variable — it survives
//     the worker being killed and restarted.
//   - chrome.alarms wakes the worker on a schedule (1-minute minimum in
//     production — a real platform constraint, not a choice) to take
//     exactly one poll attempt via checkTokenOnce(), then goes back to
//     being killable.
//   - On success, THIS FILE calls saveToken()/setAuthFailed()/
//     setHasEverConnected() directly — the same vault functions
//     settingsView.js's PAT path already uses. The popup does NOT need to
//     be open, or even alive, for the token to actually get saved.
//     Whenever the popup is next opened, its existing getToken() call in
//     refreshConnectedState() just sees the saved token — no message
//     round-trip required for the terminal success case.
//   - Live status broadcasts (code_ready/pending/slow_down) still fire for
//     a popup that happens to be open, purely for UI feedback — but
//     nothing about the flow's correctness depends on the popup receiving
//     them.
import { requestDeviceCode, checkTokenOnce, DeviceFlowError } from "./lib/deviceFlow.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { saveToken } from "./lib/tokenVault.js";
import { setAuthFailed, setHasEverConnected } from "./lib/authState.js";

const SESSION_KEY = "gsDeviceFlowSession";
const LAST_RESULT_KEY = "gsDeviceFlowLastResult";
const ALARM_NAME = "gitstreak-device-poll";
const MIN_ALARM_MINUTES = 1; // Chrome's enforced production minimum for periodInMinutes

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "gitstreak:start-device-flow") {
    startFlow();
    return false;
  }
  if (msg?.type === "gitstreak:cancel-device-flow") {
    cancelFlow();
    return false;
  }
  if (msg?.type === "gitstreak:query-device-flow-status") {
    queryStatus().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === "gitstreak:ack-device-flow-status") {
    chrome.storage.local.remove(LAST_RESULT_KEY);
    return false;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pollOnce();
});

async function startFlow() {
  await clearSession();
  try {
    const codeInfo = await requestDeviceCode();
    const session = {
      deviceCode: codeInfo.deviceCode,
      interval: codeInfo.interval,
      expiresAt: Date.now() + codeInfo.expiresIn * 1000,
      userCode: codeInfo.userCode,
      verificationUri: codeInfo.verificationUri,
    };
    await chrome.storage.local.set({ [SESSION_KEY]: session });
    broadcast({
      type: "gitstreak:device-flow-status",
      status: "code_ready",
      userCode: session.userCode,
      verificationUri: session.verificationUri,
    });

    const periodMinutes = Math.max(session.interval / 60, MIN_ALARM_MINUTES);
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: periodMinutes, periodInMinutes: periodMinutes });
  } catch (e) {
    await setLastResult({ status: "error", message: e.message });
    broadcast({ type: "gitstreak:device-flow-status", status: "error", message: e.message });
  }
}

async function pollOnce() {
  const data = await chrome.storage.local.get([SESSION_KEY]);
  const session = data[SESSION_KEY];
  if (!session) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }

  if (Date.now() > session.expiresAt) {
    await clearSession();
    const message = "This code expired before it was approved. Try again.";
    await setLastResult({ status: "error", message });
    broadcast({ type: "gitstreak:device-flow-status", status: "error", message });
    return;
  }

  try {
    const result = await checkTokenOnce(session.deviceCode, session.interval);

    if (result.status === "success") {
      await saveToken(chromeStorageAdapter, result.token);
      await setAuthFailed(chromeStorageAdapter, false);
      await setHasEverConnected(chromeStorageAdapter, true);
      await clearSession();
      broadcast({ type: "gitstreak:device-flow-status", status: "success" });
      return;
    }

    if (result.status === "slow_down") {
      session.interval = result.newInterval;
      await chrome.storage.local.set({ [SESSION_KEY]: session });
      const periodMinutes = Math.max(session.interval / 60, MIN_ALARM_MINUTES);
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: periodMinutes, periodInMinutes: periodMinutes });
      broadcast({ type: "gitstreak:device-flow-status", status: "slow_down" });
      return;
    }

    // status === 'pending' — nothing to persist, alarm fires again next period
    broadcast({ type: "gitstreak:device-flow-status", status: "pending" });
  } catch (e) {
    await clearSession();
    const message = e instanceof DeviceFlowError ? e.message : `Unexpected error: ${e.message}`;
    await setLastResult({ status: "error", message });
    broadcast({ type: "gitstreak:device-flow-status", status: "error", message });
  }
}

async function cancelFlow() {
  await clearSession();
  await chrome.storage.local.remove(LAST_RESULT_KEY);
  broadcast({ type: "gitstreak:device-flow-status", status: "cancelled" });
}

async function queryStatus() {
  const data = await chrome.storage.local.get([SESSION_KEY, LAST_RESULT_KEY]);
  if (data[SESSION_KEY]) {
    return {
      status: "code_ready",
      userCode: data[SESSION_KEY].userCode,
      verificationUri: data[SESSION_KEY].verificationUri,
    };
  }
  if (data[LAST_RESULT_KEY]) {
    return data[LAST_RESULT_KEY];
  }
  return null;
}

async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
  chrome.alarms.clear(ALARM_NAME);
}

async function setLastResult(result) {
  await chrome.storage.local.set({ [LAST_RESULT_KEY]: result });
}

/** Best-effort UI ping for a popup that happens to be open right now.
 * Never awaited for correctness — the actual flow state lives in storage
 * above, not in whether this reaches a listener. */
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}