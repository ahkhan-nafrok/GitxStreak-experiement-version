// lib/deviceFlowRunner.js
// The device-flow state machine, with every side effect injected so it can
// be tested without a browser. background.js is just wiring around this.
//
// Why storage-backed + alarm-driven: Chrome kills an MV3 service worker
// after ~30s idle, so flow state lives in storage and chrome.alarms wakes
// the worker for each single poll attempt.
//
// Guarantees this file exists to provide (each has a test):
//   - Transient failures (code "network") don't end the flow; only
//     MAX_CONSECUTIVE_TRANSIENT_FAILURES in a row do. Any other error is
//     terminal.
//   - A poll that was already in flight when the user cancels (or restarts)
//     can never save a token or resurrect the session/alarm: the result is
//     dropped if the epoch changed or the stored deviceCode no longer
//     matches.
//   - Never polls faster than GitHub's `interval`, no matter who asks
//     (alarm or the open popup's "poll now"), and never two polls at once.
//   - A session whose alarm was lost (browser restart) is re-armed; an
//     expired one is reported as expired instead of showing a dead code.
//
// Known residual window: a Cancel that lands in the few milliseconds
// while onSuccess() is already saving the token can't un-save it. The user
// can still Disconnect, which removes it.

import { DeviceFlowError } from "./deviceFlow.js";

export const SESSION_KEY = "gsDeviceFlowSession";
export const LAST_RESULT_KEY = "gsDeviceFlowLastResult";
export const ALARM_NAME = "gitstreak-device-poll";
export const STATUS_MESSAGE_TYPE = "gitstreak:device-flow-status";
export const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 4;

const MIN_ALARM_MINUTES = 1; // Chrome's production minimum for alarms
const RATE_GUARD_SLACK_MS = 500;
const EXPIRED_MESSAGE = "This code expired before it was approved. Try again.";

export function createDeviceFlowRunner({
  storage, // { get(keys), set(obj), remove(keys) } — promise-based
  alarms, // { create(name, info), clear(name), get(name) } — promise-based
  requestDeviceCode,
  checkTokenOnce,
  onSuccess, // async (token) => void — saves the connection
  broadcast, // (message) => void — best-effort UI ping
  now = () => Date.now(),
}) {
  let generation = 0; // bumped by start/cancel; in-flight work compares against it
  let polling = false;

  function send(payload) {
    try {
      broadcast({ type: STATUS_MESSAGE_TYPE, ...payload });
    } catch {
      /* best-effort only */
    }
  }

  async function readSession() {
    const data = await storage.get([SESSION_KEY]);
    return data[SESSION_KEY] || null;
  }

  async function scheduleAlarm(intervalSec) {
    const minutes = Math.max(intervalSec / 60, MIN_ALARM_MINUTES);
    await alarms.create(ALARM_NAME, { delayInMinutes: minutes, periodInMinutes: minutes });
  }

  async function clearSession() {
    await storage.remove(SESSION_KEY);
    await alarms.clear(ALARM_NAME);
  }

  async function failTerminal(message) {
    await clearSession();
    await storage.set({ [LAST_RESULT_KEY]: { status: "error", message } });
    send({ status: "error", message });
  }

  const stillCurrent = (epoch, session, latest) =>
    epoch === generation && !!latest && latest.deviceCode === session.deviceCode;

  async function startFlow() {
    const epoch = ++generation;
    await clearSession();
    await storage.remove(LAST_RESULT_KEY);

    let info;
    try {
      info = await requestDeviceCode();
    } catch (e) {
      if (epoch !== generation) return; // superseded or cancelled meanwhile
      await failTerminal(e.message);
      return;
    }
    if (epoch !== generation) return;

    const session = {
      deviceCode: info.deviceCode,
      interval: info.interval,
      expiresAt: now() + info.expiresIn * 1000,
      userCode: info.userCode,
      verificationUri: info.verificationUri,
      failures: 0,
      lastPollAt: 0,
    };
    await storage.set({ [SESSION_KEY]: session });
    await scheduleAlarm(session.interval);
    send({
      status: "code_ready",
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      interval: session.interval,
    });
  }

  async function pollOnceInner() {
    const epoch = generation;
    const session = await readSession();
    if (!session) {
      await alarms.clear(ALARM_NAME);
      return;
    }

    const t = now();
    if (t > session.expiresAt) {
      await failTerminal(EXPIRED_MESSAGE);
      return;
    }
    // Never poll faster than GitHub's interval, regardless of the caller.
    if (t - (session.lastPollAt || 0) < session.interval * 1000 - RATE_GUARD_SLACK_MS) return;

    // Stamp BEFORE the network call so a worker killed mid-request still
    // honors the interval on the next wake-up.
    await storage.set({ [SESSION_KEY]: { ...session, lastPollAt: t } });

    let result;
    try {
      result = await checkTokenOnce(session.deviceCode, session.interval);
    } catch (e) {
      const latest = await readSession();
      if (!stillCurrent(epoch, session, latest)) return;
      const transient = e instanceof DeviceFlowError && e.code === "network";
      const failures = (latest.failures || 0) + 1;
      if (transient && failures < MAX_CONSECUTIVE_TRANSIENT_FAILURES) {
        await storage.set({ [SESSION_KEY]: { ...latest, failures } });
        send({ status: "pending" });
        return;
      }
      await failTerminal(e instanceof DeviceFlowError ? e.message : `Unexpected error: ${e.message}`);
      return;
    }

    const latest = await readSession();
    if (!stillCurrent(epoch, session, latest)) return; // cancelled/replaced mid-flight: drop the result

    if (result.status === "success") {
      try {
        await onSuccess(result.token);
      } catch (e) {
        await failTerminal(`Connected on GitHub, but saving the token failed: ${e.message}`);
        return;
      }
      await clearSession();
      send({ status: "success" });
      return;
    }

    if (result.status === "slow_down") {
      const next = { ...latest, interval: result.newInterval, failures: 0 };
      await storage.set({ [SESSION_KEY]: next });
      await scheduleAlarm(next.interval);
      send({ status: "slow_down" });
      return;
    }

    await storage.set({ [SESSION_KEY]: { ...latest, failures: 0 } }); // pending
    send({ status: "pending" });
  }

  /** One poll attempt. Safe to call from the alarm AND from the popup. */
  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      await pollOnceInner();
    } finally {
      polling = false;
    }
  }

  async function cancelFlow() {
    generation++; // synchronous, before any await: invalidates in-flight work
    await clearSession();
    await storage.remove(LAST_RESULT_KEY);
    send({ status: "cancelled" });
  }

  async function queryStatus() {
    const data = await storage.get([SESSION_KEY, LAST_RESULT_KEY]);
    const session = data[SESSION_KEY];
    if (session) {
      if (now() > session.expiresAt) {
        await failTerminal(EXPIRED_MESSAGE);
        return { status: "error", message: EXPIRED_MESSAGE };
      }
      if (!(await alarms.get(ALARM_NAME))) await scheduleAlarm(session.interval); // alarm lost (browser restart)
      return { status: "code_ready", userCode: session.userCode, verificationUri: session.verificationUri, interval: session.interval };
    }
    return data[LAST_RESULT_KEY] || null;
  }

  async function ackStatus() {
    await storage.remove(LAST_RESULT_KEY);
  }

  /** Call on browser startup / extension install: re-arms a lost alarm and
   * retires an expired session. */
  async function resume() {
    await queryStatus();
  }

  return { startFlow, pollOnce, cancelFlow, queryStatus, ackStatus, resume };
}
