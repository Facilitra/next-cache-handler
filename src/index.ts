import Redis from "ioredis";
import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";
import {
  serializeEntry,
  deserializeEntry,
  type StoredEntry,
} from "./serialize.js";

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
export function createCacheHandler(
  options: CacheHandlerOptions = {},
): CacheHandler {
  const keyPrefix = options.keyPrefix ?? "next-cache:";
  const minTtl = options.minTtlSeconds ?? 60;
  const debug = options.debug ?? false;
  const entryKey = (cacheKey: string) => `${keyPrefix}entry:${cacheKey}`;
  const tagsHashKey = `${keyPrefix}tags`;

  // ── Per-process fallbacks (used only when Redis is unreachable) ──
  const memEntries = new Map<string, { stored: StoredEntry; expiresAt: number }>();
  const memTags = new Map<string, number>();
  // Per-process map to resolve the get/set race for the same key.
  const pendingSets = new Map<string, Promise<void>>();

  let client: Redis | null = options.client ?? null;
  let clientUnavailable = false;

  function getClient(): Redis | null {
    if (clientUnavailable) return null;
    if (client) return client;
    try {
      client = new Redis(options.redisUrl ?? process.env["REDIS_URL"] ?? "redis://localhost:6379", {
        // Fail commands fast instead of queueing when not connected, so build
        // time / outages fall back to memory immediately rather than hanging.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
      // Best-effort connect; swallow errors so a down Redis never throws here.
      client.on("error", () => {});
      client.connect().catch(() => {});
      return client;
    } catch (err) {
      clientUnavailable = true;
      if (debug) console.warn("[next-cache-handler] Redis init failed:", err);
      return null;
    }
  }

  function log(...args: unknown[]) {
    if (debug) console.warn("[next-cache-handler]", ...args);
  }

  function ttlFor(stored: StoredEntry): number {
    return Math.max(stored.expire, stored.revalidate, stored.stale, minTtl);
  }

  async function readStored(cacheKey: string): Promise<StoredEntry | undefined> {
    const c = getClient();
    if (c) {
      try {
        const raw = await c.get(entryKey(cacheKey));
        return raw ? (JSON.parse(raw) as StoredEntry) : undefined;
      } catch (err) {
        log("get fallback to memory:", err);
      }
    }
    const mem = memEntries.get(cacheKey);
    if (!mem) return undefined;
    if (Date.now() > mem.expiresAt) {
      memEntries.delete(cacheKey);
      return undefined;
    }
    return mem.stored;
  }

  async function writeStored(cacheKey: string, stored: StoredEntry): Promise<void> {
    const ttl = ttlFor(stored);
    const c = getClient();
    if (c) {
      try {
        await c.set(entryKey(cacheKey), JSON.stringify(stored), "EX", ttl);
        return;
      } catch (err) {
        log("set fallback to memory:", err);
      }
    }
    memEntries.set(cacheKey, { stored, expiresAt: Date.now() + ttl * 1000 });
  }

  return {
    async get(cacheKey: string): Promise<CacheEntry | undefined> {
      // If a set for this key is in-flight, wait for it (Next contract).
      const pending = pendingSets.get(cacheKey);
      if (pending) await pending.catch(() => {});

      const stored = await readStored(cacheKey);
      if (!stored) return undefined;

      // Honor the entry's own lifetime defensively (Redis TTL is the primary
      // guard, but the memory fallback and clock skew make this worthwhile).
      if (Date.now() > stored.timestamp + ttlFor(stored) * 1000) {
        return undefined;
      }
      return deserializeEntry(stored);
    },

    async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
      let resolve!: () => void;
      const gate = new Promise<void>((r) => (resolve = r));
      pendingSets.set(cacheKey, gate);
      try {
        const entry = await pendingEntry;
        const stored = await serializeEntry(entry);
        // serializeEntry returns null if the stream errored - skip caching
        // partial/corrupt payloads.
        if (stored) await writeStored(cacheKey, stored);
      } catch (err) {
        log("set failed:", err);
      } finally {
        resolve();
        pendingSets.delete(cacheKey);
      }
    },

    async refreshTags(): Promise<void> {
      // No local tag manifest: getExpiration reads live from the shared store,
      // so there is nothing to refresh. Kept as a no-op to satisfy the contract.
    },

    async getExpiration(tags: string[]): Promise<Timestamp> {
      if (tags.length === 0) return 0;
      const c = getClient();
      if (c) {
        try {
          const vals = await c.hmget(tagsHashKey, ...tags);
          let max = 0;
          for (const v of vals) {
            if (v) {
              const n = Number(v);
              if (n > max) max = n;
            }
          }
          return max;
        } catch (err) {
          log("getExpiration fallback to memory:", err);
        }
      }
      let max = 0;
      for (const tag of tags) {
        const n = memTags.get(tag);
        if (n && n > max) max = n;
      }
      return max;
    },

    async updateTags(tags: string[]): Promise<void> {
      if (tags.length === 0) return;
      const now = Date.now();
      const c = getClient();
      if (c) {
        try {
          const pairs: Record<string, string> = {};
          for (const tag of tags) pairs[tag] = String(now);
          await c.hset(tagsHashKey, pairs);
          return;
        } catch (err) {
          log("updateTags fallback to memory:", err);
        }
      }
      for (const tag of tags) memTags.set(tag, now);
    },
  };
}

export default createCacheHandler;
