import assert from "node:assert/strict";
import { createProjectStore, MAX_PINNED, MAX_TRACKED, MAX_HISTORY } from "../lib/projectStore.js";

let passed = 0;
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (e) {
    console.error(`FAIL  - ${name}`);
    console.error(`        ${e.message}`);
    process.exitCode = 1;
  }
}

function makeMockAdapter() {
  let store = {};
  return {
    async get(keys) {
      const out = {};
      for (const k of keys) out[k] = store[k];
      return out;
    },
    async set(obj) {
      store = { ...store, ...obj };
    },
    _dump: () => store,
  };
}

await testAsync("projectStore: create then list round-trips correctly", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("aml-motors", "AML Motors", "org/aml-motors");
  const all = await store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "aml-motors");
  assert.equal(all[0].repo, "org/aml-motors");
  assert.equal(all[0].lastCheckedAt, null);
  assert.deepEqual(all[0].commitHistory, []);
  assert.equal(all[0].lastCommitAt, null, "lastCommitAt must be derived as null for empty commitHistory");
  assert.equal(all[0].repoMeta, null, "a brand new project must start with no repoMeta");
});

await testAsync("projectStore: create rejects duplicate ids", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("dup", "Dup", "org/dup");
  await assert.rejects(() => store.create("dup", "Dup", "org/dup"), /already exists/);
});

await testAsync("projectStore: remove deletes the project", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p3", "P3", "org/p3");
  await store.remove("p3");
  assert.equal(await store.get("p3"), null);
});

await testAsync("projectStore: updateLastChecked sets a fresh timestamp unconditionally", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p1", "P1", "org/p1");
  const before = Date.now();
  await store.updateLastChecked("p1");
  const p = await store.get("p1");
  assert.ok(p.lastCheckedAt, "lastCheckedAt must be set");
  assert.ok(new Date(p.lastCheckedAt).getTime() >= before);
  assert.deepEqual(p.commitHistory, [], "updateLastChecked must never touch commitHistory — they're independent facts");
});

await testAsync("projectStore: updateLastChecked overwrites on every call, no matter the outcome", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p1b", "P1b", "org/p1b");
  await store.updateLastChecked("p1b");
  const first = (await store.get("p1b")).lastCheckedAt;
  await new Promise((r) => setTimeout(r, 5));
  await store.updateLastChecked("p1b");
  const second = (await store.get("p1b")).lastCheckedAt;
  assert.notEqual(first, second, "a second check must overwrite the timestamp, not preserve the first one");
});

await testAsync("projectStore: updateLastChecked on unknown id throws", async () => {
  const store = createProjectStore(makeMockAdapter());
  await assert.rejects(() => store.updateLastChecked("ghost"), /Unknown project/);
});

await testAsync("projectStore: addCommitHistoryEntry adds the first entry and derives lastCommitAt", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p2", "P2", "org/p2");
  await store.addCommitHistoryEntry("p2", { sha: "sha1", commitDate: "2026-01-01T00:00:00.000Z" });
  const p = await store.get("p2");
  assert.equal(p.commitHistory.length, 1);
  assert.equal(p.commitHistory[0].sha, "sha1");
  assert.equal(p.lastCommitAt, "2026-01-01T00:00:00.000Z", "lastCommitAt must be derived from commitHistory[0]");
});

await testAsync("projectStore: addCommitHistoryEntry with the SAME sha as the top entry is a no-op", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p3", "P3", "org/p3");
  await store.addCommitHistoryEntry("p3", { sha: "sha1", commitDate: "2026-01-01T00:00:00.000Z" });
  await store.addCommitHistoryEntry("p3", { sha: "sha1", commitDate: "2026-01-01T00:00:00.000Z" });
  const p = await store.get("p3");
  assert.equal(p.commitHistory.length, 1, "an unchanged sha must not be appended again");
});

await testAsync("projectStore: addCommitHistoryEntry with a NEW sha unshifts (newest first)", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p4", "P4", "org/p4");
  await store.addCommitHistoryEntry("p4", { sha: "sha1", commitDate: "2026-01-01T00:00:00.000Z" });
  await store.addCommitHistoryEntry("p4", { sha: "sha2", commitDate: "2026-02-01T00:00:00.000Z" });
  const p = await store.get("p4");
  assert.equal(p.commitHistory.length, 2);
  assert.equal(p.commitHistory[0].sha, "sha2", "newest commit must be first");
  assert.equal(p.commitHistory[1].sha, "sha1");
});

await testAsync(`projectStore: commitHistory is capped at MAX_HISTORY (${MAX_HISTORY}) — FIFO, oldest dropped`, async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p5", "P5", "org/p5");
  for (let i = 1; i <= MAX_HISTORY + 1; i++) {
    await store.addCommitHistoryEntry("p5", { sha: `sha${i}`, commitDate: `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z` });
  }
  const p = await store.get("p5");
  assert.equal(p.commitHistory.length, MAX_HISTORY, `must never exceed ${MAX_HISTORY} entries`);
  assert.equal(p.commitHistory[0].sha, `sha${MAX_HISTORY + 1}`, "newest entry must be present");
  assert.ok(!p.commitHistory.some((h) => h.sha === "sha1"), "the oldest entry (sha1) must have been dropped");
});

await testAsync("projectStore: addCommitHistoryEntry on unknown id throws", async () => {
  const store = createProjectStore(makeMockAdapter());
  await assert.rejects(
    () => store.addCommitHistoryEntry("ghost", { sha: "x", commitDate: null }),
    /Unknown project/
  );
});

await testAsync("projectStore: a missing commitDate is stored as null, not crashing", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p6", "P6", "org/p6");
  await store.addCommitHistoryEntry("p6", { sha: "sha1", commitDate: undefined });
  const p = await store.get("p6");
  assert.equal(p.commitHistory[0].commitDate, null);
});

// --- Regression coverage: the "missing SHA never matches missing SHA" fix ---

await testAsync(
  "projectStore: addCommitHistoryEntry — REGRESSION: two consecutive missing/null SHAs must NOT be treated as a match",
  async () => {
    const store = createProjectStore(makeMockAdapter());
    await store.create("p9", "P9", "org/p9");
    await store.addCommitHistoryEntry("p9", { sha: null, commitDate: "2026-01-01T00:00:00.000Z" });
    await store.addCommitHistoryEntry("p9", { sha: undefined, commitDate: "2026-01-02T00:00:00.000Z" });
    const p = await store.get("p9");
    assert.equal(
      p.commitHistory.length,
      2,
      "two missing-SHA checks must both be recorded as distinct entries — the safe failure mode is 'treat as changed'"
    );
  }
);

await testAsync(
  "projectStore: addCommitHistoryEntry — a genuinely missing SHA followed by a real SHA is recorded as changed",
  async () => {
    const store = createProjectStore(makeMockAdapter());
    await store.create("p10", "P10", "org/p10");
    await store.addCommitHistoryEntry("p10", { sha: null, commitDate: null });
    await store.addCommitHistoryEntry("p10", { sha: "sha-real", commitDate: "2026-01-01T00:00:00.000Z" });
    const p = await store.get("p10");
    assert.equal(p.commitHistory.length, 2);
    assert.equal(p.commitHistory[0].sha, "sha-real");
  }
);

await testAsync(
  "projectStore: addCommitHistoryEntry — only a genuine, equal, non-null SHA match is deduped (positive control)",
  async () => {
    const store = createProjectStore(makeMockAdapter());
    await store.create("p11", "P11", "org/p11");
    await store.addCommitHistoryEntry("p11", { sha: "sha-same", commitDate: "2026-01-01T00:00:00.000Z" });
    await store.addCommitHistoryEntry("p11", { sha: "sha-same", commitDate: "2026-01-01T00:00:00.000Z" });
    const p = await store.get("p11");
    assert.equal(p.commitHistory.length, 1, "a real, equal, non-null sha match is the ONLY case that should dedupe");
  }
);

await testAsync("projectStore: get() on a project stored under the OLD push-based shape still works (migration safety)", async () => {
  const adapter = makeMockAdapter();
  await adapter.set({
    projects: {
      "legacy-project": {
        name: "Legacy",
        repo: "org/legacy",
        lastPushedMarkdown: "## Old\ncontent",
        lastPushedTokens: 500,
        lastPushedAt: "2025-01-01T00:00:00.000Z",
        history: [],
        fileCache: { "a.js": { sha: "x", content: "y" } },
      },
    },
  });
  const store = createProjectStore(adapter);
  const p = await store.get("legacy-project");
  assert.equal(p.name, "Legacy", "existing fields must still read correctly");
  assert.deepEqual(p.commitHistory, [], "a legacy project missing commitHistory must default to an empty array, not crash");
  assert.equal(p.lastCheckedAt, null, "a legacy project missing lastCheckedAt must default to null");
  assert.equal(p.lastCommitAt, null, "derived lastCommitAt must be null when commitHistory is empty");
  assert.equal(p.pinned, false, "a legacy project missing pinned must default to false");
  assert.equal(p.repoMeta, null, "a legacy project missing repoMeta must default to null, not crash");
});

await testAsync("projectStore: addCommitHistoryEntry works correctly on a legacy project with no commitHistory field at all", async () => {
  const adapter = makeMockAdapter();
  await adapter.set({
    projects: {
      legacy2: { name: "Legacy2", repo: "org/legacy2", lastPushedMarkdown: null, lastPushedTokens: 0, lastPushedAt: null, history: [] },
    },
  });
  const store = createProjectStore(adapter);
  await store.addCommitHistoryEntry("legacy2", { sha: "sha1", commitDate: "2026-01-01T00:00:00.000Z" });
  const p = await store.get("legacy2");
  assert.equal(p.commitHistory.length, 1);
  assert.equal(p.commitHistory[0].sha, "sha1");
});

await testAsync("projectStore: a new project starts unpinned", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p7", "P7", "org/p7");
  const p = await store.get("p7");
  assert.equal(p.pinned, false);
});

await testAsync("projectStore: setPinned(true) persists and setPinned(false) unpins", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p8", "P8", "org/p8");
  await store.setPinned("p8", true);
  assert.equal((await store.get("p8")).pinned, true);
  await store.setPinned("p8", false);
  assert.equal((await store.get("p8")).pinned, false);
});

await testAsync(`projectStore: pinning is capped at MAX_PINNED (${MAX_PINNED})`, async () => {
  const store = createProjectStore(makeMockAdapter());
  for (let i = 0; i < MAX_PINNED; i++) {
    await store.create(`pin${i}`, `Pin${i}`, `org/pin${i}`);
    await store.setPinned(`pin${i}`, true);
  }
  await store.create("overflow", "Overflow", "org/overflow");
  await assert.rejects(() => store.setPinned("overflow", true), /up to 4 projects/);
});

await testAsync("projectStore: re-pinning an already-pinned project (no-op) doesn't count against the cap", async () => {
  const store = createProjectStore(makeMockAdapter());
  for (let i = 0; i < MAX_PINNED; i++) {
    await store.create(`re${i}`, `Re${i}`, `org/re${i}`);
    await store.setPinned(`re${i}`, true);
  }
  await assert.doesNotReject(() => store.setPinned("re0", true), "re-pinning an already-pinned project must not throw the cap error");
});

await testAsync("projectStore: setPinned on unknown id throws", async () => {
  const store = createProjectStore(makeMockAdapter());
  await assert.rejects(() => store.setPinned("ghost", true), /Unknown project/);
});

await testAsync("projectStore: legacy project (no pinned field at all) reads safely with sane defaults", async () => {
  const adapter = makeMockAdapter();
  await adapter.set({
    projects: {
      legacy3: { name: "Legacy3", repo: "org/legacy3", lastPushedMarkdown: null, lastPushedTokens: 0, lastPushedAt: null, history: [] },
    },
  });
  const store = createProjectStore(adapter);
  const p = await store.get("legacy3");
  assert.equal(p.pinned, false, "legacy project missing `pinned` must default to false, not crash or be undefined");
});

// --- repoMeta ---

await testAsync("projectStore: updateRepoMeta stores a normalized snapshot from a raw GitHub repo object", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p12", "P12", "org/p12");
  await store.updateRepoMeta("p12", {
    description: "A test repo",
    language: "TypeScript",
    stargazers_count: 42,
    private: true,
    pushed_at: "2026-06-01T00:00:00.000Z",
  });
  const p = await store.get("p12");
  assert.deepEqual(p.repoMeta, {
    description: "A test repo",
    language: "TypeScript",
    stars: 42,
    isPrivate: true,
    pushedAt: "2026-06-01T00:00:00.000Z",
  });
});

await testAsync("projectStore: updateRepoMeta normalizes missing/undefined fields to null rather than storing undefined", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p13", "P13", "org/p13");
  await store.updateRepoMeta("p13", {});
  const p = await store.get("p13");
  assert.equal(p.repoMeta.description, null);
  assert.equal(p.repoMeta.language, null);
  assert.equal(p.repoMeta.stars, null);
  assert.equal(p.repoMeta.isPrivate, false, "private must default to false (falsy), never crash on a missing field");
  assert.equal(p.repoMeta.pushedAt, null);
});

await testAsync("projectStore: updateRepoMeta on unknown id throws", async () => {
  const store = createProjectStore(makeMockAdapter());
  await assert.rejects(() => store.updateRepoMeta("ghost", {}), /Unknown project/);
});

await testAsync("projectStore: updateRepoMeta never touches commitHistory/lastCheckedAt — purely additive/display-only", async () => {
  const store = createProjectStore(makeMockAdapter());
  await store.create("p14", "P14", "org/p14");
  await store.addCommitHistoryEntry("p14", { sha: "sha1", commitDate: "2026-01-01T00:00:00.000Z" });
  await store.updateLastChecked("p14");
  const before = await store.get("p14");
  await store.updateRepoMeta("p14", { description: "x" });
  const after = await store.get("p14");
  assert.deepEqual(after.commitHistory, before.commitHistory);
  assert.equal(after.lastCheckedAt, before.lastCheckedAt);
});

// --- MAX_TRACKED (10-repo ceiling, independent of MAX_PINNED) ---

await testAsync(`projectStore: tracked-repo list is capped at MAX_TRACKED (${MAX_TRACKED})`, async () => {
  const store = createProjectStore(makeMockAdapter());
  for (let i = 0; i < MAX_TRACKED; i++) {
    await store.create(`t${i}`, `T${i}`, `org/t${i}`);
  }
  await assert.rejects(
    () => store.create("overflow-tracked", "Overflow", "org/overflow-tracked"),
    /up to 10 repos/,
    "the 11th tracked repo must be rejected"
  );
  const all = await store.list();
  assert.equal(all.length, MAX_TRACKED, "list must still contain exactly MAX_TRACKED entries after the rejected create");
});

await testAsync("projectStore: MAX_TRACKED cap does not block pinning within an already-full list", async () => {
  const store = createProjectStore(makeMockAdapter());
  for (let i = 0; i < MAX_TRACKED; i++) {
    await store.create(`f${i}`, `F${i}`, `org/f${i}`);
  }
  await store.setPinned("f0", true);
  await store.setPinned("f1", true);
  const all = await store.list();
  assert.equal(all.filter((p) => p.pinned).length, 2);
});

await testAsync("projectStore: removing a tracked repo frees a slot under MAX_TRACKED", async () => {
  const store = createProjectStore(makeMockAdapter());
  for (let i = 0; i < MAX_TRACKED; i++) {
    await store.create(`r${i}`, `R${i}`, `org/r${i}`);
  }
  await store.remove("r0");
  await assert.doesNotReject(
    () => store.create("r-new", "R New", "org/r-new"),
    "removing one tracked repo must free a slot for a new one"
  );
});

console.log(`\n${passed} test(s) passed total.`);
if (process.exitCode) console.log("SOME TESTS FAILED — see FAIL lines above.");