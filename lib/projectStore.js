// lib/projectStore.js
// Tab 2's tracked-repo store. Same pin/check/history model as before, plus
// `repoMeta` — additive, migration-safe — so repo cards can show real data
// (description, language, stars, public/private, last pushed) instead of
// just a SHA-tracking row.
//
// This pass: added MAX_TRACKED (10) — a ceiling on the total number of
// tracked repos, independent of MAX_PINNED (4). Pinning stays a curated
// subset within that larger tracked list; see create() below for the
// enforcement point.

const STORAGE_KEY = "projects";
export const MAX_PINNED = 4;
export const MAX_TRACKED = 10;
export const MAX_HISTORY = 6;

function emptyProject(name, repo) {
  return {
    name,
    repo,
    lastCheckedAt: null,
    commitHistory: [],
    pinned: false,
    repoMeta: null,
  };
}

function withDefaults(p) {
  const commitHistory = p.commitHistory || [];
  return {
    ...p,
    commitHistory,
    lastCheckedAt: p.lastCheckedAt || null,
    pinned: !!p.pinned,
    repoMeta: p.repoMeta || null, // migration-safe default for projects saved before this field existed
    lastCommitAt: commitHistory[0]?.commitDate ?? null,
  };
}

export function createProjectStore(adapter) {
  async function getAll() {
    const data = await adapter.get([STORAGE_KEY]);
    return data[STORAGE_KEY] || {};
  }

  async function saveAll(projects) {
    await adapter.set({ [STORAGE_KEY]: projects });
  }

  async function list() {
    const projects = await getAll();
    return Object.entries(projects).map(([id, p]) => ({ id, ...withDefaults(p) }));
  }

  async function get(id) {
    const projects = await getAll();
    return projects[id] ? { id, ...withDefaults(projects[id]) } : null;
  }

  /**
   * Creates a new tracked repo. Rejects a duplicate id, and rejects the
   * 11th tracked repo — MAX_TRACKED is a ceiling on the whole list, wholly
   * separate from MAX_PINNED (the smaller "pin to top" curated subset
   * within it). Checked before the id-collision write, not after, so a
   * rejected create never touches storage.
   */
  async function create(id, name, repo) {
    const projects = await getAll();
    if (projects[id]) throw new Error(`Project id "${id}" already exists.`);
    if (Object.keys(projects).length >= MAX_TRACKED) {
      throw new Error(`You can track up to ${MAX_TRACKED} repos. Remove one first.`);
    }
    projects[id] = emptyProject(name, repo);
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  async function remove(id) {
    const projects = await getAll();
    delete projects[id];
    await saveAll(projects);
  }

  async function updateLastChecked(id) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);
    projects[id] = { ...existing, lastCheckedAt: new Date().toISOString() };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  /**
   * Appends a commit-history entry unless the new SHA genuinely matches the
   * most recent recorded one. Defensive per the reliability rules: a
   * missing/null SHA on either side is NEVER treated as a match — only a
   * real, non-null equality counts as "no change." The safe failure mode
   * is always "record it as changed," never "assume nothing changed."
   */
  async function addCommitHistoryEntry(id, { sha, commitDate }) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);

    const history = existing.commitHistory || [];
    const topSha = history[0]?.sha || null;
    const isGenuineMatch = !!sha && !!topSha && sha === topSha;

    if (isGenuineMatch) {
      return { id, ...withDefaults(existing) };
    }

    const newHistory = [{ sha: sha || null, commitDate: commitDate || null }, ...history].slice(0, MAX_HISTORY);
    projects[id] = { ...existing, commitHistory: newHistory };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  /**
   * Stores a snapshot of repo metadata (description, language, stars,
   * private/public, pushed_at) for card display. Purely additive — never
   * read by the pin/sort/history logic above, so it can fail or be skipped
   * without affecting change-tracking correctness.
   */
  async function updateRepoMeta(id, meta) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);
    projects[id] = {
      ...existing,
      repoMeta: {
        description: meta.description || null,
        language: meta.language || null,
        stars: typeof meta.stargazers_count === "number" ? meta.stargazers_count : null,
        isPrivate: !!meta.private,
        pushedAt: meta.pushed_at || null,
      },
    };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  async function setPinned(id, pinned) {
    const projects = await getAll();
    const existing = projects[id];
    if (!existing) throw new Error(`Unknown project: ${id}`);

    if (pinned && !existing.pinned) {
      const pinnedCount = Object.values(projects).filter((p) => p.pinned).length;
      if (pinnedCount >= MAX_PINNED) {
        throw new Error(`You can pin up to ${MAX_PINNED} projects. Unpin one first.`);
      }
    }

    projects[id] = { ...existing, pinned: !!pinned };
    await saveAll(projects);
    return { id, ...withDefaults(projects[id]) };
  }

  return { list, get, create, remove, updateLastChecked, addCommitHistoryEntry, updateRepoMeta, setPinned };
}