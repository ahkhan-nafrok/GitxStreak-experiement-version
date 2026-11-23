// lib/progression/sync.js
// The one call the rest of the app makes into the progression system: "here is
// a freshly fetched Pulse cache — pay out whatever it justifies". It adds no
// network traffic of its own; it reads what Pulse already fetched.

import { createProjectStore } from "../projectStore.js";
import { createProgressionStore } from "./store.js";

export async function syncProgressionFromPulse(adapter, cache, { now = new Date() } = {}) {
  if (!cache || !cache.viewerId || !cache.dayMap || !cache.asOfDateKey) return { status: "no-identity" };
  const trackedRepoCount = (await createProjectStore(adapter).list()).length;
  return createProgressionStore(adapter).sync({
    userId: cache.viewerId,
    dayMap: cache.dayMap,
    todayKey: cache.asOfDateKey, // the UTC day the data was fetched for — the same "today" Pulse uses
    trackedRepoCount,
    now,
  });
}
