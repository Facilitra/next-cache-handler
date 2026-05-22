/**
 * Mirror of Next.js 16's internal cache-handler contract
 * (next/dist/server/lib/cache-handlers/types). Re-declared locally so this
 * package does not depend on Next's internal file layout, which is not a
 * stable public import path.
 */
export type Timestamp = number;
export interface CacheEntry {
    /** RSC payload. May still be pending and may error / be partial. */
    value: ReadableStream<Uint8Array>;
    /** Tags for the entry, excluding soft tags. */
    tags: string[];
    /** Client hint, not used for expiration [seconds]. */
    stale: number;
    /** When the entry was created [ms since epoch]. */
    timestamp: Timestamp;
    /** How long the entry may be used [seconds]. */
    expire: number;
    /** How long until the entry should be revalidated [seconds]. */
    revalidate: number;
}
export interface CacheHandler {
    get(cacheKey: string, softTags: string[]): Promise<undefined | CacheEntry>;
    set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
    refreshTags(): Promise<void>;
    getExpiration(tags: string[]): Promise<Timestamp>;
    updateTags(tags: string[], durations?: {
        expire?: number;
    }): Promise<void>;
}
