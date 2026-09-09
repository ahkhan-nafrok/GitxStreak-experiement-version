// lib/github.js
// Thin read-only wrapper around the GitHub REST API, plus a thin GraphQL
// wrapper (ghGraphQL) used by Pulse for the contribution calendar. No
// writes anywhere. An optional token raises the REST rate limit from
// 60/hr to 5,000/hr and is required for GraphQL and for any private repo.
//
// This pass: added listUserRepos, a paginated browse of the authenticated
// account's own repos, for Projects' "Add from GitHub" picker. This needed
// splitting ghFetch into ghFetchRaw (returns the Response, so callers can
// read headers) + ghFetch (unwraps it to JSON, unchanged behavior for every
// existing caller) — GitHub signals "is there a next page" via the `Link`
// response header, not the JSON body, so a plain ghFetch couldn't expose it.
//
// Prior pass: added GitHubAuthError, a distinguishable error type thrown
// on a 401 (bad/expired/revoked token) from either the REST or GraphQL
// path. Callers (pulseView.js, projectsView.js) use `instanceof
// GitHubAuthError` to branch "your token stopped working" UX away from
// generic network/rate-limit errors, without this file touching storage
// or UI itself — it only throws a typed error, same as before.
//
// Also: getRecentlyPushedRepos (plural, default count=3) powers Pulse's
// "Last Pushed" section — trimmed to just what that compact row renders
// (fullName, isPrivate, pushedAt, htmlUrl). listUserRepos below is a
// separate, richer fetch (full repoMeta fields) for the picker's browsing
// use case — deliberately not merged into one function since they serve
// different UIs with different field needs and different paging behavior.

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

/** Thrown specifically for a 401 (bad credentials) response — distinct
 * from rate-limit/network/not-found errors so callers can offer a
 * "reconnect your token" path instead of a generic error message. */
export class GitHubAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export function parseRepoInput(input) {
  const trimmed = input.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };

  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };

  throw new Error(
    "Couldn't parse that as a repo. Use 'owner/repo' or a full github.com URL."
  );
}

/**
 * Does the actual fetch + status-code handling, returns the raw Response
 * so callers that need headers (pagination) can read them. Every existing
 * JSON-consuming caller goes through ghFetch below instead, unchanged.
 */
async function ghFetchRaw(path, token) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}${path}`, { headers });

  if (res.status === 401) {
    throw new GitHubAuthError(
      "GitHub rejected this token — it may have expired or been revoked."
    );
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetDate = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "soon";
      throw new Error(
        `GitHub rate limit hit. Resets at ${resetDate}. Add a personal access token in Settings to raise the limit to 5,000/hr.`
      );
    }
  }
  if (res.status === 404) {
    throw new Error("Repo, branch, or file not found (404) — check the owner/repo name, and that it's public or your token can see it.");
  }
  if (res.status === 429) {
    throw new Error(
      "GitHub is throttling requests right now (secondary rate limit — too many requests too fast). Wait a moment before retrying."
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }
  return res;
}

async function ghFetch(path, token) {
  const res = await ghFetchRaw(path, token);
  return res.json();
}

/** Full repo metadata — used for both Skeletonizer-era needs and the Tab 2
 * repo card fields (description, language, stars, private/public, pushed_at). */
export async function getRepoMeta(owner, repo, token) {
  return ghFetch(`/repos/${owner}/${repo}`, token);
}

/**
 * Lightweight single-call fetch of the latest commit on the repo's default
 * branch. Used by Tab 2's "Check for Updates" — deliberately decoupled from
 * getRepoMeta so a plain SHA check and a full metadata refresh can be
 * requested independently.
 */
export async function getLatestCommit(owner, repo, token) {
  const data = await ghFetch(`/repos/${owner}/${repo}/commits?per_page=1`, token);
  const commit = Array.isArray(data) ? data[0] : null;
  if (!commit) throw new Error("No commits found for this repo.");
  return {
    sha: commit.sha,
    commitDate: commit.commit?.committer?.date || commit.commit?.author?.date || null,
  };
}

/**
 * The `count` most recently pushed repos across the authenticated account —
 * powers Pulse's "Last Pushed" section. Deliberately account-wide (not
 * limited to Tab 2's manually tracked repos): GitHub's `/user/repos`
 * endpoint, sorted by `pushed`, is the same signal GitHub's own dashboard
 * uses for "recently active." Requires a token (this is only ever called
 * from Pulse, which already requires one for the contribution calendar).
 * Returns [] rather than throwing if the account genuinely has no repos.
 * A single REST call with `per_page=count` — no per-repo follow-up calls.
 * Only the fields the compact list row renders are kept (fullName,
 * isPrivate, pushedAt, htmlUrl) — no description/language/stars.
 */
export async function getRecentlyPushedRepos(token, count = 3) {
  const data = await ghFetch(`/user/repos?sort=pushed&direction=desc&per_page=${count}`, token);
  if (!Array.isArray(data)) return [];
  return data.slice(0, count).map((repo) => ({
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
 * Paginated browse of the authenticated account's own repos (owned only —
 * not repos they merely collaborate on or belong to via an org), for
 * Projects' "Add from GitHub" picker. Sorted alphabetically (full_name) so
 * paging through a large account is stable and predictable rather than
 * shifting under the user as `pushed`/`updated` values change between
 * page fetches. Requires a token — there's no unauthenticated path to a
 * user's own repo list that also includes private ones.
 *
 * Returns richer fields than getRecentlyPushedRepos (description, language,
 * stars) since the picker can pass this straight into
 * projectStore.updateRepoMeta-shaped data on add, skipping a redundant
 * getRepoMeta call for the common case.
 *
 * `hasNextPage` comes from GitHub's `Link` header (rel="next"), not the
 * body — the only reliable way to know if more pages exist without an
 * extra request.
 */
export async function listUserRepos(token, { page = 1, perPage = 30 } = {}) {
  if (!token) {
    throw new Error("This needs a GitHub token — connect one in Settings.");
  }
  const res = await ghFetchRaw(
    `/user/repos?affiliation=owner&sort=full_name&direction=asc&per_page=${perPage}&page=${page}`,
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

  return { repos, hasNextPage, page };
}

/**
 * POST-based GraphQL call, distinct from ghFetch's REST GETs above. GitHub's
 * GraphQL API has no unauthenticated tier at all (unlike REST's 60/hr free
 * tier), so a missing token fails fast with a clear message instead of
 * making a network call that's guaranteed to 401.
 */
export async function ghGraphQL(query, variables, token) {
  if (!token) {
    throw new Error("This needs a GitHub token — add one in Settings.");
  }

  const res = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    throw new GitHubAuthError(
      "GitHub rejected this token — it may have expired or been revoked."
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub GraphQL error: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  if (body.errors && body.errors.length) {
    const isAuthError = body.errors.some((e) =>
      /bad credentials|require.*authentication/i.test(e.message || "")
    );
    if (isAuthError) {
      throw new GitHubAuthError("GitHub rejected this token — it may have expired or been revoked.");
    }
    throw new Error(`GitHub GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}