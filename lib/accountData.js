// lib/accountData.js
// Everything cached on disk that derives from the connected GitHub account
// (as opposed to the token itself, which tokenVault.js owns).

import { CONNECTION_ID_KEY } from "./authState.js";

export const PULSE_CACHE_KEY = "ghContributionCache";

/** A cache is only trusted if it was written under the CURRENT connection.
 * Anything else (other account, written before a disconnect, written before
 * this check existed) is treated as absent. */
export function cacheBelongsTo(cache, connectionId) {
  return !!cache && !!connectionId && cache.connectionId === connectionId;
}

/** Wipes the Pulse cache and the connection id. Called on disconnect. */
export async function clearAccountData(adapter) {
  await adapter.set({ [PULSE_CACHE_KEY]: null, [CONNECTION_ID_KEY]: null });
}
