// lib/projectStore.js
// Tab 2's tracked-repo store: pin/check/history model plus `repoMeta`.
//
// Hardening pass — serialized writes. Every mutation is a read-modify-write
// of ONE storage key ("projects") with awaits in between. Two overlapping
// mutations (a double-tapped picker row, a check finishing while an add is
// running) would each read the same snapshot and the later write would erase
// the earlier one — including bypassing MAX_TRACKED / MAX_PINNED, because
// those caps are checked against the stale snapshot. All mutations now run
// through one promise queue per storage adapter, so each sees the previous
// one's result. The queue is keyed by adapter object (WeakMap), so every
// store instance sharing the real chromeStorageAdapter shares one queue.
// Reads (list/get) don't queue.

import { repoKeyOf } from "./github.js";

const STORAGE_KEY = "projects";
export const MAX_PINNED = 4;
export const MAX_TRACKED = 10;
export const MAX_HISTORY = 6;

const queues = new WeakMap();

function enqueueFor(adapter, task) {
  const tail = queues.get(adapter) || Promise.resolve();
  const run = tail.then(task);
  queues.set(adapter, run.catch(() => {})); // a failed task must not poison the queue
  return run;
}

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
  const mutate = (task) => enqueueFor(adapter, task);

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
   * Creates a new tracked repo. Rejects a duplicate id, a repo that is
   * already tracked under any other id/name, and rejects the 11th
   * tracked repo — MAX_TRACKED is a ceiling on the whole list, separate from
   * MAX_PINNED. Checked inside the write queue, so the cap holds even under
   * concurrent creates.
   */
  function create(id, name, repo) {
    return mutate(async () => {
      const projects = await getAll();
      if (projects[id]) throw new Error(`Project id "${id}" already exists.`);
      const key = repoKeyOf(repo);
      if (key && Object.values(projects).some((p) => repoKeyOf(p?.repo) === key)) {
        throw new Error(`You're already tracking ${repo}.`);
      }
      if (Object.keys(projects).length >= MAX_TRACKED) {
        throw new Error(`You can track up to ${MAX_TRACKED} repos. Remove one first.`);
      }
      projects[id] = emptyProject(name, repo);
      await saveAll(projects);
      return { id, ...withDefaults(projects[id]) };
    });
  }

  function remove(id) {
    return mutate(async () => {
      const projects = await getAll();
      delete projects[id];
      await saveAll(projects);
    });
  }

  /**
   * Removes every project whose stored repoMeta says it's private. Used on
   * disconnect: without a token those repos can't be checked anymore, and
   * their names shouldn't linger in local storage after the account is
   * disconnected. Returns how many were removed.
   */
  function removePrivate() {
    return mutate(async () => {
      const projects = await getAll();
      const kept = {};
      let removed = 0;
      for (const [id, p] of Object.entries(projects)) {
        if (p?.repoMeta?.isPrivate) removed++;
        else kept[id] = p;
      }
      if (removed > 0) await saveAll(kept);
      return removed;
    });
  }

  function updateLastChecked(id) {
    return mutate(async () => {
      const projects = await getAll();
      const existing = projects[id];
      if (!existing) throw new Error(`Unknown project: ${id}`);
      projects[id] = { ...existing, lastCheckedAt: new Date().toISOString() };
      await saveAll(projects);
      return { id, ...withDefaults(projects[id]) };
    });
  }

  /**
   * Appends a commit-history entry unless the new SHA genuinely matches the
   * most recent recorded one. Defensive: a missing/null SHA on either side
   * is NEVER treated as a match — the safe failure mode is always "record it
   * as changed," never "assume nothing changed."
   */
  function addCommitHistoryEntry(id, { sha, commitDate }) {
    return mutate(async () => {
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
    });
  }

  /**
   * Stores a snapshot of repo metadata for card display. Purely additive —
   * never read by the pin/sort/history logic, so it can fail or be skipped
   * without affecting change-tracking correctness.
   */
  function updateRepoMeta(id, meta) {
    return mutate(async () => {
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
    });
  }

  function setPinned(id, pinned) {
    return mutate(async () => {
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
    });
  }

  return { list, get, create, remove, removePrivate, updateLastChecked, addCommitHistoryEntry, updateRepoMeta, setPinned };
}
