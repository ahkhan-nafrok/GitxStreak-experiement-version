// test/privacy.guard.test.mjs — the "nothing leaves the browser" guard.
// A static scan of every shipped source file. It can't prove a negative, but it
// makes the regressions that matter loud: a new network path, a new host, sync
// storage (uploads to the user's Google account), analytics-style beacons,
// remote fonts/scripts, or IndexedDB use outside the token vault.
//
// If you genuinely need to change one of these, change the allow-list HERE, in
// the same commit, so the privacy boundary is a reviewed decision.
// Run with: node test/privacy.guard.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ok  - ${name}`); } catch (e) { failed++; console.error(`FAIL  - ${name}\n        ${e.message}`); } }

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const full = path.join(dir, n);
    if (statSync(full).isDirectory()) { if (!["test", "scripts", "node_modules", "icons"].includes(n) && !n.startsWith(".")) out.push(...walk(full)); }
    else if (/\.(m?js|html|css|json)$/.test(n)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
const files = walk(root);
const read = (f) => readFileSync(f, "utf8");
// Strip comments so prose mentioning "fetch(" or a URL can't trip (or hide) a rule.
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the scan covers the real source (guards against an empty glob reading as green)", () => {
  const names = files.map(rel);
  for (const must of ["background.js", "pulseView.js", "lib/github.js", "lib/progression/store.js", "popup.html", "manifest.json"]) assert.ok(names.includes(must), must);
});

test("only the vetted modules call fetch(): net.js (deadline wrapper) — everyone else goes through it", () => {
  const offenders = files.filter((f) => f.endsWith(".js") && /\bfetch\s*\(/.test(code(f)) && rel(f) !== "lib/net.js").map(rel);
  assert.deepEqual(offenders, []);
});

test("no other network primitives anywhere: XHR, WebSocket, EventSource, sendBeacon, importScripts, dynamic import of a URL", () => {
  for (const f of files.filter((x) => /\.(m?js|html)$/.test(x))) {
    const c = code(f);
    assert.ok(!/XMLHttpRequest|new\s+WebSocket|EventSource|sendBeacon|importScripts\s*\(/.test(c), rel(f));
    assert.ok(!/import\s*\(\s*["'`]https?:/.test(c), rel(f));
  }
});

test("every absolute URL in shipped code points at GitHub (api.github.com / github.com) or is the w3.org SVG namespace", () => {
  const allowed = [/^https:\/\/api\.github\.com(\/|$)/, /^https:\/\/github\.com(\/|$)/, /^http:\/\/www\.w3\.org\/2000\/svg$/];
  for (const f of files) {
    if (rel(f) === "package.json") continue;
    for (const [url] of code(f).matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
      assert.ok(allowed.some((re) => re.test(url)), `${rel(f)} references ${url}`);
    }
  }
});

test("no remote fonts, scripts, styles or images: popup.html/css load nothing from the network", () => {
  for (const f of files.filter((x) => /\.(html|css)$/.test(x))) {
    const c = code(f);
    assert.ok(!/(src|href)\s*=\s*["']https?:\/\/(?!github\.com)/i.test(c), `${rel(f)} has a remote src/href`);
    assert.ok(!/@import\s+(url\()?["']?https?:/i.test(c), `${rel(f)} @imports a remote stylesheet`);
    assert.ok(!/url\(\s*["']?https?:/i.test(c), `${rel(f)} url() points at the network`);
  }
});

test("never chrome.storage.sync / .managed / .session-as-cloud: progression must not be uploaded to a Google account", () => {
  for (const f of files.filter((x) => x.endsWith(".js"))) assert.ok(!/storage\s*\.\s*sync/.test(code(f)), rel(f));
});

test("IndexedDB is touched ONLY by lib/tokenVault.js (invariant 7 — progression deliberately needs none)", () => {
  const offenders = files.filter((f) => f.endsWith(".js") && /\bindexedDB\b/.test(code(f)) && rel(f) !== "lib/tokenVault.js").map(rel);
  assert.deepEqual(offenders, []);
});

test("progression modules import nothing network-capable and no token vault (they only ever see pre-fetched data)", () => {
  for (const f of files.filter((x) => rel(x).startsWith("lib/progression/"))) {
    const imports = [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const i of imports) assert.ok(!/(net|github|deviceFlow|tokenVault)(\.js)?$/.test(i), `${rel(f)} imports ${i}`);
  }
});

test("manifest: no new permissions or hosts — still storage + alarms and the two GitHub hosts", () => {
  const m = JSON.parse(read(path.join(root, "manifest.json")));
  assert.deepEqual([...m.permissions].sort(), ["alarms", "storage"]);
  assert.deepEqual([...m.host_permissions].sort(), ["https://api.github.com/*", "https://github.com/login/*"]);
  assert.ok(!("optional_permissions" in m) && !("content_scripts" in m) && !("externally_connectable" in m));
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
