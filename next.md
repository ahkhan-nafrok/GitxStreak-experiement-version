# GITSTREAK — Session Addendum: Device Flow + 10-Repo Cap

This is an addendum to `GITSTREAK-CONTEXT.md`, not a replacement. It covers
only what changed in this session: GitHub Device Flow as the primary
connect method, a 10-repo tracked-list ceiling, and the MV3 service-worker
architecture that Device Flow's polling actually required. Read the
original context doc first — this assumes everything in it still holds
except where noted below.

Status at end of session: all code written and reviewed for two rounds of
bugs (one test-file duplicate-import issue, one `parseRepoInput` ordering
bug, one MV3 service-worker lifecycle bug that broke the first working
version of Device Flow). Last known state: Device Flow confirmed working
end-to-end by the user (GitHub's own "Congratulations, you're all set!"
screen reached, and — after the background.js rewrite below — the
extension correctly reflects the connected state afterward).

---

## 1. Why this session happened

Two problems were raised, in priority order:

1. **Token-entry friction.** Copy-pasting a PAT is real friction for a
   first-time user, especially compared to a one-click "Connect GitHub"
   flow like Vercel/Render. But GITSTREAK has no backend and never will
   (that's the whole security pitch — see §3 of the original context
   doc), so a full OAuth web flow (which needs a `client_secret` held
   server-side) was never on the table. **GitHub OAuth Device Flow** was
   chosen instead: no `client_secret` required, works from an unpackable
   extension, and gets closer to a real "Connect" button than a raw
   PAT-paste form.
2. **Reward-system psychology** (streak targets, contribution targets,
   sharing, badges) — explicitly deferred by the user to a later session.
   Nothing about it was designed or built this session.

A third, smaller request came in mid-session: raise Tab 2's tracked-repo
list from uncapped to a hard ceiling of **10**, while keeping the existing
pin cap at **4** — two independent limits, not one raised to the other.

---

## 2. Decisions locked in this session

- **Device Flow requests `repo` scope**, not `public_repo`. This was a
  deliberate correction of an early misconception (that Device Flow is
  inherently public-only) — scope is independent of the delivery
  mechanism. `repo` scope is required because:
  - Private repos need it for Tab 2 tracking.
  - **Private contribution counts do NOT depend on the account's
    "include private contributions on public profile" setting** — that
    setting only affects what unauthenticated visitors see on
    `github.com/username`. The authenticated GraphQL call GITSTREAK
    already makes (`contributionsCollection`) returns full private-commit
    counts regardless of that toggle, as long as the token itself carries
    `repo` scope.
  - Real cost accepted knowingly: `repo` is a broad, all-or-nothing scope
    (full read/write on all repos) — Device Flow issues classic OAuth
    tokens, which don't support fine-grained scoping the way a
    fine-grained PAT can. The Settings copy was updated to stop implying
    a narrower grant than what's actually requested.
- **PAT-paste stays as a fallback**, collapsed under "Use a personal
  access token instead" — not removed. Reasoning: Device Flow requires
  leaving the popup to approve on `github.com`, which fails for anyone on
  a restricted network or without a spare browser tab handy. PAT-paste
  has no such dependency.
- **A `background.js` MV3 service worker was added** — the project's
  first background script ever (previously zero background scripts, by
  design, per the original context doc's "plain HTML/CSS/vanilla JS,
  deliberate not a compromise" stance). This was unavoidable: Device
  Flow's polling has to survive the popup closing, since Chrome unloads
  extension popups the instant they lose focus (exactly what happens when
  the user tabs away to approve on `github.com`).
- **Tracked-repo cap: MAX_TRACKED = 10, MAX_PINNED unchanged at 4.**
  Deliberately did NOT raise the pin cap — the reasoning locked in this
  session: pinning at a small cap (4) forces a "these are the ones I
  actually care about" decision, which is the actual value of the
  pinned/unpinned split. Raising it to 10 would have collapsed that
  distinction into an undifferentiated list, closer to GitHub's own repo
  list than a curated dashboard.

---

## 3. A real bug hit and fixed mid-session: MV3 service worker lifecycle

**This is worth understanding, not just noting as fixed** — it changed
the actual architecture, not just a line of code.

The first version of `background.js` held Device Flow's poll loop as an
in-memory `while` loop using `setTimeout`-based sleeps (mirroring
`pollForToken` in `lib/deviceFlow.js`). This worked in principle but broke
in practice: **Chrome terminates an MV3 service worker after roughly 30
seconds of inactivity**, including mid-`await` inside a pending timer — a
pending JS timer does not count as "activity" to Chrome's scheduler. A
realistic GitHub approval (open a tab, navigate, type the 8-character
code) reliably takes longer than 30 seconds. The user hit this exactly:
GitHub's own screen confirmed "Congratulations, you're all set! Your
device is now connected," but the extension still showed "Connect
GitHub" — the token had been approved server-side, but nothing in the
extension was still alive to receive it, because `background.js` had
already been killed mid-poll.

**Fix — a genuine architecture change, not a patch:**

- Device Flow session state (device code, current polling interval,
  expiry timestamp, user code, verification URL) now lives in
  `chrome.storage.local`, not a JS variable — it survives the worker
  being killed and restarted.
- Polling is now driven by `chrome.alarms`, which wakes the service
  worker on a schedule independent of whether it died in between wake-ups
  — instead of a long-lived in-memory loop.
- **`background.js` now saves the token directly** (via the same
  `saveToken()` / `setAuthFailed()` / `setHasEverConnected()` calls the
  PAT path already used) the moment GitHub approves — it does not wait
  for or depend on a message round-trip to the popup. This means success
  no longer depends on the popup being open at all during the wait;
  whenever the popup is next opened, its existing `getToken()` call in
  `refreshConnectedState()` just sees the token already sitting in the
  vault.
- **Real, accepted trade-off:** `chrome.alarms` enforces a **1-minute
  minimum period** in production Chrome (a genuine anti-battery-abuse
  platform constraint, not a design choice) — slower than GitHub's own
  suggested 5-second poll interval. Approval can now take up to ~1 extra
  minute to be reflected after the user clicks approve on GitHub. This
  was accepted as the necessary cost of correctness over speed.

---

## 4. Files added this session

### `lib/deviceFlow.js` (new)
GitHub OAuth Device Flow logic, split deliberately into pure/testable
functions and the network calls that use them — mirrors the existing
`lib/github.js` pattern (`ghFetch` vs. its pure callers).

- `parseDeviceCodeResponse(json)` — pure, validates/shapes the
  `/login/device/code` response.
- `interpretTokenResponse(json, currentInterval)` — pure, interprets one
  `/login/oauth/access_token` poll response into
  `{status: 'pending'|'slow_down'|'success', ...}`, or throws a typed
  `DeviceFlowError` for `access_denied` / `expired_token` / other GitHub
  error codes.
- `DeviceFlowError` — typed error class, mirrors `GitHubAuthError`'s role
  in `lib/github.js`; carries a `.code` for branching.
- `requestDeviceCode()` — the actual `/login/device/code` network call.
- `checkTokenOnce(deviceCode, currentInterval)` — **the primitive
  `background.js`'s alarm handler actually calls** — one poll attempt,
  stateless, caller persists whatever the result implies.
- `pollForToken(...)` — the original long-lived in-memory loop. **Kept in
  the file but NOT used by `background.js` anymore** (see §3) — retained
  only as a reference implementation / for exercising the pure functions
  above in tests. Do not wire this into the runtime flow.
- Hardcoded `CLIENT_ID` (the GitHub OAuth App's public client ID — safe to
  hardcode, no `client_secret` involved anywhere in Device Flow) and
  `SCOPE = "repo"`.

### `background.js` (new)
The project's first-ever background script. MV3 service worker, storage
+ alarm-backed as described in §3. Listens for `gitstreak:start-device-flow`,
`gitstreak:cancel-device-flow`, `gitstreak:query-device-flow-status`,
`gitstreak:ack-device-flow-status` messages from the popup; owns the
`chrome.alarms` poll loop; saves the token to the vault directly on
success; broadcasts live status updates for any popup that happens to be
open, without depending on one being open.

### `test/deviceFlow.test.mjs` (new)
Unit tests for the pure functions only (`parseDeviceCodeResponse`,
`interpretTokenResponse`) — deliberately does NOT attempt to test
`pollForToken`'s timing loop end-to-end, since faking `fetch` +
`setTimeout` would test the mock more than the code. 15 tests, all
passing.

---

## 5. Files modified this session

### `manifest.json`
- Added `"background": { "service_worker": "background.js", "type": "module" }`.
- Added `"alarms"` to `"permissions"` (required for `chrome.alarms`, added
  during the §3 fix — not present in the first Device Flow pass).
- Added `"https://github.com/*"` to `"host_permissions"` — Device Flow's
  two endpoints (`/login/device/code`, `/login/oauth/access_token`) live
  on `github.com`, not `api.github.com`, which was the only previously
  allowed host.

### `lib/projectStore.js`
- Added `export const MAX_TRACKED = 10;` alongside the existing
  `MAX_PINNED = 4`.
- `create(id, name, repo)` now rejects with
  `"You can track up to 10 repos. Remove one first."` once the tracked
  list is already at `MAX_TRACKED`, checked before the duplicate-id write
  so a rejected create never touches storage. Independent of and
  unaffected by `setPinned`'s existing `MAX_PINNED` cap logic.

### `lib/github.js`
- **Real bug fixed, unrelated to Device Flow:** `parseRepoInput` stripped
  `.git` before stripping a trailing slash, so a URL like
  `https://github.com/owner/repo.git/` left `.git` stuck on the parsed
  repo name (the trailing-slash strip ran second and had nothing left to
  remove). Fixed by swapping the order — strip the trailing slash first,
  then `.git`. Caught by the existing (previously failing)
  `github.test.mjs` case for "full URL with a trailing .git and slash."

### `settingsView.js`
- Added the full Device Flow UI wiring: "Connect GitHub" button, device
  code + verification link display, cancel button, live status rendering
  via `chrome.runtime.onMessage`, and a resync-on-open query to
  `background.js` for any in-progress/unacked terminal status.
- PAT-paste form moved inside a collapsed `<details>` element ("Use a
  personal access token instead") rather than always-visible — Device
  Flow is now the primary path.
- After the §3 rewrite: `handleDeviceStatus`'s `success` branch no longer
  saves the token itself — `background.js` already did that directly. It
  just calls `refreshConnectedState()` (which re-reads the vault) and
  dispatches the same `gitstreak:auth-changed` / `gitstreak:token-saved`
  events the PAT path always dispatched, so `popup.js`'s existing badge
  and tab-routing logic needed zero changes.
- Revoke button copy updated from "Remove...token" to "Remove...
  connection" / "Disconnect" — no longer PAT-specific language now that
  Device Flow is the primary path.

### `popup.html`
- `#tab-settings` section restructured: added the Device Flow block
  (`#settings-device-connect-btn`, `#settings-device-code`,
  `#settings-device-status`, `#settings-device-cancel-btn`) above the
  existing token form.
- Existing PAT `#settings-token-entry` field wrapped in a `<details>`
  element with summary "Use a personal access token instead."
- "How this is protected" copy updated to mention `github.com` alongside
  `api.github.com` as a request destination (previously only mentioned
  `api.github.com`).

### `popup.css`
- Added `.device-code-box` / `.device-code-value` styling for the
  Device Flow code display — monochrome, matches the existing design
  system (mono font, tabular numerals, no new colors introduced).

### `test/module2.test.mjs`
- Import line updated to include `MAX_TRACKED` alongside the existing
  `MAX_PINNED`, `MAX_HISTORY` imports.
- Three new test cases added:
  - 11th tracked repo is rejected; list still holds exactly 10 after the
    rejected attempt.
  - `MAX_TRACKED` being full does not block pinning within that list
    (confirms the two caps are genuinely independent).
  - Removing one tracked repo frees a slot for a new one under the cap.

---

## 6. Files deliberately NOT touched this session

`lib/tokenVault.js`, `lib/pulse.js`, `lib/storageAdapter.js`,
`lib/authState.js`, `pulseView.js`, `projectsView.js`, `popup.js`,
`toast.js` — none of them needed to know a token can now arrive via
Device Flow instead of paste. `saveToken()` / `getToken()` as the sole
contract between "how a token was acquired" and "everything that uses a
token" held without modification, which was the intended payoff of the
vault's existing design (see §3 of the original context doc).

---

## 7. What's NOT done yet (additions to the original §7 list)

- **No live-browser confirmation of the full Device Flow UX polish** —
  functionally confirmed working (GitHub's approval screen reached,
  extension correctly reflects the connected state after the §3 fix), but
  the ~1-minute alarm-interval wait after approval hasn't been evaluated
  for whether it needs its own "hang tight, this can take a minute"
  messaging beyond the current status line.
- **`repo` scope's actual GitHub approval-screen wording** was flagged as
  worth reviewing (it says things like "Full control of private
  repositories," which may read as more alarming than the "just my
  streak" framing a user expects) — not yet revisited after the scope
  decision was locked in.
- **No test coverage for `background.js` itself** — `deviceFlow.test.mjs`
  covers the pure functions it calls, but the alarm-driven orchestration
  logic in `background.js` (session persistence, alarm scheduling,
  the slow_down interval update) has no automated tests yet. Hand-rolled
  Node scripts can't easily fake `chrome.alarms`/`chrome.storage` the way
  `fakeIndexedDB.mjs` fakes IndexedDB for `tokenVault.test.mjs` — would
  need an equivalent fake built first.
- **10-repo cap's UI-side messaging** — `projectStore.js` rejects the
  11th `create()` with a clear error, but `projectsView.js`'s "Track a
  repo" form doesn't yet proactively hide/disable itself or show a
  "10/10 tracked" indicator before the user hits the rejection — currently
  surfaces only as an `alert()` on the failed attempt, same as the
  existing duplicate-id rejection.
- **Reward-system / streak-target / contribution-target psychology
  layer** — untouched, as agreed at the start of this session. Next
  session's scope.