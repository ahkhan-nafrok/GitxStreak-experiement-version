// A chrome.storage-honest adapter: async, optional jittered latency, and
// get()/set() copy values (structuredClone) so shared-reference bugs can't hide.
export function makeAdapter({ jitterMs = 0, shared = null } = {}) {
  const store = shared || {};
  const wait = () => (jitterMs ? new Promise((r) => setTimeout(r, Math.random() * jitterMs)) : Promise.resolve());
  return {
    async get(keys) {
      await wait();
      const out = {};
      for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(obj) {
      await wait();
      for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
    },
    _store: store,
  };
}

// Small seeded PRNG so "random" tests are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** { key: {count} } for `days` consecutive days ending at todayKey; p = chance a day is active. */
export function randomDayMap(rand, todayKey, days, p, { addDays }) {
  const m = {};
  for (let i = 0; i < days; i++) {
    const k = addDays(todayKey, -i);
    m[k] = { count: rand() < p ? 1 + Math.floor(rand() * 9) : 0 };
  }
  return m;
}
