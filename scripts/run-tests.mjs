// scripts/run-tests.mjs
// `npm test` entry point. Written as a Node script (not a shell one-liner) so
// it behaves identically on Windows cmd, macOS, Linux and CI.
//
//   1. Syntax-checks every source file (`node --check`). The view files and
//      popup.js have no unit tests, so a typo there would otherwise only show
//      up in the browser.
//   2. Runs every test/*.test.mjs in its OWN process — tests install globals
//      (fetch, indexedDB, chrome, document) and must not leak into each other.
//
// Exit code is non-zero if anything fails, or if no tests are found (an empty
// glob must never read as "all green").
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TIMEOUT_MS = 60_000;

function listFiles(dir, predicate) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...listFiles(full, predicate));
    } else if (predicate(name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const failures = [];

// ---- 1. syntax check ----
const sources = listFiles(root, (n) => /\.(m?js)$/.test(n));
let syntaxOk = 0;
for (const file of sources) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status === 0) {
    syntaxOk++;
  } else {
    failures.push(`syntax: ${rel(file)}`);
    console.error(`SYNTAX ERROR in ${rel(file)}\n${r.stderr}`);
  }
}
console.log(`syntax check: ${syntaxOk}/${sources.length} files OK\n`);

// ---- 2. tests, one process each ----
const testFiles = listFiles(path.join(root, "test"), (n) => n.endsWith(".test.mjs"));
if (testFiles.length === 0) {
  console.error("No test files found in test/ — refusing to report success.");
  process.exit(1);
}

for (const file of testFiles) {
  console.log(`\n=== ${rel(file)} ===`);
  const r = spawnSync(process.execPath, [file], { stdio: "inherit", cwd: root, timeout: TEST_TIMEOUT_MS });
  if (r.error?.code === "ETIMEDOUT") {
    failures.push(`${rel(file)} (timed out after ${TEST_TIMEOUT_MS / 1000}s)`);
  } else if (r.status !== 0) {
    failures.push(`${rel(file)} (exit ${r.status ?? r.signal})`);
  }
}

console.log("\n----------------------------------------");
if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${testFiles.length} test files passed.`);
