# @facilitra/next-cache-handler

[![CI](https://github.com/Facilitra/next-cache-handler/actions/workflows/ci.yml/badge.svg)](https://github.com/Facilitra/next-cache-handler/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A small, dependency-light **Redis/Valkey cache handler for Next.js 16 `cacheComponents`** (the `"use cache"` directive).

By default each Next.js instance keeps its `"use cache"` data in process memory, and `revalidateTag()` only clears the instance that handled the mutation. Behind more than one pod that means **stale reads and 404s after creating or updating content** until every instance happens to re-render. This handler moves the data cache *and* the tag-invalidation manifest into a shared Redis store, so one `revalidateTag()` is seen by every instance.

- Implements the Next.js 16 cache-handler contract: `get / set / refreshTags / getExpiration / updateTags`
- Distributed tag invalidation via shared timestamps (the pattern Next intends for multi-instance)
- **Never throws.** If Redis is unreachable (e.g. during `next build`, or a transient outage) it degrades to a per-process memory map instead of crashing the build or the request
- Buffers the RSC stream on `set`, discards partial/errored payloads, rebuilds a fresh stream on `get`
- ~1 file of logic, no transitive runtime deps beyond your existing `ioredis`

Requires Next.js 16+ with `cacheComponents: true` and `ioredis` (peer deps).

## Install

```bash
pnpm add github:Facilitra/next-cache-handler#v1
# ioredis is a peer dep - most apps already have it
pnpm add ioredis
```

(The repo is public, so the git install needs no token.)

## Use

Create a handler module in your app:

```js
// cache-handler.mjs
import { createCacheHandler } from "@facilitra/next-cache-handler";

// keyPrefix lets multiple apps share one Redis without colliding.
export default createCacheHandler({ keyPrefix: "myapp:" });
```

Wire it in `next.config.ts`:

```ts
const nextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: "./cache-handler.mjs",
    remote: "./cache-handler.mjs",
  },
  cacheMaxMemorySize: 0, // disable Next's per-instance in-memory cache
};
```

That's it. `"use cache"`, `cacheLife()`, `cacheTag()` and `revalidateTag()` now stay consistent across every instance.

## Options

| Option | Default | Description |
|---|---|---|
| `redisUrl` | `process.env.REDIS_URL` then `redis://localhost:6379` | Connection string (Valkey works with the same format) |
| `client` | – | Pass a pre-built `ioredis` client; takes precedence over `redisUrl` |
| `keyPrefix` | `"next-cache:"` | Namespace for all keys this app writes |
| `minTtlSeconds` | `60` | Floor for the Redis TTL on each entry |
| `debug` | `false` | Log fallbacks/errors to the console |

## How invalidation works

`updateTags(tags)` (called by Next when you `revalidateTag`) writes `tag -> now` into a shared Redis hash. `getExpiration(tags)`, called at the start of a request, returns the newest of those timestamps; Next compares it against each cached entry's creation time and treats older entries as stale. No cross-instance pub/sub and no key scanning required.

## License

MIT
