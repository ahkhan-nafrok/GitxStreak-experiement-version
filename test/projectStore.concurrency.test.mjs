// test/projectStore.concurrency.test.mjs
// Overlapping store mutations must behave as if run one at a time. The
// adapter here mimics chrome.storage honestly: async with jittered latency,
// and get()/set() hand back/keep COPIES (structuredClone). The older shared-
// reference mock hid lost updates because every caller mutated the same
// object.
//
// Run with: node test/projectStore.concurrency.test.mjs
import assert from "node:assert/strict";
import { createProjectStore, MAX_TRACKED, MAX_PINNED } from "../lib/projectStore.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); }
}

function makeSlowAdapter() {
  let store = {};
  const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 4));
  return {
    async get(keys) {
      await jitter();
      const out = {};
      for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj) {
      await jitter();
      for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
    },
    _dump: () => store,
  };
}

await test("parallel creates of distinct repos all land (no lost updates)", async () => {
  const store = createProjectStore(makeSlowAdapter());
  await Promise.all(Array.from({ length: MAX_TRACKED }, (_, i) => store.create(`p${i}`, `P${i}`, `o/p${i}`)));
  assert.equal((await store.list()).length, MAX_TRACKED);
});

await test("MAX_TRACKED holds under concurrency: exactly MAX_TRACKED of 15 parallel creates succeed", async () => {
  const store = createProjectStore(makeSlowAdapter());
  const results = await Promise.allSettled(Array.from({ length: 15 }, (_, i) => store.create(`c${i}`, `C${i}`, `o/c${i}`)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, MAX_TRACKED);
  assert.equal(results.filter((r) => r.status === "rejected").length, 15 - MAX_TRACKED);
  assert.equal((await store.list()).length, MAX_TRACKED);
});

await test("two parallel creates of the SAME id: one wins, one is rejected, exactly one is stored", async () => {
  const store = createProjectStore(makeSlowAdapter());
  const results = await Promise.allSettled([store.create("same", "Same", "o/same"), store.create("same", "Same", "o/same")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /already exists/);
  assert.equal((await store.list()).length, 1);
});

await test("MAX_PINNED holds under concurrency: exactly MAX_PINNED of 10 parallel pins succeed", async () => {
  const store = createProjectStore(makeSlowAdapter());
  for (let i = 0; i < 10; i++) await store.create(`q${i}`, `Q${i}`, `o/q${i}`);
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => store.setPinned(`q${i}`, true)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, MAX_PINNED);
  assert.equal((await store.list()).filter((p) => p.pinned).length, MAX_PINNED);
});

await test("a check finishing while the user pins/edits the same repo doesn't clobber either write", async () => {
  const store = createProjectStore(makeSlowAdapter());
  await store.create("r", "R", "o/r");
  await Promise.all([
    store.updateLastChecked("r"),
    store.addCommitHistoryEntry("r", { sha: "abc", commitDate: "2026-01-01T00:00:00Z" }),
    store.updateRepoMeta("r", { description: "d", language: "JS", stargazers_count: 2, private: true, pushed_at: "2026-01-01T00:00:00Z" }),
    store.setPinned("r", true),
  ]);
  const p = await store.get("r");
  assert.ok(p.lastCheckedAt, "updateLastChecked's write survived");
  assert.equal(p.commitHistory[0].sha, "abc", "addCommitHistoryEntry's write survived");
  assert.equal(p.repoMeta.language, "JS", "updateRepoMeta's write survived");
  assert.equal(p.pinned, true, "setPinned's write survived");
});

await test("a removal racing with an add on another repo keeps the add", async () => {
  const store = createProjectStore(makeSlowAdapter());
  await store.create("old", "Old", "o/old");
  await Promise.all([store.remove("old"), store.create("new", "New", "o/new")]);
  assert.deepEqual((await store.list()).map((p) => p.id), ["new"]);
});

await test("a rejected mutation does not poison the queue for the ones behind it", async () => {
  const store = createProjectStore(makeSlowAdapter());
  await store.create("a", "A", "o/a");
  const results = await Promise.allSettled([store.create("a", "A", "o/a"), store.create("b", "B", "o/b"), store.setPinned("ghost", true), store.create("c", "C", "o/c")]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "rejected", "fulfilled"]);
  assert.deepEqual((await store.list()).map((p) => p.id).sort(), ["a", "b", "c"]);
});

await test("two store instances over the SAME adapter share one queue", async () => {
  const adapter = makeSlowAdapter();
  const s1 = createProjectStore(adapter);
  const s2 = createProjectStore(adapter);
  await Promise.all(Array.from({ length: MAX_TRACKED }, (_, i) => (i % 2 ? s1 : s2).create(`m${i}`, `M${i}`, `o/m${i}`)));
  assert.equal((await s1.list()).length, MAX_TRACKED);
});

await test("removePrivate removes only repos whose repoMeta says private; unchecked/public repos stay", async () => {
  const store = createProjectStore(makeSlowAdapter());
  await store.create("priv", "Priv", "o/priv");
  await store.create("pub", "Pub", "o/pub");
  await store.create("unknown", "Unknown", "o/unknown");
  await store.updateRepoMeta("priv", { private: true });
  await store.updateRepoMeta("pub", { private: false });
  assert.equal(await store.removePrivate(), 1);
  assert.deepEqual((await store.list()).map((p) => p.id).sort(), ["pub", "unknown"]);
  assert.equal(await store.removePrivate(), 0, "second call is a no-op");
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
