import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeviceCodeResponse, interpretTokenResponse, DeviceFlowError } from "../lib/deviceFlow.js";

test("parseDeviceCodeResponse: valid shape", () => {
  const r = parseDeviceCodeResponse({
    device_code: "d",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  });
  assert.equal(r.userCode, "ABCD-1234");
  assert.equal(r.deviceCode, "d");
  assert.equal(r.verificationUri, "https://github.com/login/device");
  assert.equal(r.expiresIn, 900);
  assert.equal(r.interval, 5);
});

test("parseDeviceCodeResponse: applies defaults when expires_in/interval are missing", () => {
  const r = parseDeviceCodeResponse({
    device_code: "d",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
  });
  assert.equal(r.expiresIn, 900);
  assert.equal(r.interval, 5);
});

test("parseDeviceCodeResponse: missing required fields throws DeviceFlowError", () => {
  assert.throws(() => parseDeviceCodeResponse({}), DeviceFlowError);
  assert.throws(() => parseDeviceCodeResponse(null), DeviceFlowError);
  assert.throws(() => parseDeviceCodeResponse({ device_code: "d" }), DeviceFlowError);
});

test("interpretTokenResponse: success shape", () => {
  const r = interpretTokenResponse({ access_token: "ghu_abc" }, 5);
  assert.deepEqual(r, { status: "success", token: "ghu_abc" });
});

test("interpretTokenResponse: authorization_pending", () => {
  const r = interpretTokenResponse({ error: "authorization_pending" }, 5);
  assert.deepEqual(r, { status: "pending" });
});

test("interpretTokenResponse: slow_down uses GitHub's returned interval when present", () => {
  const r = interpretTokenResponse({ error: "slow_down", interval: 10 }, 5);
  assert.deepEqual(r, { status: "slow_down", newInterval: 10 });
});

test("interpretTokenResponse: slow_down falls back to currentInterval+5 when GitHub omits interval", () => {
  const r = interpretTokenResponse({ error: "slow_down" }, 5);
  assert.equal(r.status, "slow_down");
  assert.equal(r.newInterval, 10);
});

test("interpretTokenResponse: access_denied throws typed, code-tagged error", () => {
  assert.throws(
    () => interpretTokenResponse({ error: "access_denied" }, 5),
    (e) => e instanceof DeviceFlowError && e.code === "access_denied"
  );
});

test("interpretTokenResponse: expired_token throws typed, code-tagged error", () => {
  assert.throws(
    () => interpretTokenResponse({ error: "expired_token" }, 5),
    (e) => e instanceof DeviceFlowError && e.code === "expired_token"
  );
});

test("interpretTokenResponse: incorrect_device_code throws bad_request", () => {
  assert.throws(
    () => interpretTokenResponse({ error: "incorrect_device_code" }, 5),
    (e) => e instanceof DeviceFlowError && e.code === "bad_request"
  );
});

test("interpretTokenResponse: unrecognized error still throws, tagged with its own code", () => {
  assert.throws(
    () => interpretTokenResponse({ error: "some_future_github_error" }, 5),
    (e) => e instanceof DeviceFlowError && e.code === "some_future_github_error"
  );
});

test("interpretTokenResponse: unrecognized error uses error_description in the message when present", () => {
  try {
    interpretTokenResponse({ error: "weird", error_description: "Something specific broke." }, 5);
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.message, "Something specific broke.");
  }
});