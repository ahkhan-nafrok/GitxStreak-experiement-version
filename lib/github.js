// lib/github.js
// Thin read-only wrapper around the GitHub REST API, plus a thin GraphQL
// wrapper (ghGraphQL) used by Pulse for the contribution calendar. No
// writes anywhere. An optional token raises the REST rate limit from
// 60/hr to 5,000/hr and is required for GraphQL and for any private repo.
//
// This pass: added GitHubAuthError, a distinguishable error type thrown
// on a 401 (bad/expired/revoked token) from either the REST or GraphQL
// path. Callers (pulseView.js, projectsView.js) use `instanceof
// GitHubAuthError` to branch "your token stopped working" UX away from
// generic network/rate-limit errors, without this file touching storage
// or UI itself — it only throws a typed error, same as before.

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

/** Parse "owner/repo" or a full github.com URL into { owner, repo }. */
export function parseRepoInput(input) {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const urlMatch = trimmed.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2] };

  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };

  throw new Error(
    "Couldn't parse that as a repo. Use 'owner/repo' or a full github.com URL."
  );
}

async function ghFetch(path, token) {
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
 * Single most-recently-pushed repo across the authenticated account —
 * powers Pulse's "Last Pushed" section. Deliberately account-wide (not
 * limited to Tab 2's manually tracked repos): GitHub's `/user/repos`
 * endpoint, sorted by `pushed`, is the same signal GitHub's own dashboard
 * uses for "recently active." Requires a token (this is only ever called
 * from Pulse, which already requires one for the contribution calendar).
 * Returns null rather than throwing if the account genuinely has no repos.
 */
export async function getMostRecentlyPushedRepo(token) {
  const data = await ghFetch(`/user/repos?sort=pushed&direction=desc&per_page=1`, token);
  const repo = Array.isArray(data) ? data[0] : null;
  if (!repo) return null;
  return {
    fullName: repo.full_name,
    description: repo.description || null,
    language: repo.language || null,
    isPrivate: !!repo.private,
    pushedAt: repo.pushed_at || null,
    htmlUrl: repo.html_url || null,
  };
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
    // GraphQL can also report bad-credentials as a 200 + errors[] instead
    // of a 401 status, depending on the failure mode — catch that shape too
    // so an expired token doesn't slip through as a generic GraphQL error.
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