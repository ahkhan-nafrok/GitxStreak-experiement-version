// lib/deviceFlow.js
// GitHub OAuth Device Flow — no client_secret involved, safe to run from
// an unpackable extension. Two endpoints, both on github.com (NOT
// api.github.com):
//   POST /login/device/code           -> { device_code, user_code, verification_uri, expires_in, interval }
//   POST /login/oauth/access_token    -> polled until approved or denied/expired
//
// checkTokenOnce() is the single-attempt primitive used by background.js's
// alarm-driven poll loop — MV3 service workers get torn down after ~30s
// idle, so a long-lived setTimeout poll loop (the original pollForToken
// below) cannot be trusted to survive a realistic approval wait. Kept
// pollForToken for reference/testability, but background.js now drives
// polling via chrome.alarms + checkTokenOnce instead.

const CLIENT_ID = "Ov23ctsePDdggMRry1QU";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPE = "repo"; // required for private repos + private contribution counts

export class DeviceFlowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code; // 'access_denied' | 'expired_token' | 'cancelled' | 'network' | etc.
  }
}

/** Pure: turns the raw device-code JSON into our shape, or throws if the
 * response is malformed. No network call in here. */
export function parseDeviceCodeResponse(json) {
  if (!json || !json.device_code || !json.user_code || !json.verification_uri) {
    throw new DeviceFlowError("GitHub returned an unexpected device-code response.", "malformed");
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    expiresIn: json.expires_in || 900,
    interval: json.interval || 5,
  };
}

/** Pure: interprets one poll response. Returns one of:
 *   { status: 'pending' }
 *   { status: 'slow_down', newInterval }
 *   { status: 'success', token }
 *   throws DeviceFlowError for access_denied / expired_token / other. */
export function interpretTokenResponse(json, currentInterval) {
  if (json.access_token) {
    return { status: "success", token: json.access_token };
  }
  const err = json.error;
  if (err === "authorization_pending") return { status: "pending" };
  if (err === "slow_down") {
    return { status: "slow_down", newInterval: json.interval || currentInterval + 5 };
  }
  if (err === "access_denied") {
    throw new DeviceFlowError("You declined the request on GitHub.", "access_denied");
  }
  if (err === "expired_token") {
    throw new DeviceFlowError("This code expired before it was approved. Try again.", "expired_token");
  }
  if (err === "incorrect_client_credentials" || err === "incorrect_device_code") {
    throw new DeviceFlowError("GitHub rejected the device request — try again.", "bad_request");
  }
  throw new DeviceFlowError(json.error_description || `Unexpected response: ${err}`, err || "unknown");
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok && res.status !== 400) {
    // GitHub's device-flow errors (pending/slow_down/etc.) legitimately come
    // back as 200 with an `error` field, per spec — only a genuine HTTP
    // failure (not 200, not the documented 400 error-carrying case) is a
    // real network-level problem.
    throw new DeviceFlowError(`GitHub error: ${res.status} ${res.statusText}`, "network");
  }
  return res.json();
}

export async function requestDeviceCode() {
  const json = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE });
  return parseDeviceCodeResponse(json);
}

/** Single poll attempt — one network call, interpreted. This is the
 * primitive background.js's alarm handler calls each time it wakes,
 * rather than looping internally. Stateless: caller is responsible for
 * persisting whatever the result implies (new interval, success, etc). */
export async function checkTokenOnce(deviceCode, currentInterval) {
  const json = await postForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  return interpretTokenResponse(json, currentInterval);
}

/**
 * Original long-lived poll loop. NOT used by background.js anymore — an
 * MV3 service worker can be terminated by Chrome after ~30s idle, which
 * silently kills a loop like this mid-wait with no error surfaced. Kept
 * here only for unit-testing interpretTokenResponse/parseDeviceCodeResponse
 * transitively and as a reference implementation; do not wire this into
 * the extension's actual runtime flow.
 */
export async function pollForToken({ deviceCode, interval, expiresIn }, { onTick, shouldAbort } = {}) {
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = interval;

  while (Date.now() < deadline) {
    if (shouldAbort?.()) {
      throw new DeviceFlowError("Cancelled.", "cancelled");
    }
    await sleep(currentInterval * 1000);
    if (shouldAbort?.()) {
      throw new DeviceFlowError("Cancelled.", "cancelled");
    }

    const result = await checkTokenOnce(deviceCode, currentInterval);

    if (result.status === "success") return result.token;
    if (result.status === "slow_down") currentInterval = result.newInterval;
    onTick?.(result.status);
  }

  throw new DeviceFlowError("This code expired before it was approved. Try again.", "expired_token");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}