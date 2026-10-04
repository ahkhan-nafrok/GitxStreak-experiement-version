// lib/connection.js
// The two operations that change which account the extension is connected
// to. Both the popup (manual token paste) and the service worker (device
// flow success) call these, so connect/disconnect side effects can't drift
// between the two paths.

import { saveToken, revokeToken } from "./tokenVault.js";
import { setAuthFailed, setHasEverConnected, rotateConnectionId } from "./authState.js";
import { clearAccountData } from "./accountData.js";
import { createProjectStore } from "./projectStore.js";

/** Saves the token, marks the connection healthy, and mints a new
 * connection id — which instantly invalidates any cache from a previous
 * connection. */
export async function saveConnection(adapter, token) {
  await saveToken(adapter, token);
  await rotateConnectionId(adapter);
  await setAuthFailed(adapter, false);
  await setHasEverConnected(adapter, true);
}

/** Local disconnect: removes the token and key, the cached account data, and
 * tracked repos known to be private. Does NOT revoke anything on GitHub's
 * side (that's github.com/settings/tokens or /settings/applications).
 * ghHasEverConnected is deliberately left alone. */
export async function disconnect(adapter) {
  await revokeToken(adapter);
  await setAuthFailed(adapter, false);
  await clearAccountData(adapter);
  await createProjectStore(adapter).removePrivate();
}
