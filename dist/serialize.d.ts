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
 * Serialize a resolved CacheEntry to the wire shape. Returns null if the value
 * stream errored mid-flight (do not cache partial data).
 */
export declare function serializeEntry(entry: CacheEntry): Promise<StoredEntry | null>;
/** Rebuild a fresh CacheEntry (with a new readable stream) from stored bytes. */
export declare function deserializeEntry(stored: StoredEntry): CacheEntry;
