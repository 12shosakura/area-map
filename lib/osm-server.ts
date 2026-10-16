// Server-only helpers for talking to the public OSM services (Overpass + Nominatim).
//
// These are free, shared endpoints that return HTTP 429 (Too Many Requests) the
// moment you exceed their fair-use limits. Calling them straight from the browser
// with no retry/throttle/cache — as the app used to — makes 429s routine. Everything
// here exists to avoid that: retry with backoff, a global Nominatim rate gate, and
// simple in-memory caches shared across all browser tabs hitting this server.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  /** Per-attempt timeout. A hung upstream is aborted instead of waiting forever. */
  timeoutMs?: number;
  /** Absolute deadline (Date.now() ms). No new attempt/backoff starts past it. */
  deadline?: number;
}

/**
 * fetch() that retries on rate-limit / transient errors (429, 503, 504).
 * Honors the server's `Retry-After` header when present, otherwise backs off
 * exponentially. Returns the final Response even if it's still an error.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { retries = 3, baseDelayMs = 1000, timeoutMs = 15000, deadline }: RetryOptions = {}
): Promise<Response> {
  let lastRes: Response | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline ? deadline - Date.now() : timeoutMs;
    if (remaining <= 0) break;
    // Throws (AbortError/TimeoutError) if the upstream doesn't answer in time.
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
    });
    if (res.status !== 429 && res.status !== 503 && res.status !== 504) {
      return res;
    }
    lastRes = res;
    if (attempt === retries) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseDelayMs * 2 ** attempt;
    if (deadline && Date.now() + delay >= deadline) break;
    await sleep(delay);
  }
  if (!lastRes) throw new Error(`deadline exceeded: ${url}`);
  return lastRes;
}

/** Bounded time-to-live cache. Evicts the oldest entry when full. */
export class TTLCache<V> {
  private store = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number, private max = 500) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.exp) {
      this.store.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, v: V) {
    if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { v, exp: Date.now() + this.ttlMs });
  }
}

// Nominatim's usage policy allows at most 1 request per second. This gate
// serializes all outbound Nominatim calls and spaces them out, so no matter how
// fast the UI fires (autocomplete keystrokes, marker clicks) we stay compliant.
let nominatimGate: Promise<unknown> = Promise.resolve();
export function throttleNominatim<T>(
  fn: () => Promise<T>,
  minGapMs = 1100
): Promise<T> {
  const run = nominatimGate.then(fn, fn);
  nominatimGate = run.then(() => sleep(minGapMs), () => sleep(minGapMs));
  return run;
}
