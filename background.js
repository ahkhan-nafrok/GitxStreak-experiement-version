// background.js — MV3 service worker. Thin wiring only: the device-flow
// logic lives in lib/deviceFlowRunner.js (storage-backed and alarm-driven,
// because Chrome kills an idle service worker after ~30s) and is tested
// there. Listeners MUST be registered synchronously at top level.
import { requestDeviceCode, checkTokenOnce } from "./lib/deviceFlow.js";
import { createDeviceFlowRunner, ALARM_NAME } from "./lib/deviceFlowRunner.js";
import { chromeStorageAdapter } from "./lib/storageAdapter.js";
import { saveConnection } from "./lib/connection.js";

const runner = createDeviceFlowRunner({
  storage: chrome.storage.local,
  alarms: chrome.alarms,
  requestDeviceCode,
  checkTokenOnce,
  onSuccess: (token, { scopes }) => saveConnection(chromeStorageAdapter, token, { scopes }),
  broadcast: (message) => {
    chrome.runtime.sendMessage(message).catch(() => {}); // no popup open is normal
  },
});

const logFailure = (e) => console.error("GITSTREAK background:", e);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // only our own extension pages

  switch (msg?.type) {
    case "gitstreak:start-device-flow":
      runner.startFlow({ includePrivate: msg.includePrivate === true }).catch(logFailure);
      return false;
    case "gitstreak:cancel-device-flow":
      runner.cancelFlow().catch(logFailure);
      return false;
    case "gitstreak:poll-device-flow-now":
      runner.pollOnce().catch(logFailure);
      return false;
    case "gitstreak:query-device-flow-status":
      runner.queryStatus().then(sendResponse).catch((e) => {
        logFailure(e);
        sendResponse(null);
      });
      return true; // async response
    case "gitstreak:ack-device-flow-status":
      runner.ackStatus().catch(logFailure);
      return false;
    default:
      return false;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runner.pollOnce().catch(logFailure);
});

chrome.runtime.onStartup.addListener(() => runner.resume().catch(logFailure));
chrome.runtime.onInstalled.addListener(() => runner.resume().catch(logFailure));
