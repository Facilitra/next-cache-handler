import Redis from "ioredis";
import type { CacheHandler } from "./types.js";
export type { CacheEntry, CacheHandler, Timestamp } from "./types.js";
export interface CacheHandlerOptions {
    /**
     * Redis connection string. Defaults to env REDIS_URL, then localhost.
     * A Valkey URL works with the same format.
     */
    redisUrl?: string;
    /** Pre-built ioredis client. Takes precedence over redisUrl. */
    client?: Redis;
    /** Namespace for every key this app writes. Set per-app so multiple apps can share one Redis. */
    keyPrefix?: string;
    /** Floor for the Redis TTL on each entry [seconds]. Default 60. */
    minTtlSeconds?: number;
    /** Log fallbacks/errors to console. Default false. */
    debug?: boolean;
}
/**
 * Build a Next.js 16 cacheComponents ("use cache") cache handler backed by a
 * shared Redis/Valkey store, so the data cache AND tag invalidation are
 * consistent across every instance/pod.
 *
 * Every Redis op degrades to an in-process Map on failure (e.g. Redis
 * unreachable during `next build`, or a transient outage) and never throws,
 * so builds and request handling keep working - just without cross-pod sharing
 * until Redis is reachable again.
 */
export declare function createCacheHandler(options?: CacheHandlerOptions): CacheHandler;
export default createCacheHandler;
