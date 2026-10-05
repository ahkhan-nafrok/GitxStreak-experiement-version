// lib/github.js
// Thin read-only wrapper around the GitHub REST API, plus a thin GraphQL
// wrapper (ghGraphQL) used by Pulse. No writes anywhere. A token raises the
// REST rate limit from 60/hr to 5,000/hr and is required for GraphQL and for
// any private repo.
//
// Hardening pass:
//   - Every request has a deadline (lib/net.js); GETs retry once on a
//     network error/timeout/5xx. POSTs (GraphQL) are never auto-retried.
//   - Owner/repo names are validated against GitHub's real character set and
//     percent-encoded into the URL path, so no caller can inject path
//     segments ("../", "?", "#") into a request that carries the token.
//   - Requests pin the REST API version so a future default change on
//     GitHub's side can't silently reshape responses.
//   - getRecentlyPushedRepos (plural) replaced the old single-repo
//     getMostRecentlyPushedRepo; listUserRepos is the paginated picker fetch.

import { fetchWithTimeout, fetchGetWithRetry } from "./net.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const API_VERSION = "2022-11-28";
const NAME_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/** Thrown specifically for a 401 (bad credentials) response — distinct from
 * rate-limit/network/not-found errors so callers can offer a "reconnect"
 * path instead of a generic error message. */
export class GitHubAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

function isValidNamePair(owner, repo) {
  return (
    NAME_SEGMENT.test(owner) &&
    NAME_SEGMENT.test(repo) &&
    owner !== "." && owner !== ".." &&
    repo !== "." && repo !== ".."
  );
}

export function parseRepoInput(input) {
  const trimmed = String(input ?? "")
    .trim()
    .split(/[?#]/)[0]
    .replace(/\/$/, "")
    .replace(/\.git$/, "");

  let owner = null;
  let repo = null;
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (urlMatch) {
    owner = urlMatch[1];
    repo = urlMatch[2];
  } else {
    const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (shorthand) {
      owner = shorthand[1];
      repo = shorthand[2];
    }
  }

  if (owner && repo && isValidNamePair(owner, repo)) return { owner, repo };

  throw new Error("Couldn't parse that as a repo. Use 'owner/repo' or a full github.com URL.");
}

/** Lowercased "owner/repo" identity for any accepted repo input, or null if
 * it can't be parsed. Two inputs name the same repo iff their keys match. */
export function repoKeyOf(input) {
  try {
    const { owner, repo } = parseRepoInput(input);
    return `${owner}/${repo}`.toLowerCase();
  } catch {
    return null;
  }
}

/** An Error that remembers the HTTP status that caused it. */
function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function repoPath(owner, repo) {
  if (!isValidNamePair(String(owner), String(repo))) {
    throw new Error("Invalid repository name.");
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Does the actual fetch + status-code handling, returns the raw Response so
 * callers that need headers (pagination) can read them. Every JSON-consuming
 * caller goes through ghFetch below instead.
 */
async function ghFetchRaw(path, token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": API_VERSION };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetchGetWithRetry(`${GITHUB_API}${path}`, { headers });

  if (res.status === 401) {
    throw new GitHubAuthError("GitHub rejected this token — it may have expired or been revoked.");
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
      throw httpError(
        `GitHub rate limit hit. Resets at ${resetDate}. Add a personal access token in Settings to raise the limit to 5,000/hr.`,
        403
      );
    }
  }
  if (res.status === 404) {
    throw httpError("Repo, branch, or file not found (404) — check the owner/repo name, and that it's public or your token can see it.", 404);
  }
  if (res.status === 429) {
    throw httpError(
      "GitHub is throttling requests right now (secondary rate limit — too many requests too fast). Wait a moment before retrying.",
      429
    );
  }
  if (!res.ok) {
    throw httpError(`GitHub API error: ${res.status} ${res.statusText}`, res.status);
  }
  return res;
}

async function ghFetch(path, token) {
  const res = await ghFetchRaw(path, token);
  return res.json();
}

/** Full repo metadata — used for the Tab 2 repo card fields (description,
 * language, stars, private/public, pushed_at). */
export async function getRepoMeta(owner, repo, token) {
  return ghFetch(repoPath(owner, repo), token);
}

/**
 * Lightweight single-call fetch of the latest commit on the repo's default
 * branch. Used by Tab 2's "Check for Updates" — deliberately decoupled from
 * getRepoMeta so a plain SHA check and a full metadata refresh can be
 * requested independently.
 */
export async function getLatestCommit(owner, repo, token) {
  let data;
  try {
    data = await ghFetch(`${repoPath(owner, repo)}/commits?per_page=1`, token);
  } catch (e) {
    // GitHub answers 409 for a repo with no commits at all.
    if (e?.status === 409) throw new Error("This repo has no commits yet — there's nothing to track until its first push.");
    throw e;
  }
  const commit = Array.isArray(data) ? data[0] : null;
  if (!commit) throw new Error("No commits found for this repo.");
  return {
    sha: commit.sha,
    commitDate: commit.commit?.committer?.date || commit.commit?.author?.date || null,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * The `count` most recently pushed repos across the authenticated account —
 * powers Pulse's "Last Pushed" section. Returns [] rather than throwing if
 * the account genuinely has no repos. Only the fields the compact row
 * renders are kept.
 */
export async function getRecentlyPushedRepos(token, count = 3) {
  const n = clampInt(count, 1, 100, 3);
  const data = await ghFetch(`/user/repos?sort=pushed&direction=desc&per_page=${n}`, token);
  if (!Array.isArray(data)) return [];
  return data.slice(0, n).map((repo) => ({
    fullName: repo.full_name,
    isPrivate: !!repo.private,
    pushedAt: repo.pushed_at || null,
    htmlUrl: repo.html_url || null,
  }));
}

/** True if the `Link` response header contains a rel="next" entry. */
function parseHasNextPage(linkHeader) {
  if (!linkHeader) return false;
  return /<[^>]+>;\s*rel="next"/i.test(linkHeader);
}

/**
 * Paginated browse of the authenticated account's own repos (owned only),
 * sorted alphabetically so paging is stable. `hasNextPage` comes from
 * GitHub's `Link` header (rel="next"), the only reliable signal without an
 * extra request. Requires a token.
 */
export async function listUserRepos(token, { page = 1, perPage = 30 } = {}) {
  if (!token) {
    throw new Error("This needs a GitHub token — connect one in Settings.");
  }
  const p = clampInt(page, 1, 10000, 1);
  const pp = clampInt(perPage, 1, 100, 30);
  const res = await ghFetchRaw(
    `/user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=${pp}&page=${p}`,
    token
  );
  const data = await res.json();
  const hasNextPage = parseHasNextPage(res.headers.get("link"));

  const repos = Array.isArray(data)
    ? data.map((repo) => ({
        fullName: repo.full_name,
        name: repo.name,
        isPrivate: !!repo.private,
        description: repo.description || null,
        language: repo.language || null,
        stars: typeof repo.stargazers_count === "number" ? repo.stargazers_count : null,
        pushedAt: repo.pushed_at || null,
        htmlUrl: repo.html_url || null,
      }))
    : [];

  return { repos, hasNextPage, page: p };
}

/**
 * POST-based GraphQL call. GitHub's GraphQL API has no unauthenticated tier,
 * so a missing token fails fast instead of making a call guaranteed to 401.
 * Deadline applies; never auto-retried (a POST isn't assumed repeatable).
 */
export async function ghGraphQL(query, variables, token) {
  if (!token) {
    throw new Error("This needs a GitHub token — add one in Settings.");
  }

  const res = await fetchWithTimeout(
    GITHUB_GRAPHQL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    },
    20000
  );

  if (res.status === 401) {
    throw new GitHubAuthError("GitHub rejected this token — it may have expired or been revoked.");
  }
  if (!res.ok) {
    throw new Error(`GitHub GraphQL error: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  if (body.errors && body.errors.length) {
    const isAuthError = body.errors.some((e) => /bad credentials|require.*authentication/i.test(e.message || ""));
    if (isAuthError) {
      throw new GitHubAuthError("GitHub rejected this token — it may have expired or been revoked.");
    }
    throw new Error(`GitHub GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}
