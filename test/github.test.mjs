// test/github.test.mjs
// Tests for lib/github.js — the REST + GraphQL wrapper. Previously
// untested (flagged as a known gap in the project context). This adds that
// baseline coverage, plus GitHubAuthError — the new distinguishable-401
// error type pulseView.js and projectsView.js branch on for the
// token-stopped-working UX.
//
// Run with: node test/github.test.mjs

import assert from "node:assert/strict";
import {
  parseRepoInput,
  getRepoMeta,
  getLatestCommit,
  getMostRecentlyPushedRepo,
  ghGraphQL,
  GitHubAuthError,
} from "../lib/github.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.stack || e.message}`);
  }
}

function jsonResponse(obj, { ok = true, status = 200, statusText = "OK", headers = {} } = {}) {
  return {
    ok, status, statusText,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => obj,
  };
}

const originalFetch = globalThis.fetch;

// ---------------- parseRepoInput ----------------

await test("parseRepoInput: plain owner/repo shorthand", () => {
  assert.deepEqual(parseRepoInput("sindresorhus/is-npm"), { owner: "sindresorhus", repo: "is-npm" });
});

await test("parseRepoInput: full github.com URL", () => {
  assert.deepEqual(parseRepoInput("https://github.com/sindresorhus/is-npm"), { owner: "sindresorhus", repo: "is-npm" });
});

await test("parseRepoInput: full URL with a trailing .git and slash", () => {
  assert.deepEqual(parseRepoInput("https://github.com/sindresorhus/is-npm.git/"), { owner: "sindresorhus", repo: "is-npm" });
});

await test("parseRepoInput: throws a clear error on unparseable input", () => {
  assert.throws(() => parseRepoInput("not a repo at all"), /Couldn't parse/);
  assert.throws(() => parseRepoInput(""), /Couldn't parse/);
});

// ---------------- ghFetch status-code branches (exercised via getRepoMeta) ----------------

await test("getRepoMeta: 401 throws GitHubAuthError specifically, not a generic Error", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(
    () => getRepoMeta("o", "r", "bad-token"),
    (e) => e instanceof GitHubAuthError && /rejected this token/.test(e.message)
  );
});

await test("getRepoMeta: 403 with remaining=0 reports the rate limit, and is NOT a GitHubAuthError", async () => {
  globalThis.fetch = async () =>
    jsonResponse({}, { ok: false, status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" } });
  await assert.rejects(
    () => getRepoMeta("o", "r", null),
    (e) => !(e instanceof GitHubAuthError) && /rate limit hit/.test(e.message)
  );
});

await test("getRepoMeta: 403 WITHOUT remaining=0 falls through to the generic error, not mistaken for a rate limit", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 403, statusText: "Forbidden", headers: {} });
  await assert.rejects(() => getRepoMeta("o", "r", null), /GitHub API error: 403/);
});

await test("getRepoMeta: 404 gives a repo-not-found message", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 404 });
  await assert.rejects(() => getRepoMeta("o", "r", null), /not found \(404\)/);
});

await test("getRepoMeta: 429 gives a secondary-rate-limit message", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 429 });
  await assert.rejects(() => getRepoMeta("o", "r", null), /throttling requests/);
});

await test("getRepoMeta: success returns the parsed JSON body as-is", async () => {
  globalThis.fetch = async () => jsonResponse({ full_name: "o/r", stargazers_count: 5 });
  const meta = await getRepoMeta("o", "r", null);
  assert.equal(meta.full_name, "o/r");
  assert.equal(meta.stargazers_count, 5);
});

await test("getRepoMeta: an unauthenticated call (token=null) sends no Authorization header, so public repos work with no token", async () => {
  let capturedHeaders;
  globalThis.fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return jsonResponse({});
  };
  await getRepoMeta("o", "r", null);
  assert.equal(capturedHeaders.Authorization, undefined);
});

// ---------------- getLatestCommit ----------------

await test("getLatestCommit: returns sha + commitDate from the first commit", async () => {
  globalThis.fetch = async () =>
    jsonResponse([{ sha: "abc123", commit: { committer: { date: "2026-06-01T00:00:00Z" } } }]);
  const result = await getLatestCommit("o", "r", null);
  assert.deepEqual(result, { sha: "abc123", commitDate: "2026-06-01T00:00:00Z" });
});

await test("getLatestCommit: falls back to author date when committer date is missing", async () => {
  globalThis.fetch = async () =>
    jsonResponse([{ sha: "abc123", commit: { author: { date: "2026-05-01T00:00:00Z" } } }]);
  const result = await getLatestCommit("o", "r", null);
  assert.equal(result.commitDate, "2026-05-01T00:00:00Z");
});

await test("getLatestCommit: no commits at all throws a clear error", async () => {
  globalThis.fetch = async () => jsonResponse([]);
  await assert.rejects(() => getLatestCommit("o", "r", null), /No commits found/);
});

await test("getLatestCommit: a 401 on this endpoint is also a GitHubAuthError (shared ghFetch path)", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(() => getLatestCommit("o", "r", "expired"), (e) => e instanceof GitHubAuthError);
});

// ---------------- getMostRecentlyPushedRepo ----------------

await test("getMostRecentlyPushedRepo: normalizes the first repo in the sorted response", async () => {
  globalThis.fetch = async () =>
    jsonResponse([
      {
        full_name: "me/most-recent",
        description: "desc",
        language: "JavaScript",
        private: true,
        pushed_at: "2026-07-01T00:00:00Z",
        html_url: "https://github.com/me/most-recent",
      },
    ]);
  const repo = await getMostRecentlyPushedRepo("token");
  assert.deepEqual(repo, {
    fullName: "me/most-recent",
    description: "desc",
    language: "JavaScript",
    isPrivate: true,
    pushedAt: "2026-07-01T00:00:00Z",
    htmlUrl: "https://github.com/me/most-recent",
  });
});

await test("getMostRecentlyPushedRepo: an empty account (no repos) returns null, not a throw", async () => {
  globalThis.fetch = async () => jsonResponse([]);
  assert.equal(await getMostRecentlyPushedRepo("token"), null);
});

await test("getMostRecentlyPushedRepo: missing description/language normalize to null, not undefined", async () => {
  globalThis.fetch = async () => jsonResponse([{ full_name: "me/r", private: false, pushed_at: null }]);
  const repo = await getMostRecentlyPushedRepo("token");
  assert.equal(repo.description, null);
  assert.equal(repo.language, null);
});

await test("getMostRecentlyPushedRepo: an expired token surfaces as GitHubAuthError", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(() => getMostRecentlyPushedRepo("expired"), (e) => e instanceof GitHubAuthError);
});

// ---------------- ghGraphQL ----------------

await test("ghGraphQL: a missing token fails fast with a generic Error (not GitHubAuthError), no network call made", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(
    () => ghGraphQL("query{}", {}, null),
    (e) => !(e instanceof GitHubAuthError) && /needs a GitHub token/.test(e.message)
  );
  assert.equal(called, false, "no fetch should fire when there's no token to send at all");
});

await test("ghGraphQL: a 401 HTTP status throws GitHubAuthError", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(() => ghGraphQL("query{}", {}, "expired"), (e) => e instanceof GitHubAuthError);
});

await test("ghGraphQL: a 200 response with a 'Bad credentials' errors[] entry is ALSO caught as GitHubAuthError", async () => {
  // GitHub's GraphQL API sometimes reports bad credentials inside a 200 +
  // errors[] body instead of an HTTP 401 — this is exactly the shape that
  // would otherwise slip through as an unhelpful generic GraphQL error.
  globalThis.fetch = async () =>
    jsonResponse({ errors: [{ message: "Bad credentials" }] }, { ok: true, status: 200 });
  await assert.rejects(() => ghGraphQL("query{}", {}, "expired"), (e) => e instanceof GitHubAuthError);
});

await test("ghGraphQL: an unrelated GraphQL error (not auth-shaped) stays a generic Error", async () => {
  globalThis.fetch = async () =>
    jsonResponse({ errors: [{ message: "Something exploded, unrelated to auth" }] }, { ok: true, status: 200 });
  await assert.rejects(
    () => ghGraphQL("query{}", {}, "token"),
    (e) => !(e instanceof GitHubAuthError) && /Something exploded/.test(e.message)
  );
});

await test("ghGraphQL: a non-401 non-OK HTTP status throws a generic Error", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" });
  await assert.rejects(() => ghGraphQL("query{}", {}, "token"), /GitHub GraphQL error: 500/);
});

await test("ghGraphQL: success returns body.data and sends the token as a Bearer header", async () => {
  let capturedHeaders, capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    capturedBody = JSON.parse(opts.body);
    return jsonResponse({ data: { viewer: { login: "octocat" } } });
  };
  const data = await ghGraphQL("query{ viewer { login } }", { from: "x" }, "my-token");
  assert.equal(data.viewer.login, "octocat");
  assert.equal(capturedHeaders.Authorization, "Bearer my-token");
  assert.deepEqual(capturedBody.variables, { from: "x" });
});

globalThis.fetch = originalFetch;

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;