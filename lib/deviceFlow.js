// lib/deviceFlow.js
// GitHub OAuth Device Flow — no client_secret involved, safe to run from an
// unpackable extension. Two endpoints, both on github.com (NOT
// api.github.com):
//   POST /login/device/code           -> { device_code, user_code, verification_uri, expires_in, interval }
//   POST /login/oauth/access_token    -> polled until approved or denied/expired
//
// checkTokenOnce() is the single-attempt primitive; lib/deviceFlowRunner.js
// drives it from chrome.alarms (an MV3 service worker can't be trusted to
// survive a long setTimeout loop — the old pollForToken was removed for that
// reason).
//
// Hardening pass:
//   - Requests have a deadline (lib/net.js). A dropped connection, timeout,
//     5xx or unreadable body is reported with code "network" — the ONLY
//     code the runner treats as retryable. Everything else is terminal.
//   - verification_uri must be on https://github.com — it's rendered as a
//     clickable link next to a code the user is told to type, so an
//     off-origin value must never reach the UI.

import { fetchWithTimeout, NetworkError } from "./net.js";

const CLIENT_ID = "Ov23ctsePDdggMRry1QU";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
// NOTE: "repo" is broad (read/write on all private repos). Narrowing it is a
// separate decision from this hardening pass — change it here when decided.
const SCOPE = "repo";
const ALLOWED_VERIFICATION_ORIGIN = "https://github.com";

export class DeviceFlowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code; // 'access_denied' | 'expired_token' | 'bad_request' | 'malformed' | 'network' | ...
  }
}

function isGithubUri(value) {
  try {
    return new URL(value).origin === ALLOWED_VERIFICATION_ORIGIN;
  } catch {
    return false;
  }
}

/** Pure: turns the raw device-code JSON into our shape, or throws if the
 * response is malformed. No network call in here. */
export function parseDeviceCodeResponse(json) {
  if (!json || !json.device_code || !json.user_code || !json.verification_uri) {
    throw new DeviceFlowError("GitHub returned an unexpected device-code response.", "malformed");
  }
  if (!isGithubUri(json.verification_uri)) {
    throw new DeviceFlowError("GitHub returned an unexpected verification link.", "malformed");
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
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    if (e instanceof NetworkError) throw new DeviceFlowError(e.message, "network");
    throw e;
  }
  if (!res.ok && res.status !== 400) {
    // GitHub's device-flow errors (pending/slow_down/etc.) legitimately come
    // back as 200 with an `error` field, per spec — only a genuine HTTP
    // failure (not 200, not the documented 400 error-carrying case) is a
    // real network-level problem.
    throw new DeviceFlowError(`GitHub error: ${res.status} ${res.statusText}`, "network");
  }
  try {
    return await res.json();
  } catch {
    throw new DeviceFlowError("GitHub returned an unreadable response.", "network");
  }
}

export async function requestDeviceCode() {
  const json = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE });
  return parseDeviceCodeResponse(json);
}

/** Single poll attempt — one network call, interpreted. Stateless: the
 * caller persists whatever the result implies (new interval, success...). */
export async function checkTokenOnce(deviceCode, currentInterval) {
  const json = await postForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  return interpretTokenResponse(json, currentInterval);
}
