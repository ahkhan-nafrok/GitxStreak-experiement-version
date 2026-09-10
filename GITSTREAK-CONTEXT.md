# GITSTREAK — Project Context

A Chrome extension (MV3), GitHub-only, personal productivity dashboard.
No backend. Nothing leaves the machine except calls to `api.github.com`.
Local state lives in `chrome.storage.local` and `indexedDB` (the encryption
key only).

This is a full reframe of an older extension ("Token Optimizer" /
Skeletonizer). **Skeletonizer is fully deleted** — no context-pack
generation, no README condensing, no claude.ai upload flow, no trace of it
anywhere in code or naming.

Status: idea phase closed, all lib/view/manifest files built, security
layer built and verified, test suite built and passing, **Pulse tab UI/UX
pass complete** (this session — see §8). Not yet load-unpacked/manually
tested in an actual browser.

---

## 1. What it does — three tabs

### Tab 1 — Pulse
GitHub activity at a glance. Nothing else on this tab.

- **Update CTA** — full-width, enlarged primary button at the top of the
  card (`Click to Update` → `Updating...` with a spinning icon while
  in-flight → `Updated` with a checkmark and a brief scale-pulse on
  success, then auto-reverts). No color anywhere in these states — success
  reads through icon + motion only, per the monochrome design system. A
  small "Updated Xm ago" caption sits in the card header, sourced from the
  cache's `fetchedAt`.
- **Contribution calendar** — rolling last 12 months from today (matches
  GitHub's own default profile view, not a Jan–Dec calendar year).
  Horizontal navigation is **drag/swipe only** (mouse + touch) — no native
  scrollbar is shown; it's hidden via CSS and the wrap's edges fade with a
  `mask-image` gradient instead. The view **defaults to the current-month
  (rightmost) end on every render** — `scrollLeft` is set to `scrollWidth`
  after each grid paint — rather than opening on the oldest, year-ago end.
- **Current streak** — consecutive days with ≥1 contribution, counted
  backward from today.
  - **Today is "pending," never "broken,"** if it has zero contributions so
    far. The streak only breaks once a day actually closes with nothing
    logged. No false "streak broken" mid-day.
- **This Year** — total contribution count for the current calendar year
  (Jan 1 → today, UTC), shown side-by-side with Current Streak directly
  below the chart. Computed from the same `dayMap` the streak calc uses; a
  12-month rolling window always fully covers Jan 1-to-today of the current
  year, so this is never short of data.
- **Last Pushed** — bottom-of-tab section showing the single most recently
  pushed repo across the whole GitHub account (not limited to Tab 2's
  manually tracked repos) — repo name, private/public badge, description,
  "Pushed Xd ago," and language. Sourced from a dedicated REST call
  (`/user/repos?sort=pushed`), fetched and cached alongside the
  contribution data so there's one shared staleness/refresh cycle, not two.
- Requires a connected GitHub token — GitHub's GraphQL API (the only way to
  get contribution data) has no unauthenticated tier at all, unlike REST.
- If no token: shows a prompt to add one in Settings, makes zero GitHub
  calls. (This now reliably works — see the hidden-attribute fix in §5.)

### Tab 2 — Projects
A manually curated tracked-repo list — not GitHub's native "pinned repos."
You explicitly add repos, one at a time.

**What can be tracked:** any public repo (any owner), or your own private
repos (needs a token with private-repo scope).

**Pinning:** up to **4** tracked repos at once. Pinning a 5th is rejected.
Re-pinning an already-pinned repo is a no-op (doesn't count against the
cap). Pinned repos always surface first in the list.

**Change tracking** (per repo):
- `lastCheckedAt` — stamped on **every** check attempt, success or failure.
  This is deliberate: a repo that keeps failing to check (rate limit,
  network blip, revoked token) must still show as "recently checked," not
  silently go stale-looking while actually just broken.
- `commitHistory` — array of `{ sha, commitDate }`, newest first, capped at
  **6** entries, FIFO (oldest dropped on a 7th). Only grows when GitHub's
  latest commit is genuinely different from what's already recorded.
- `lastCommitAt` — always derived from `commitHistory[0]`, never stored
  separately, so it can't drift out of sync.
- `repoMeta` — description, language, star count, public/private,
  `pushed_at`. Purely additive/display-only; a failure fetching it never
  blocks or corrupts the change-tracking facts above.
- A repo never successfully checked (`lastCommitAt` is null) bubbles to the
  top of its group — pinned or unpinned — ahead of anything already
  checked.
- **Defensive SHA comparison:** a missing/null SHA is *never* treated as
  matching another missing/null SHA. Only a genuine, non-null equality
  counts as "no change." Safe failure mode is always "record it as
  changed," never "assume nothing changed."

**Sort order for the list** (`sortProjectsForList`, pure & unit-tested):
1. Pinned first (as a block).
2. Within each block (pinned / unpinned): never-checked repos first.
3. Within a never-checked group: alphabetical.
4. Otherwise: most-recent commit first.

The unpinned tail of this same sorted list *is* "recently pushed" — there's
no separate data source or second fetch for it. (Not to be confused with
Pulse's "Last Pushed," which is account-wide via GitHub's REST API, not
scoped to tracked repos — see Tab 1 above.)

### Tab 3 — Settings (the security layer)
See §3 below — this is the one part of GITSTREAK handling something
genuinely sensitive.

---

## 2. Tech stack

Plain HTML / CSS / vanilla JS (ES modules). Deliberate, not a compromise:

- Security comes from the storage/permission architecture, not the UI
  layer — React/Vue would add zero protection here.
- Every added npm dependency is supply-chain risk, which matters more than
  usual for something holding a GitHub access token.
- Two tabs + Settings doesn't need framework-level complexity management.

`package.json` has no dependencies at all — `{"name": "GIT-STREAK",
"version": "1.0.0", "type": "module"}`. Tests are hand-rolled scripts using
Node's built-in `node:assert/strict`, run directly via `node test/x.mjs` —
no test framework, no `npm install` step, no CI config yet.

---

## 3. Security layer — GitHub token handling

**Honest framing:** no client-side browser storage reaches true
OS-keychain-level security without a native companion app (overkill here).
The goal is "no unnecessary exposure, real protection against the common
failure mode" (something reading the extension's storage files directly) —
not "unbreakable."

**Architecture:**
- A **non-extractable AES-GCM (256-bit) key** is generated via WebCrypto's
  `SubtleCrypto.generateKey(..., extractable: false, ...)`. The key can be
  *used* by the extension's own JS to encrypt/decrypt, but its raw bytes
  can never be read out by anything, including the extension's own code.
- That key lives in **IndexedDB** (`gitstreak_vault` / store `keys`,
  record id `token-key`) — persists across browser and PC restarts, zero
  re-entry, ever. No passphrase by default (rejected after review — daily
  re-entry doesn't fit a workflow spanning 20+ active projects).
- The GitHub token is encrypted with that key (fresh random 12-byte IV
  every time) before it ever touches `chrome.storage.local` under the key
  `ghTokenEncrypted`. What's on disk there is `{ ciphertext, iv }`,
  base64-encoded — never plaintext.

**Why it isn't theater:** a naive "encrypted storage" keeps the key right
next to the ciphertext — if someone can read one, they can read the other,
and encryption adds nothing. Non-extractable breaks that: the key can be
used but never copied out as raw bytes, by anything. It stops the
realistic threat (something grabbing storage files and reading the token
straight out) without demanding a security ritual on every browser launch.

**What it does NOT protect against** (documented, not oversold): code
running inside the extension's own context — a compromised dependency, or
a bug letting page content reach the background worker. The zero-deps
stance in §2 is the actual mitigation for that threat, not the key itself.

**Access boundaries:**
- Token readable only inside the extension's own contexts (popup /
  background service worker).
- No `content.js` exists in this project at all — there is no page-facing
  script, so there's no code path where the token could reach one.
- `host_permissions` hard-locked to `https://api.github.com/*` in
  `manifest.json` — no wildcard hosts.

**UI-level rules (Settings tab):**
- Token input is `type="password"`, never redisplayed in full — only
  `Connected as ghp_••••1a2b` style.
- **Test Connection** validates against GitHub and shows real granted
  scopes *before* save — catches an over-scoped token early. Editing the
  token after a successful test invalidates that test (forces re-verify
  before save is re-enabled).
- **Revoke Locally** wipes both the encrypted blob (`chrome.storage.local`)
  and the IndexedDB key record — a real revoke, not just clearing the
  ciphertext. Does *not* revoke the token on GitHub's side (that's
  `github.com/settings/tokens`, called out in the confirm dialog).
- Settings copy nudges toward a fine-grained PAT scoped to just `Contents:
  Read` + private-repo access if needed, with an expiration set — this
  matters more than any storage trick above, since a well-scoped,
  short-lived token that leaks is a minor incident. Note: Pulse's new "Last
  Pushed" REST call (`/user/repos`) relies on the same repo-metadata read
  access `repoMeta` already required — no new scope needed for a normal
  fine-grained PAT.

**Known, documented limitation (not a bug):** `testConnection` can't
distinguish a classic PAT with zero granted scopes from a fine-grained PAT
— GitHub's `x-oauth-scopes` header being present-but-empty and being
absent both evaluate falsy in JS (`scopesHeader ? ... : null`). In
practice GitHub doesn't appear to send an empty-but-present header for
classic tokens, so this hasn't been patched — just flagged if a scope
badge ever looks wrong in testing.

**Future-optional, not built:** an opt-in passphrase "extra lock" toggle
(off by default); a persistent scope badge in Settings; multi-account
token support (same vault pattern, no architecture change needed).

---

## 4. File-by-file status

```
├── icons/                        icon16/48/128.png
├── lib/
│   ├── github.js                 REST wrapper (getRepoMeta, getLatestCommit,
│   │                              getMostRecentlyPushedRepo, parseRepoInput)
│   │                              + ghGraphQL (POST wrapper used by Pulse).
│   │                              Read-only, no writes.
│   ├── projectStore.js           Tab 2 persistence: create/list/get/remove,
│   │                              updateLastChecked, addCommitHistoryEntry
│   │                              (defensive SHA-null-safe), updateRepoMeta,
│   │                              setPinned (4-cap). Migration-safe defaults
│   │                              for every field.
│   ├── pulse.js                  Tab 1 pure logic: rolling-12-month range,
│   │                              GraphQL query + parsing, grid-building,
│   │                              cache staleness, calculateCurrentStreak
│   │                              (the "today is pending" rule lives here),
│   │                              calculateYearTotal (this-year sum from the
│   │                              same dayMap — added this session).
│   ├── storageAdapter.js         ONLY file touching chrome.storage directly
│   │                              — thin Promise wrapper, injected into
│   │                              projectStore for testability.
│   └── tokenVault.js             The security layer — see §3. ONLY file
│                                  touching indexedDB or the vault key.
├── test/
│   ├── helpers/fakeIndexedDB.mjs In-memory indexedDB stand-in, just enough
│   │                              surface for tokenVault.js's real code to
│   │                              run under Node unmodified.
│   ├── tokenVault.test.mjs       24 tests. Verifies non-extractable flag,
│   │                              key reuse across saves, genuinely-new key
│   │                              after revoke, fail-safe decrypt on
│   │                              corruption, testConnection scope parsing.
│   ├── pulse.test.mjs            19 tests. Rolling-range math, grid
│   │                              building, and exhaustive streak-calc
│   │                              coverage (pending-today, real gaps,
│   │                              missing-day-as-zero, window-edge
│   │                              truncation documented as intentional).
│   │                              NOT yet covering calculateYearTotal —
│   │                              see §7.
│   ├── module2.test.mjs          27 tests. projectStore CRUD, pin cap,
│   │                              commitHistory FIFO cap, migration safety
│   │                              from the old pre-GITSTREAK shape, and
│   │                              REGRESSION coverage for the SHA-null-match
│   │                              fix + updateRepoMeta.
│   ├── integration.test.mjs      7 checks. End-to-end store behavior across
│   │                              a realistic check sequence, plus a
│   │                              REGRESSION test that a failed GitHub call
│   │                              still stamps lastCheckedAt.
│   ├── projectsView.integration.test.mjs
│   │                              Runs the REAL projectsView.js against a
│   │                              fake DOM + fake chrome.storage + mocked
│   │                              fetch. Rewritten from scratch after the
│   │                              GitHub-Overview-in-Tab-2 UI was removed
│   │                              (moved to Pulse). Covers create, pin,
│   │                              check (changed/unchanged/failed), sort.
│   └── sortProjectsForList.test.mjs
│                                  8 tests, pure sort-order logic. Verified
│                                  unchanged and still passing against the
│                                  current projectsView.js.
├── manifest.json                 MV3. host_permissions locked to
│                                  api.github.com only. No content script.
├── package.json                  No dependencies. type: module.
├── popup.html / popup.css / popup.js
│                                  3-tab shell (Pulse/Projects/Settings).
│                                  Monochrome dark-glass design system,
│                                  unchanged for Projects/Settings. Pulse tab
│                                  markup rebuilt this session (see §8) —
│                                  Update CTA, drag-scroll calendar wrap,
│                                  stats row, last-pushed card. popup.css
│                                  also gained a global `[hidden] { display:
│                                  none !important; }` rule — see the fix in
│                                  §5.
├── projectsView.js               Tab 2 UI logic + sortProjectsForList
│                                  (exported, unit-tested). Untouched this
│                                  session.
├── pulseView.js                  Tab 1 UI logic. Rewritten this session —
│                                  see §8 for the full breakdown.
└── settingsView.js               Tab 3 UI logic — token entry, test,
                                   save, revoke. Untouched this session.
```

**Deleted, confirmed gone:** `lib/githubOverview.js` (superseded by
`lib/pulse.js` — the old version was scoped to a single current UTC month;
Pulse is a rolling 12-month window with streak calc added), plus its two
now-orphaned tests `test/github.overview.test.mjs` and
`test/githubOverview.test.mjs` (deleted alongside it — they imported
functions/files that no longer exist and would fail to load).

Also gone, from the pre-GITSTREAK Skeletonizer era: `lib/build.js`,
`lib/diff.js`, `lib/skeletonizer.js`, `skeletonizerView.js`, `content.js`,
and their tests.

---

## 5. Fixes made after initial build, all regression-tested or documented

1. **`lastCheckedAt` must stamp on failure, not just success.** Originally
   `checkForUpdates` stamped it only after `getLatestCommit` succeeded — a
   repo failing checks for days would silently keep showing a stale "last
   checked" time instead of reflecting that it's actually been failing.
   Fixed by moving the stamp before the network call. Covered by a named
   REGRESSION test in both `integration.test.mjs` and
   `projectsView.integration.test.mjs`.

2. **SHA-match comparison wasn't null-safe.** `history[0].sha === sha`
   would evaluate `undefined === undefined` as `true` if both sides were
   missing — treating two malformed/missing GitHub responses as "no
   change" and silently dropping a commit-history entry, contradicting the
   project's own defensive-comparison rule. Fixed by requiring both sides
   to be non-null before calling it a match. Covered by a named REGRESSION
   test in `module2.test.mjs`.

3. **`[hidden]` attribute was losing to author CSS (found this session).**
   `.empty-state { display: flex; }` in `popup.css` sits at the same
   specificity as the browser's own `[hidden] { display: none; }` rule, and
   author styles win that tie — so calling `el.hidden = true` on Pulse's
   token-prompt element (an `.empty-state`) did nothing visually, even
   though the underlying JS logic in `pulseView.js` was already correct.
   This is why the "Add a GitHub token in Settings..." message kept
   showing even once a token was connected and the calendar had rendered.
   Fixed with a single global rule in `popup.css`:
   `[hidden] { display: none !important; }` — placed once, near the top of
   the file, so it protects every `hidden`-toggled element in the app
   (including Tab 2's own `.empty-state` for an empty project list), not
   just Pulse's. Not test-covered yet — this is DOM/CSS-cascade behavior,
   outside the Node-based test suite's reach without a real or simulated
   DOM; flagged in §7.

---

## 6. Design system (monochrome, Pulse tab restyled this session)

Monochrome throughout, no hue anywhere. State reads through contrast,
weight, shape, and motion — never color. This rule was upheld strictly in
the Pulse redesign: the Update button's loading/success states swap icon
shape (spinning refresh ↔ static checkmark) and add a brief scale-pulse on
success, but never introduce a green/color "success" tint.

- Surfaces: near-black graphite, low-opacity white glass panels,
  `backdrop-filter: blur()`.
- Text: off-white primary, mid-grey secondary.
- Primary buttons: solid off-white on black, diagonal sheen + lift on
  hover. Pulse's Update CTA reuses this exact treatment at full width,
  rather than introducing a separate button style.
- Ghost buttons: transparent, hairline border, lightens on hover.
- Pinned rows: white-tinted glass, no divider/header — spacing/tint only.
- Never-checked rows: dashed border + pulsing outline dot.
- Staleness/destructive states: weight, icon, motion — never color.
- **New — Pulse calendar navigation:** no visible scrollbar anywhere.
  `.gh-cal-wrap` hides the native scrollbar (`scrollbar-width: none` +
  `::-webkit-scrollbar { display: none }`) and signals scrollability via a
  `mask-image` linear-gradient fade at both edges instead — replacing the
  native grey scrollbar pill that was visually clashing with the
  dark-glass design.

---

## 7. What's NOT done yet

- No manual load-unpacked test in an actual Chrome instance — everything
  above is verified via mocked Node tests, not a live browser run. This
  now includes the entire Pulse UI/UX pass from this session (drag-scroll
  feel, default-scroll-to-today behavior, Update button states, stats row,
  last-pushed card) — none of it has been eyeballed in a real popup yet.
- **No unit tests yet for the two functions added this session:**
  `calculateYearTotal` (`lib/pulse.js`) and `getMostRecentlyPushedRepo`
  (`lib/github.js`). Both are additive and don't touch any existing tested
  path, so nothing is currently broken — but neither has its own coverage
  in `pulse.test.mjs` / a new `github.test.mjs` yet.
- The `[hidden]`-losing-to-CSS bug (§5, fix #3) has no regression test —
  the existing test suite is DOM-free (Node scripts + a hand-rolled fake
  DOM only where a specific view test needs one), so this class of
  cascade/specificity bug isn't naturally caught by it.
- No CI config (no GitHub Actions running the test suite on push, etc.) —
  tests are run manually via `node test/x.mjs`.
- Optional passphrase "extra lock" toggle, persistent scope badge,
  multi-account token support — all deliberately deferred, not started.
- Real icon files (icon16/48/128.png) — referenced in manifest.json and
  popup, not verified to exist/render correctly.

---

## 8. Session log — Pulse tab UI/UX pass

Scope was explicitly narrowed to Tab 1 (Pulse) only; Projects and Settings
were untouched. Six changes requested, all implemented:

1. **Slider redesign** — native horizontal scrollbar replaced with
   custom drag/swipe (mouse + touch) via `enableDragScroll()` in
   `pulseView.js`; scrollbar hidden, edges fade with `mask-image` instead.
2. **Default to current month** — `calendarWrap.scrollLeft =
   calendarWrap.scrollWidth` runs (inside `requestAnimationFrame`, so it's
   post-layout) after every grid render, so the view opens on today's end
   rather than a year ago.
3. **Token-prompt not disappearing** — traced to a real CSS bug, not a
   logic bug; fixed globally (see §5, fix #3).
4. **Enlarged Update button** — full-width primary CTA with icon + text,
   three states (idle / loading / success), a "last updated" caption in
   the header for trust/feedback, all monochrome per §6.
5. **Two sections below the chart, only** — Current Streak and This Year
   (calendar-year-to-date total via the new `calculateYearTotal`),
   side-by-side in a single stats row.
6. **Last Pushed section at the bottom** — single most-recently-pushed
   repo, account-wide (not tracked-repos-only), via the new
   `getMostRecentlyPushedRepo` REST call, cached alongside the
   contribution data so there's one shared fetch/staleness cycle.

Decisions locked in during this session, in case they need revisiting:
- Last Pushed pulls from the GitHub account overall (REST, any repo),
  **not** scoped to Tab 2's tracked/pinned Projects list.
- Calendar navigation is drag/swipe only — no prev/next arrow buttons.
