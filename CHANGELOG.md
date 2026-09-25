# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags: `vX.Y.Z` are immutable releases; the `vN` tag is a moving alias that always
points at the latest `N.x` release, so `github:Facilitra/next-cache-handler#v1`
keeps receiving compatible fixes.

## [2.0.0] - 2026-09-25

### Changed
- **BREAKING: peer dependency is now `ioredis@^6`.** ioredis 6 speaks RESP3 by
  default. The handler only uses `GET`, `SET … EX`, `HMGET` and `HSET`, whose
  replies are unchanged under RESP3, so no code changed. Apps still on ioredis 5
  should stay on `#v1`, which keeps pointing at 1.0.4.
- Dev tooling: vitest 5, @types/node 26. CI runs on Node 24 (vitest 5 needs
  Node >= 22); `engines` stays at Next's floor of `>=20.9.0`.
- `next` and `vite` are now explicit dev dependencies instead of auto-installed
  peers, which had drifted to vulnerable versions (next 16.2.6, vite 7.3.3).
  Dev-only; consumers bring their own `next`.

## [1.0.4] - 2026-08-15

### Fixed
- **Tag invalidation now crosses releases.** The tag manifest was namespaced by
  `version` alongside the entries, so during a rolling deploy a pod on the new
  release wrote `<prefix><newSha>:tags` while pods still serving the old release
  read `<prefix><oldSha>:tags`. An invalidation issued mid-rollout never reached
  the draining pods, which kept serving stale content until they terminated, and
  a post-deploy `revalidateTag("all")` purge could not reach them either.
  Transient and self-healing, so easy to never notice.

  The manifest now hangs off the unversioned `keyPrefix`. Entries stay versioned:
  their *shape* is release-specific, whereas tag timestamps are absolute epoch
  millis that mean the same thing to every release. Consumers that do not set
  `version` are unaffected - their keys are unchanged.

  This also stops a small leak: entries expire via their TTL, but the tag hash is
  never given one, so a versioned manifest orphaned one Redis key per deploy.

  Consumers pick this up on their next `pnpm install`. The first read after
  upgrading sees an empty manifest and recomputes; there is no migration.

## [1.0.3] - 2026-06-10

### Fixed
- **Never cache an empty payload.** `serializeEntry` previously stored a
  zero-byte stream as a valid entry. On read it rebuilt an empty stream and
  Next's app-page template did `JSON.parse("")`, throwing "Unexpected end of
  JSON input" - a 500 on every hit until the entry's TTL expired. An empty
  stream is never a valid cacheComponents payload (a real `"use cache"` render
  always emits non-empty RSC bytes), so it is now discarded like an errored
  stream and recomputes on the next request. Observed in production on
  2026-06-10 after empty entries were written during a DB-saturation incident
  and poisoned pages for hours.

[1.0.3]: https://github.com/Facilitra/next-cache-handler/releases/tag/v1.0.3

## [1.0.2] - 2026-05-22

### Fixed
- **`get()` now honors tag revalidation.** Previously `get()` only checked the
  entry's own TTL and ignored the tag manifest, so `revalidateTag()` /
  `updateTag()` were effectively no-ops: stale entries (including build-time
  prerendered values like a disabled feature flag) were served until their
  `cacheLife` TTL across every pod. `get()` now compares each entry's tags
  against the shared revalidation manifest and treats the entry as a miss when
  any tag was revalidated after the entry was written, matching Next's default
  handler (`areTagsExpired`). This makes `revalidateTag`/purge work cluster-wide.

[1.0.2]: https://github.com/Facilitra/next-cache-handler/releases/tag/v1.0.2

## [1.0.1] - 2026-05-22

### Changed
- Ship the prebuilt `dist/` in the repo and drop the `prepare` build script, so
  `github:`-installed consumers need no build step, no build-script allowlist,
  and work cleanly under Docker / `--frozen-lockfile`.
- Remove the unused `next` devDependency (the contract types are declared
  locally in `src/types.ts`; `next` remains a peer dependency). Cuts CI install
  time substantially and stops nested git-installs from pulling `sharp`.

### Fixed
- Skip opening a Redis connection during `next build` (detected via
  `NEXT_PHASE`). A live ioredis client's background reconnection timer kept the
  build process from exiting after prerender; build now uses the memory path
  and exits cleanly.
- Remove the `pnpm-workspace.yaml` that lacked a `packages:` field and broke
  `pnpm store path` in CI.

### Added
- `version` option: a per-release id folded into the key namespace so pods of
  different code versions don't share cache entries during a rolling deploy.
- Vitest suite (serialize round-trip + handler behavior over a fake Redis and
  the memory-fallback path), wired into CI.
- `.gitattributes` enforcing LF so the committed `dist/` matches CI's build.

## [1.0.0] - 2026-05-22

### Added
- `createCacheHandler()` factory implementing the Next.js 16 cacheComponents
  cache-handler contract (`get` / `set` / `refreshTags` / `getExpiration` /
  `updateTags`) over Redis/Valkey via `ioredis`.
- Distributed tag invalidation through a shared Redis hash of tag timestamps,
  so `revalidateTag()` on one instance is seen by all instances.
- Per-process memory fallback on any Redis failure (including `next build` with
  no Redis reachable); the handler never throws.
- RSC stream buffered and base64-encoded on `set`, with partial/errored streams
  discarded; a fresh stream is rebuilt on `get`.
- Options: `redisUrl`, `client`, `keyPrefix`, `minTtlSeconds`, `debug`.

[1.0.1]: https://github.com/Facilitra/next-cache-handler/releases/tag/v1.0.1
[1.0.0]: https://github.com/Facilitra/next-cache-handler/releases/tag/v1.0.0
