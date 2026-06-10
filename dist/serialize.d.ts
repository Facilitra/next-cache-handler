import type { CacheEntry } from "./types.js";
/**
 * Wire shape we persist. The RSC payload (a ReadableStream<Uint8Array>) is
 * buffered to base64 so the whole entry round-trips through a single Redis
 * string. Base64 costs ~33% size; acceptable for a first cut and far simpler
 * than a binary hash field. Optimize later if payload sizes warrant it.
 */
export interface StoredEntry {
    value: string;
    tags: string[];
    stale: number;
    timestamp: number;
    expire: number;
    revalidate: number;
}
/**
 * Serialize a resolved CacheEntry to the wire shape. Returns null when the
 * payload must not be cached: either the value stream errored mid-flight, or it
 * produced zero bytes.
 *
 * An empty (zero-byte) payload is never a valid cacheComponents entry - a real
 * "use cache" render always emits a non-empty RSC stream. If one is stored, the
 * reader rebuilds an empty stream and Next's app-page template does
 * `JSON.parse("")`, throwing "Unexpected end of JSON input" -> a 500 on every
 * hit until the entry's TTL expires (observed 2026-06-10: empty entries written
 * during a DB-saturation incident poisoned pages for hours). Treat empty like
 * errored and skip caching so the value recomputes on the next request.
 */
export declare function serializeEntry(entry: CacheEntry): Promise<StoredEntry | null>;
/** Rebuild a fresh CacheEntry (with a new readable stream) from stored bytes. */
export declare function deserializeEntry(stored: StoredEntry): CacheEntry;
