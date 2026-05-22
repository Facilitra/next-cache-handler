import Redis from "ioredis";
import { serializeEntry, deserializeEntry, } from "./serialize.js";
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
export function createCacheHandler(options = {}) {
    const basePrefix = options.keyPrefix ?? "next-cache:";
    // Fold the release version into the namespace so different code versions
    // never collide on the same keys during a rolling deploy.
    const keyPrefix = options.version ? `${basePrefix}${options.version}:` : basePrefix;
    const minTtl = options.minTtlSeconds ?? 60;
    const debug = options.debug ?? false;
    const entryKey = (cacheKey) => `${keyPrefix}entry:${cacheKey}`;
    const tagsHashKey = `${keyPrefix}tags`;
    // ── Per-process fallbacks (used only when Redis is unreachable) ──
    const memEntries = new Map();
    const memTags = new Map();
    // Per-process map to resolve the get/set race for the same key.
    const pendingSets = new Map();
    let client = options.client ?? null;
    let clientUnavailable = false;
    function getClient() {
        if (clientUnavailable)
            return null;
        if (client)
            return client;
        // During `next build` Next sets NEXT_PHASE. Never open a Redis connection
        // at build time: prerendering only needs the memory fallback, and a live
        // ioredis client's background reconnection timer would keep the build
        // process from exiting (it hangs after prerender completes).
        if (process.env["NEXT_PHASE"] === "phase-production-build") {
            clientUnavailable = true;
            return null;
        }
        try {
            client = new Redis(options.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379", {
                // Fail commands fast instead of queueing when not connected, so build
                // time / outages fall back to memory immediately rather than hanging.
                enableOfflineQueue: false,
                maxRetriesPerRequest: 1,
                lazyConnect: true,
            });
            // Best-effort connect; swallow errors so a down Redis never throws here.
            client.on("error", () => { });
            client.connect().catch(() => { });
            return client;
        }
        catch (err) {
            clientUnavailable = true;
            if (debug)
                console.warn("[next-cache-handler] Redis init failed:", err);
            return null;
        }
    }
    function log(...args) {
        if (debug)
            console.warn("[next-cache-handler]", ...args);
    }
    function ttlFor(stored) {
        return Math.max(stored.expire, stored.revalidate, stored.stale, minTtl);
    }
    async function readStored(cacheKey) {
        const c = getClient();
        if (c) {
            try {
                const raw = await c.get(entryKey(cacheKey));
                return raw ? JSON.parse(raw) : undefined;
            }
            catch (err) {
                log("get fallback to memory:", err);
            }
        }
        const mem = memEntries.get(cacheKey);
        if (!mem)
            return undefined;
        if (Date.now() > mem.expiresAt) {
            memEntries.delete(cacheKey);
            return undefined;
        }
        return mem.stored;
    }
    async function writeStored(cacheKey, stored) {
        const ttl = ttlFor(stored);
        const c = getClient();
        if (c) {
            try {
                await c.set(entryKey(cacheKey), JSON.stringify(stored), "EX", ttl);
                return;
            }
            catch (err) {
                log("set fallback to memory:", err);
            }
        }
        memEntries.set(cacheKey, { stored, expiresAt: Date.now() + ttl * 1000 });
    }
    /** Most recent revalidation timestamp across the given tags (0 if none). */
    async function maxTagRevalidation(tags) {
        if (tags.length === 0)
            return 0;
        const c = getClient();
        if (c) {
            try {
                const vals = await c.hmget(tagsHashKey, ...tags);
                let max = 0;
                for (const v of vals) {
                    if (v) {
                        const n = Number(v);
                        if (n > max)
                            max = n;
                    }
                }
                return max;
            }
            catch (err) {
                log("tag lookup fallback to memory:", err);
            }
        }
        let max = 0;
        for (const tag of tags) {
            const n = memTags.get(tag);
            if (n && n > max)
                max = n;
        }
        return max;
    }
    return {
        async get(cacheKey) {
            // If a set for this key is in-flight, wait for it (Next contract).
            const pending = pendingSets.get(cacheKey);
            if (pending)
                await pending.catch(() => { });
            const stored = await readStored(cacheKey);
            if (!stored)
                return undefined;
            // Honor the entry's own lifetime defensively (Redis TTL is the primary
            // guard, but the memory fallback and clock skew make this worthwhile).
            if (Date.now() > stored.timestamp + ttlFor(stored) * 1000) {
                return undefined;
            }
            // Honor tag revalidation. revalidateTag/updateTag writes the tag's
            // timestamp to the shared manifest via updateTags(); if any of this
            // entry's tags was revalidated after the entry was written, the entry is
            // stale and must be treated as a miss. Without this check revalidateTag
            // is a no-op for cached entries (they live until their own TTL), which
            // serves stale data - including build-time prerendered values - across
            // every pod. Mirrors Next's default handler (areTagsExpired).
            if (stored.tags.length > 0) {
                const revalidatedAt = await maxTagRevalidation(stored.tags);
                if (revalidatedAt > stored.timestamp) {
                    return undefined;
                }
            }
            return deserializeEntry(stored);
        },
        async set(cacheKey, pendingEntry) {
            let resolve;
            const gate = new Promise((r) => (resolve = r));
            pendingSets.set(cacheKey, gate);
            try {
                const entry = await pendingEntry;
                const stored = await serializeEntry(entry);
                // serializeEntry returns null if the stream errored - skip caching
                // partial/corrupt payloads.
                if (stored)
                    await writeStored(cacheKey, stored);
            }
            catch (err) {
                log("set failed:", err);
            }
            finally {
                resolve();
                pendingSets.delete(cacheKey);
            }
        },
        async refreshTags() {
            // No local tag manifest: getExpiration reads live from the shared store,
            // so there is nothing to refresh. Kept as a no-op to satisfy the contract.
        },
        async getExpiration(tags) {
            return maxTagRevalidation(tags);
        },
        async updateTags(tags) {
            if (tags.length === 0)
                return;
            const now = Date.now();
            const c = getClient();
            if (c) {
                try {
                    const pairs = {};
                    for (const tag of tags)
                        pairs[tag] = String(now);
                    await c.hset(tagsHashKey, pairs);
                    return;
                }
                catch (err) {
                    log("updateTags fallback to memory:", err);
                }
            }
            for (const tag of tags)
                memTags.set(tag, now);
        },
    };
}
export default createCacheHandler;
