import { describe, it, expect } from "vitest";
import type Redis from "ioredis";
import { createCacheHandler } from "./index.js";
import type { CacheEntry } from "./types.js";

/**
 * Minimal in-memory ioredis stand-in implementing only the commands the
 * handler uses (get/set/hmget/hset). Cast to Redis via the `client` option.
 */
class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  // signature: set(key, value, "EX", ttl)
  async set(key: string, value: string): Promise<"OK"> {
    this.strings.set(key, value);
    return "OK";
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    const h = this.hashes.get(key);
    return fields.map((f) => h?.get(f) ?? null);
  }

  async hset(key: string, pairs: Record<string, string>): Promise<number> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    let added = 0;
    for (const [f, v] of Object.entries(pairs)) {
      if (!h.has(f)) added++;
      h.set(f, v);
    }
    return added;
  }
}

/** A client whose every command rejects, to force the memory fallback path. */
class ThrowingRedis {
  async get(): Promise<never> {
    throw new Error("redis down");
  }
  async set(): Promise<never> {
    throw new Error("redis down");
  }
  async hmget(): Promise<never> {
    throw new Error("redis down");
  }
  async hset(): Promise<never> {
    throw new Error("redis down");
  }
}

function streamOf(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function makeEntry(bytes: number[], overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    value: streamOf(bytes),
    tags: ["a"],
    stale: 5,
    timestamp: Date.now(),
    expire: 120,
    revalidate: 60,
    ...overrides,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Array.from(Buffer.concat(chunks));
}

function handlerWith(client: unknown) {
  return createCacheHandler({ client: client as Redis, keyPrefix: "test:" });
}

describe.each([
  ["redis path (fake ioredis)", () => new FakeRedis()],
  ["memory fallback (throwing client)", () => new ThrowingRedis()],
])("createCacheHandler - %s", (_label, makeClient) => {
  it("set then get returns an equivalent entry", async () => {
    const h = handlerWith(makeClient());
    const bytes = [10, 20, 30];
    await h.set("k1", Promise.resolve(makeEntry(bytes, { tags: ["x", "y"] })));

    const got = await h.get("k1", []);
    expect(got).toBeDefined();
    expect(got!.tags).toEqual(["x", "y"]);
    expect(got!.expire).toBe(120);
    expect(await readAll(got!.value)).toEqual(bytes);
  });

  it("get of an unknown key returns undefined", async () => {
    const h = handlerWith(makeClient());
    expect(await h.get("missing", [])).toBeUndefined();
  });

  it("getExpiration([]) returns 0", async () => {
    const h = handlerWith(makeClient());
    expect(await h.getExpiration([])).toBe(0);
  });

  it("getExpiration is 0 before updateTags, > 0 after, and >= untouched tag", async () => {
    const h = handlerWith(makeClient());
    expect(await h.getExpiration(["a"])).toBe(0);

    await h.updateTags(["a"]);

    const touched = await h.getExpiration(["a"]);
    const untouched = await h.getExpiration(["never-touched"]);
    expect(touched).toBeGreaterThan(0);
    expect(untouched).toBe(0);
    expect(touched).toBeGreaterThanOrEqual(untouched);
  });

  it("get returns undefined after a tag the entry carries is revalidated", async () => {
    const h = handlerWith(makeClient());
    // Entry written in the past so a later revalidation is unambiguously newer.
    await h.set(
      "flag",
      Promise.resolve(
        makeEntry([1], { tags: ["feature-flags"], timestamp: Date.now() - 10_000 }),
      ),
    );
    expect(await h.get("flag", [])).toBeDefined();

    // revalidateTag -> updateTags marks the tag stale "now".
    await h.updateTags(["feature-flags"]);

    expect(await h.get("flag", [])).toBeUndefined();
  });

  it("get still returns an entry written after the tag was revalidated", async () => {
    const h = handlerWith(makeClient());
    await h.updateTags(["feature-flags"]);
    // Written after the revalidation -> fresh.
    await h.set(
      "fresh",
      Promise.resolve(
        makeEntry([2], { tags: ["feature-flags"], timestamp: Date.now() + 1000 }),
      ),
    );
    expect(await h.get("fresh", [])).toBeDefined();
  });

  it("does not cache a partial/errored stream", async () => {
    const h = handlerWith(makeClient());
    const errored: CacheEntry = makeEntry([1, 2], {
      value: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.error(new Error("boom"));
        },
      }),
    });
    await h.set("bad", Promise.resolve(errored));
    expect(await h.get("bad", [])).toBeUndefined();
  });

  it("get waits for an in-flight set for the same key (race)", async () => {
    const h = handlerWith(makeClient());
    const bytes = [7, 8, 9];

    let resolveEntry!: (e: CacheEntry) => void;
    const slow = new Promise<CacheEntry>((r) => (resolveEntry = r));

    const setPromise = h.set("racy", slow);
    // get is issued while the set is still pending.
    const getPromise = h.get("racy", []);

    // Resolve the pending entry after a tick.
    setTimeout(() => resolveEntry(makeEntry(bytes, { tags: ["r"] })), 20);

    const got = await getPromise;
    await setPromise;

    expect(got).toBeDefined();
    expect(got!.tags).toEqual(["r"]);
    expect(await readAll(got!.value)).toEqual(bytes);
  });
});
