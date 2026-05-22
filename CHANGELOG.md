# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tags: `vX.Y.Z` are immutable releases; the `vN` tag is a moving alias that always
points at the latest `N.x` release, so `github:Facilitra/next-cache-handler#v1`
keeps receiving compatible fixes.

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
