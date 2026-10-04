// test/manifest.test.mjs
// Guards the extension's blast radius: what it may talk to, what it may do,
// and that every file the manifest points at actually exists. A permission
// creeping back in (or an icon going missing, which silently breaks
// load-unpacked) fails CI.
// Run with: node test/manifest.test.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.message}`); }
}

test("manifest v3", () => assert.equal(manifest.manifest_version, 3));

test("host permissions are exactly the API and the two device-flow login endpoints' path — no wildcard github.com", () => {
  assert.deepEqual([...manifest.host_permissions].sort(), ["https://api.github.com/*", "https://github.com/login/*"]);
});

test("API permissions are exactly storage + alarms", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "storage"]);
});

test("no content scripts, no externally_connectable, no remote-code or broad-access keys", () => {
  for (const key of ["content_scripts", "externally_connectable", "web_accessible_resources", "optional_host_permissions", "optional_permissions", "content_security_policy"]) {
    assert.equal(manifest[key], undefined, `${key} must not be present`);
  }
});

test("every file the manifest references exists", () => {
  const refs = [manifest.action?.default_popup, manifest.background?.service_worker, ...Object.values(manifest.action?.default_icon || {}), ...Object.values(manifest.icons || {})];
  for (const ref of refs) assert.ok(ref && existsSync(path.join(root, ref)), `missing file referenced by manifest: ${ref}`);
});

test("the service worker is declared as an ES module (background.js uses imports)", () => assert.equal(manifest.background.type, "module"));

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
