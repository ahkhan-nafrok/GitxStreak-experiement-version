// lib/authState.js
// Tracks two small, non-sensitive pieces of state in chrome.storage.local
// (deliberately NOT in the encrypted vault — neither of these is a secret):
//
//   1. ghTokenAuthFailed — has the currently-saved token started failing
//      auth (401)? Set the moment a view catches a GitHubAuthError, cleared
//      by a successful authenticated call or by saving a new token.
//
//   2. ghHasEverConnected — has a token ever been successfully saved, at
//      any point in this install's history? Set ONCE on first successful
//      save and never cleared by revoke. This is what lets Settings tell
//      "never used this before" apart from "used it, then disconnected" —
//      two very different situations that need different copy. Revoking
//      deliberately does NOT touch this flag.

const AUTH_FAILED_KEY = "ghTokenAuthFailed";
const HAS_CONNECTED_KEY = "ghHasEverConnected";

export async function getAuthFailed(adapter) {
  const data = await adapter.get([AUTH_FAILED_KEY]);
  return !!data[AUTH_FAILED_KEY];
}

export async function setAuthFailed(adapter, failed) {
  await adapter.set({ [AUTH_FAILED_KEY]: !!failed });
}

/** True once a token has ever been successfully saved — set once, never
 * cleared by revoke. */
export async function getHasEverConnected(adapter) {
  const data = await adapter.get([HAS_CONNECTED_KEY]);
  return !!data[HAS_CONNECTED_KEY];
}

export async function setHasEverConnected(adapter, val) {
  await adapter.set({ [HAS_CONNECTED_KEY]: !!val });
}