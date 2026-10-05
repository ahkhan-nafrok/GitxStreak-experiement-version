// lib/authState.js
// Small, non-sensitive pieces of state kept in chrome.storage.local
// (deliberately NOT in the encrypted vault — none of these is a secret):
//
//   1. ghTokenAuthFailed — has the saved token started failing auth (401)?
//   2. ghHasEverConnected — has a token EVER been saved on this install?
//      Set once, never cleared by disconnect, so Settings can tell "never
//      connected" from "disconnected".
//   3. ghGrantedScopes — the OAuth scopes GitHub says the saved token has
//      (array), or null when unknown (fine-grained tokens, older installs).
//      Drives honest Settings copy; never used to GRANT anything.
//   4. ghConnectionId — a random id minted every time a token is saved and
//      deleted on disconnect. Cached account data (the Pulse cache) is
//      stamped with it and only trusted while it still matches, so data
//      fetched under one connection can never be shown under another.

const AUTH_FAILED_KEY = "ghTokenAuthFailed";
const HAS_CONNECTED_KEY = "ghHasEverConnected";
export const CONNECTION_ID_KEY = "ghConnectionId";
export const GRANTED_SCOPES_KEY = "ghGrantedScopes";

export async function getAuthFailed(adapter) {
  const data = await adapter.get([AUTH_FAILED_KEY]);
  return !!data[AUTH_FAILED_KEY];
}

export async function setAuthFailed(adapter, failed) {
  await adapter.set({ [AUTH_FAILED_KEY]: !!failed });
}

export async function getHasEverConnected(adapter) {
  const data = await adapter.get([HAS_CONNECTED_KEY]);
  return !!data[HAS_CONNECTED_KEY];
}

export async function setHasEverConnected(adapter, val) {
  await adapter.set({ [HAS_CONNECTED_KEY]: !!val });
}

/** Current connection id, or null if there's no active connection. */
export async function getConnectionId(adapter) {
  const data = await adapter.get([CONNECTION_ID_KEY]);
  return data[CONNECTION_ID_KEY] || null;
}

/** Mints and stores a fresh connection id — call whenever a token is saved. */
export async function rotateConnectionId(adapter) {
  const id = crypto.randomUUID();
  await adapter.set({ [CONNECTION_ID_KEY]: id });
  return id;
}

/** Returns the current id, minting one if absent (installs that connected
 * before this field existed get one on first Pulse load). */
export async function ensureConnectionId(adapter) {
  return (await getConnectionId(adapter)) || (await rotateConnectionId(adapter));
}

/** Granted OAuth scopes as an array, or null if unknown. */
export async function getGrantedScopes(adapter) {
  const data = await adapter.get([GRANTED_SCOPES_KEY]);
  const v = data[GRANTED_SCOPES_KEY];
  return Array.isArray(v) ? v : null;
}

export async function setGrantedScopes(adapter, scopes) {
  await adapter.set({ [GRANTED_SCOPES_KEY]: Array.isArray(scopes) ? scopes : null });
}
