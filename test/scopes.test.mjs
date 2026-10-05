// test/scopes.test.mjs — lib/scopes.js
// Run with: node test/scopes.test.mjs
import assert from "node:assert/strict";
import { SCOPE_PUBLIC, SCOPE_PRIVATE, scopeFor, isAllowedScope, parseScopes, canReadPrivate, describeAccess } from "../lib/scopes.js";

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.message}`); } }

test("the default tier is read:user only — no repo scope", () => {
  assert.equal(SCOPE_PUBLIC, "read:user");
  assert.ok(!SCOPE_PUBLIC.split(" ").includes("repo"));
  assert.equal(scopeFor(false), SCOPE_PUBLIC);
  assert.equal(scopeFor(undefined), SCOPE_PUBLIC);
  assert.equal(scopeFor(null), SCOPE_PUBLIC);
});

test("the private tier is an explicit opt-in: ONLY a strict boolean true selects it", () => {
  assert.equal(scopeFor(true), SCOPE_PRIVATE);
  for (const truthyButNotTrue of ["true", 1, "yes", {}, []]) assert.equal(scopeFor(truthyButNotTrue), SCOPE_PUBLIC);
  assert.deepEqual(SCOPE_PRIVATE.split(" ").sort(), ["read:user", "repo"]);
});

test("only the two vetted scope strings are allowed", () => {
  assert.equal(isAllowedScope(SCOPE_PUBLIC), true);
  assert.equal(isAllowedScope(SCOPE_PRIVATE), true);
  for (const bad of ["repo", "admin:org", "read:user repo", "delete_repo", "", null, undefined, "repo read:user admin:org"]) assert.equal(isAllowedScope(bad), false, String(bad));
});

test("parseScopes: comma/space separated string -> array; absent -> null; arrays pass through", () => {
  assert.deepEqual(parseScopes("repo,read:user"), ["repo", "read:user"]);
  assert.deepEqual(parseScopes("repo, read:user"), ["repo", "read:user"]);
  assert.deepEqual(parseScopes("read:user"), ["read:user"]);
  assert.deepEqual(parseScopes(""), [], "an explicit empty grant is [] — not 'unknown'");
  assert.equal(parseScopes(undefined), null);
  assert.equal(parseScopes(null), null);
  assert.deepEqual(parseScopes(["a", "b"]), ["a", "b"]);
});

test("canReadPrivate is true only when `repo` was actually granted", () => {
  assert.equal(canReadPrivate(["repo", "read:user"]), true);
  assert.equal(canReadPrivate(["read:user"]), false);
  assert.equal(canReadPrivate([]), false);
  assert.equal(canReadPrivate(null), false, "unknown must not be treated as granted");
});

test("describeAccess: unknown says nothing; public-only and private are described differently and honestly", () => {
  assert.equal(describeAccess(null), "");
  assert.equal(describeAccess(undefined), "");
  assert.match(describeAccess(["read:user"]), /public data only/i);
  assert.match(describeAccess(["read:user"]), /reconnect/i);
  assert.match(describeAccess(["repo", "read:user"]), /private repos/i);
  assert.match(describeAccess(["repo"]), /could write/i, "the broader access must be called what it is");
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
