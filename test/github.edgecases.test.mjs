// test/github.edgecases.test.mjs — empty repos, error status codes, repo identity keys.
// Run with: node test/github.edgecases.test.mjs
import assert from "node:assert/strict";
import { getLatestCommit, getRepoMeta, repoKeyOf } from "../lib/github.js";

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); } }
const res = (status, body = {}) => ({ ok: status < 400, status, statusText: String(status), headers: { get: () => null }, json: async () => body });
const originalFetch = globalThis.fetch;

await test("getLatestCommit: GitHub's 409 for an empty repo becomes a clear, actionable message", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return res(409, { message: "Git Repository is empty." }); };
  await assert.rejects(() => getLatestCommit("o", "empty", "t"), /no commits yet/);
  assert.equal(calls, 1, "a 409 is not retried");
});

await test("a 409 from a NON-commit endpoint is not relabelled as 'no commits'", async () => {
  globalThis.fetch = async () => res(409);
  await assert.rejects(() => getRepoMeta("o", "r", "t"), (e) => /409/.test(e.message) && !/no commits/.test(e.message) && e.status === 409);
});

await test("HTTP errors carry their status code for callers to branch on", async () => {
  for (const status of [404, 429]) {
    globalThis.fetch = async () => res(status);
    await assert.rejects(() => getRepoMeta("o", "r", "t"), (e) => e.status === status);
  }
  globalThis.fetch = async () => res(403);
  await assert.rejects(() => getRepoMeta("o", "r", "t"), (e) => e.status === 403);
});

await test("repoKeyOf: one canonical lowercase key for every accepted input style", () => {
  const expected = "octo/hello";
  for (const input of ["octo/hello", "Octo/Hello", "https://github.com/Octo/Hello", "https://github.com/octo/hello.git", "https://github.com/octo/hello/tree/main", "  octo/hello  "]) assert.equal(repoKeyOf(input), expected, input);
});

await test("repoKeyOf: unparsable or path-altering input -> null, never throws", () => {
  for (const bad of ["", null, undefined, "nope", "o/..", "../r", "o/r@x", 42]) assert.equal(repoKeyOf(bad), null, String(bad));
});

globalThis.fetch = originalFetch;
console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
