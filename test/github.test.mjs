// test/github.test.mjs
// Tests for lib/github.js. Rewritten for the current API: the old
// getMostRecentlyPushedRepo was replaced by getRecentlyPushedRepos (plural),
// and listUserRepos / request hardening (deadline, retry, path safety) are
// covered here too.
//
// Run with: node test/github.test.mjs

import assert from "node:assert/strict";
import {
  parseRepoInput,
  getRepoMeta,
  getLatestCommit,
  getRecentlyPushedRepos,
  listUserRepos,
  ghGraphQL,
  GitHubAuthError,
} from "../lib/github.js";
import { netConfig, NetworkError } from "../lib/net.js";

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
const originalNetConfig = { ...netConfig };
netConfig.baseDelayMs = 1; // retry paths run instantly

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

await test("parseRepoInput: a deep link (tree/branch) and a query/fragment still resolve to owner/repo", () => {
  assert.deepEqual(parseRepoInput("https://github.com/o/r/tree/main"), { owner: "o", repo: "r" });
  assert.deepEqual(parseRepoInput("https://github.com/o/r?tab=readme#top"), { owner: "o", repo: "r" });
});

await test("parseRepoInput: throws a clear error on unparseable input", () => {
  assert.throws(() => parseRepoInput("not a repo at all"), /Couldn't parse/);
  assert.throws(() => parseRepoInput(""), /Couldn't parse/);
  assert.throws(() => parseRepoInput(null), /Couldn't parse/);
});

await test("parseRepoInput: rejects names that could alter the request path", () => {
  assert.throws(() => parseRepoInput("o/.."), /Couldn't parse/);
  assert.throws(() => parseRepoInput("../r"), /Couldn't parse/);
  assert.throws(() => parseRepoInput("o/r%2Fx"), /Couldn't parse/);
  assert.throws(() => parseRepoInput("o/r@evil"), /Couldn't parse/);
});

// ---------------- request construction ----------------

await test("getRepoMeta: owner/repo are validated again at the request boundary and never reach fetch if invalid", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(() => getRepoMeta("../x", "r", "tok"), /Invalid repository name/);
  await assert.rejects(() => getRepoMeta("o", "r/../../user", "tok"), /Invalid repository name/);
  assert.equal(called, false, "an invalid name must be rejected before any request carrying the token is sent");
});

await test("getRepoMeta: hits /repos/{owner}/{repo} and pins the REST API version", async () => {
  let url, headers;
  globalThis.fetch = async (u, opts) => { url = u; headers = opts.headers; return jsonResponse({}); };
  await getRepoMeta("octo", "hello.world", null);
  assert.equal(url, "https://api.github.com/repos/octo/hello.world");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
});

await test("getRepoMeta: every request carries a deadline signal", async () => {
  let signal;
  globalThis.fetch = async (u, opts) => { signal = opts.signal; return jsonResponse({}); };
  await getRepoMeta("o", "r", null);
  assert.ok(signal && typeof signal.aborted === "boolean", "fetch must receive an AbortSignal");
});

// ---------------- ghFetch status-code branches ----------------

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

await test("getRepoMeta: 403 WITHOUT remaining=0 falls through to the generic error", async () => {
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

await test("getRepoMeta: an unauthenticated call (token=null) sends no Authorization header", async () => {
  let capturedHeaders;
  globalThis.fetch = async (url, opts) => { capturedHeaders = opts.headers; return jsonResponse({}); };
  await getRepoMeta("o", "r", null);
  assert.equal(capturedHeaders.Authorization, undefined);
});

// ---------------- retry / timeout behavior ----------------

await test("GET: a 5xx is retried once and the retry's success is returned", async () => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? jsonResponse({}, { ok: false, status: 502, statusText: "Bad Gateway" }) : jsonResponse({ full_name: "o/r" }));
  const meta = await getRepoMeta("o", "r", null);
  assert.equal(calls, 2);
  assert.equal(meta.full_name, "o/r");
});

await test("GET: a persistent 5xx is retried exactly once, then reported", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse({}, { ok: false, status: 503, statusText: "Service Unavailable" }); };
  await assert.rejects(() => getRepoMeta("o", "r", null), /GitHub API error: 503/);
  assert.equal(calls, 2);
});

await test("GET: a network failure is retried once, then surfaces as NetworkError", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed"); };
  await assert.rejects(() => getRepoMeta("o", "r", null), (e) => e instanceof NetworkError);
  assert.equal(calls, 2);
});

await test("GET: 401, 403-rate-limit, 404 and 429 are NEVER retried", async () => {
  for (const status of [401, 404, 429]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return jsonResponse({}, { ok: false, status }); };
    await assert.rejects(() => getRepoMeta("o", "r", "t"));
    assert.equal(calls, 1, `status ${status} must not be retried`);
  }
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse({}, { ok: false, status: 403, headers: { "x-ratelimit-remaining": "0" } }); };
  await assert.rejects(() => getRepoMeta("o", "r", "t"));
  assert.equal(calls, 1);
});

await test("a request that never answers is aborted at the deadline and reported as NetworkError", async () => {
  const saved = { ...netConfig };
  netConfig.timeoutMs = 20;
  netConfig.retries = 0;
  globalThis.fetch = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const keepAlive = setTimeout(() => {}, 5000); // AbortSignal.timeout's timer is unref'd; keep Node alive for the test
  try {
    await assert.rejects(() => getRepoMeta("o", "r", null), (e) => e instanceof NetworkError && /didn't respond in time/.test(e.message));
  } finally {
    clearTimeout(keepAlive);
    Object.assign(netConfig, saved);
  }
});

// ---------------- getLatestCommit ----------------

await test("getLatestCommit: returns sha + commitDate from the first commit", async () => {
  globalThis.fetch = async () => jsonResponse([{ sha: "abc123", commit: { committer: { date: "2026-06-01T00:00:00Z" } } }]);
  assert.deepEqual(await getLatestCommit("o", "r", null), { sha: "abc123", commitDate: "2026-06-01T00:00:00Z" });
});

await test("getLatestCommit: falls back to author date when committer date is missing", async () => {
  globalThis.fetch = async () => jsonResponse([{ sha: "abc123", commit: { author: { date: "2026-05-01T00:00:00Z" } } }]);
  assert.equal((await getLatestCommit("o", "r", null)).commitDate, "2026-05-01T00:00:00Z");
});

await test("getLatestCommit: no commits at all throws a clear error", async () => {
  globalThis.fetch = async () => jsonResponse([]);
  await assert.rejects(() => getLatestCommit("o", "r", null), /No commits found/);
});

await test("getLatestCommit: a 401 is also a GitHubAuthError (shared ghFetch path)", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(() => getLatestCommit("o", "r", "expired"), (e) => e instanceof GitHubAuthError);
});

// ---------------- getRecentlyPushedRepos ----------------

await test("getRecentlyPushedRepos: normalizes to the compact row shape, up to `count` repos", async () => {
  globalThis.fetch = async () =>
    jsonResponse([
      { full_name: "me/a", private: true, pushed_at: "2026-07-03T00:00:00Z", html_url: "https://github.com/me/a", description: "ignored" },
      { full_name: "me/b", private: false, pushed_at: "2026-07-02T00:00:00Z", html_url: "https://github.com/me/b" },
      { full_name: "me/c", private: false, pushed_at: "2026-07-01T00:00:00Z", html_url: "https://github.com/me/c" },
      { full_name: "me/d", private: false, pushed_at: "2026-06-01T00:00:00Z", html_url: "https://github.com/me/d" },
    ]);
  const repos = await getRecentlyPushedRepos("token", 3);
  assert.equal(repos.length, 3);
  assert.deepEqual(repos[0], { fullName: "me/a", isPrivate: true, pushedAt: "2026-07-03T00:00:00Z", htmlUrl: "https://github.com/me/a" });
});

await test("getRecentlyPushedRepos: requests per_page=count sorted by pushed, and clamps absurd counts", async () => {
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return jsonResponse([]); };
  await getRecentlyPushedRepos("t", 3);
  await getRecentlyPushedRepos("t", 9999);
  await getRecentlyPushedRepos("t", "nope");
  assert.match(urls[0], /\/user\/repos\?sort=pushed&direction=desc&per_page=3$/);
  assert.match(urls[1], /per_page=100$/);
  assert.match(urls[2], /per_page=3$/);
});

await test("getRecentlyPushedRepos: an empty account or a non-array body returns [] (no throw)", async () => {
  globalThis.fetch = async () => jsonResponse([]);
  assert.deepEqual(await getRecentlyPushedRepos("t"), []);
  globalThis.fetch = async () => jsonResponse({ message: "weird" });
  assert.deepEqual(await getRecentlyPushedRepos("t"), []);
});

await test("getRecentlyPushedRepos: missing pushed_at/html_url normalize to null, not undefined", async () => {
  globalThis.fetch = async () => jsonResponse([{ full_name: "me/r", private: false }]);
  const [repo] = await getRecentlyPushedRepos("t");
  assert.equal(repo.pushedAt, null);
  assert.equal(repo.htmlUrl, null);
});

await test("getRecentlyPushedRepos: an expired token surfaces as GitHubAuthError", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(() => getRecentlyPushedRepos("expired"), (e) => e instanceof GitHubAuthError);
});

// ---------------- listUserRepos ----------------

await test("listUserRepos: requires a token and makes no request without one", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse([]); };
  await assert.rejects(() => listUserRepos(null), /needs a GitHub token/);
  assert.equal(called, false);
});

await test("listUserRepos: maps the picker fields and reads hasNextPage from the Link header", async () => {
  globalThis.fetch = async () =>
    jsonResponse(
      [{ full_name: "me/x", name: "x", private: true, description: "d", language: "Go", stargazers_count: 3, pushed_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/me/x" }],
      { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=9>; rel="last"' } }
    );
  const res = await listUserRepos("t", { page: 1, perPage: 30 });
  assert.equal(res.hasNextPage, true);
  assert.equal(res.page, 1);
  assert.deepEqual(res.repos[0], {
    fullName: "me/x", name: "x", isPrivate: true, description: "d", language: "Go",
    stars: 3, pushedAt: "2026-01-01T00:00:00Z", htmlUrl: "https://github.com/me/x",
  });
});

await test("listUserRepos: no Link header, or a Link with only prev/last, means NO next page", async () => {
  globalThis.fetch = async () => jsonResponse([]);
  assert.equal((await listUserRepos("t")).hasNextPage, false);
  globalThis.fetch = async () => jsonResponse([], { headers: { link: '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="last"' } });
  assert.equal((await listUserRepos("t", { page: 3 })).hasNextPage, false);
});

await test("listUserRepos: owner-only, alphabetical, and page/perPage are sanitized into the URL", async () => {
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return jsonResponse([]); };
  await listUserRepos("t", { page: 2, perPage: 50 });
  await listUserRepos("t", { page: -5, perPage: 100000 });
  assert.match(urls[0], /affiliation=owner&sort=full_name&direction=asc&per_page=50&page=2$/);
  assert.match(urls[1], /per_page=100&page=1$/);
});

await test("listUserRepos: a 401 surfaces as GitHubAuthError", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(() => listUserRepos("expired"), (e) => e instanceof GitHubAuthError);
});

// ---------------- ghGraphQL ----------------

await test("ghGraphQL: a missing token fails fast with a generic Error, no network call made", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  await assert.rejects(() => ghGraphQL("query{}", {}, null), (e) => !(e instanceof GitHubAuthError) && /needs a GitHub token/.test(e.message));
  assert.equal(called, false);
});

await test("ghGraphQL: a 401 HTTP status throws GitHubAuthError", async () => {
  globalThis.fetch = async () => jsonResponse({}, { ok: false, status: 401 });
  await assert.rejects(() => ghGraphQL("query{}", {}, "expired"), (e) => e instanceof GitHubAuthError);
});

await test("ghGraphQL: a 200 with a 'Bad credentials' errors[] entry is ALSO caught as GitHubAuthError", async () => {
  globalThis.fetch = async () => jsonResponse({ errors: [{ message: "Bad credentials" }] });
  await assert.rejects(() => ghGraphQL("query{}", {}, "expired"), (e) => e instanceof GitHubAuthError);
});

await test("ghGraphQL: an unrelated GraphQL error stays a generic Error", async () => {
  globalThis.fetch = async () => jsonResponse({ errors: [{ message: "Something exploded, unrelated to auth" }] });
  await assert.rejects(() => ghGraphQL("query{}", {}, "token"), (e) => !(e instanceof GitHubAuthError) && /Something exploded/.test(e.message));
});

await test("ghGraphQL: a non-401 non-OK HTTP status throws a generic Error and is NOT retried (POST)", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse({}, { ok: false, status: 500, statusText: "Internal Server Error" }); };
  await assert.rejects(() => ghGraphQL("query{}", {}, "token"), /GitHub GraphQL error: 500/);
  assert.equal(calls, 1, "a POST must never be auto-retried");
});

await test("ghGraphQL: a network failure is reported once as NetworkError, not retried", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed"); };
  await assert.rejects(() => ghGraphQL("query{}", {}, "token"), (e) => e instanceof NetworkError);
  assert.equal(calls, 1);
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
Object.assign(netConfig, originalNetConfig);

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
