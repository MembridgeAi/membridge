// A small in-memory, TTL-bounded cache of in-flight/just-finished promises,
// keyed by request identity. This exists because two DIFFERENT react-query
// keys can hit the SAME underlying daemon endpoint at nearly the same
// moment -- e.g. useStatus() and useSettings() both mount together on every
// screen, and getSettings() independently re-fetches /api/status internally.
// react-query's own de-duplication only sees one queryKey at a time, so it
// can't catch that; this sits one layer lower, at the fetch call itself,
// where the duplicate is actually visible.
//
// Originally this pattern existed only for /api/feed (LocalDaemonClient's
// old private feedCache); it is generalized here so /api/status and
// /api/team can reuse it instead of a second bespoke cache.
export class ShortTtlCache {
  private entries = new Map<string, { promise: Promise<unknown>; fetchedAt: number }>()

  constructor(private readonly ttlMs: number) {}

  /** Returns the cached in-flight/recent promise for `key` if it is within
   *  the TTL, otherwise calls `fetcher` and caches the result. A rejected
   *  fetch is evicted immediately so the next caller retries instead of
   *  replaying the same failure for the rest of the TTL window. */
  get<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const cached = this.entries.get(key)
    if (cached && now - cached.fetchedAt < this.ttlMs) return cached.promise as Promise<T>

    const promise = fetcher()
    this.entries.set(key, { promise, fetchedAt: now })
    promise.catch(() => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key)
    })
    return promise
  }

  /** Drops every cached entry whose key starts with `prefix` -- used after a
   *  mutation whose effect this cache cannot observe on its own (e.g. a sync
   *  that adds feed events the cached page doesn't have yet). */
  deleteMatching(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  /** Drops every cached entry -- used for a mutation with wide-reaching,
   *  hard-to-scope effects (e.g. leaving a team changes what /api/team and
   *  /api/status both report). */
  clear(): void {
    this.entries.clear()
  }
}
