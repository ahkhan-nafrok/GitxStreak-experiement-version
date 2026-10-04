// lib/net.js
// The ONE place network calls get a deadline. A bare fetch() has no timeout,
// so a stalled connection leaves a UI stuck on "Updating..." (or a poll
// hanging) forever. Everything that talks to GitHub goes through here.
//
//   fetchWithTimeout  — single attempt with a deadline. Use for POSTs
//                       (not safely repeatable) and anything caller-retried.
//   fetchGetWithRetry — GET only: one retry (configurable) on a network
//                       error/timeout or a 5xx, with backoff. 4xx (auth,
//                       404, rate limits) are NEVER retried — retrying a
//                       rate limit just makes it worse.
//
// Failures surface as NetworkError so callers can tell "couldn't reach
// GitHub" apart from "GitHub answered with an error".

/** Mutable on purpose: tests shrink these so retry paths run instantly. */
export const netConfig = { timeoutMs: 15000, retries: 1, baseDelayMs: 400 };

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = "NetworkError";
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithTimeout(url, options = {}, timeoutMs = netConfig.timeoutMs) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new NetworkError("GitHub didn't respond in time — check your connection and try again.");
    }
    throw new NetworkError(`Network error: ${e?.message || e}`);
  }
}

export async function fetchGetWithRetry(url, options = {}, overrides = {}) {
  const { retries, baseDelayMs, timeoutMs } = { ...netConfig, ...overrides };
  const sleep = overrides.sleep || defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.status >= 500 && attempt < retries) {
        attempt++;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      return res;
    } catch (e) {
      if (!(e instanceof NetworkError) || attempt >= retries) throw e;
      attempt++;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
