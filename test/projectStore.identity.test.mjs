// test/projectStore.identity.test.mjs — a tracked repo is identified by owner/repo, never by its display name.
// Run with: node test/projectStore.identity.test.mjs
import assert from "node:assert/strict";
import { createProjectStore } from "../lib/projectStore.js";

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.stack || e.message}`); } }
function slowAdapter() { let s = {}; const j = () => new Promise((r) => setTimeout(r, Math.random() * 4)); return { async get(k) { await j(); const o = {}; for (const x of k) if (x in s) o[x] = structuredClone(s[x]); return o; }, async set(o) { await j(); for (const [k, v] of Object.entries(o)) s[k] = structuredClone(v); } }; }

await test("the same repo can't be tracked twice under different ids/names", async () => {
  const store = createProjectStore(slowAdapter());
  await store.create("o/r", "First", "o/r");
  await assert.rejects(() => store.create("other-id", "Second", "o/r"), /already tracking o\/r/);
  assert.equal((await store.list()).length, 1);
});

await test("repo identity ignores case and input style (shorthand vs URL vs .git vs trailing slash)", async () => {
  const store = createProjectStore(slowAdapter());
  await store.create("a", "A", "Octo/Hello");
  for (const dup of ["octo/hello", "https://github.com/octo/hello", "https://github.com/Octo/Hello.git", "https://github.com/octo/hello/"]) {
    await assert.rejects(() => store.create(`x-${dup.length}`, "Dup", dup), /already tracking/, dup);
  }
  assert.equal((await store.list()).length, 1);
});

await test("different repos that merely share a name or owner are fine", async () => {
  const store = createProjectStore(slowAdapter());
  await store.create("a", "Same Name", "o/one");
  await store.create("b", "Same Name", "o/two");
  await store.create("c", "Same Name", "p/one");
  assert.equal((await store.list()).length, 3);
});

await test("an id collision is still reported as an id collision (checked first)", async () => {
  const store = createProjectStore(slowAdapter());
  await store.create("dup", "Dup", "o/dup");
  await assert.rejects(() => store.create("dup", "Dup", "o/dup"), /already exists/);
});

await test("two parallel creates of the SAME repo under different ids: exactly one wins", async () => {
  const store = createProjectStore(slowAdapter());
  const r = await Promise.allSettled([store.create("id1", "One", "o/same"), store.create("id2", "Two", "o/same")]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await store.list()).length, 1);
});

await test("legacy entries with an unparsable repo string never block unrelated creates", async () => {
  const adapter = slowAdapter();
  await adapter.set({ projects: { legacy: { name: "Legacy", repo: "not a repo" } } });
  const store = createProjectStore(adapter);
  await store.create("o/new", "New", "o/new");
  assert.equal((await store.list()).length, 2);
});

await test("a legacy slug-id project still blocks re-adding its repo under the new repo-key id", async () => {
  const adapter = slowAdapter();
  await adapter.set({ projects: { "my-app": { name: "My App", repo: "org/my-app" } } });
  const store = createProjectStore(adapter);
  await assert.rejects(() => store.create("org/my-app", "My App again", "org/my-app"), /already tracking/);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
