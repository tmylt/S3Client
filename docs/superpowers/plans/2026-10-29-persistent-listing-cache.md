# Persistent S3 listing cache

**Goal:** Restore successful folder listings locally and make no S3 listing requests during application startup, even when no cached result exists.

**Architecture:** An atomic, bounded JSON cache in Electron's userData directory stores only folder/file metadata. Main-process listing calls save successful results; a startup snapshot returns connection settings plus matching cached listings without starting Python or unlocking S3 credentials. The renderer uses restored data until the user explicitly refreshes or opens an uncached folder.

## Shared contract

```ts
interface CachedListing extends Listing {
  connectionId: string;
  prefix: string;
  updatedAt: string;
}
interface CacheScope { id: string; endpoint: string; bucket: string; prefix: string }
```

`S3API.connections()` adds optional `cachedListings: CachedListing[]`.

## Task 1 — Cache storage

Own `src/main/listing-cache.ts` and `tests/listing-cache.test.ts`. Implement `ListingCache(directory: string)` with:

```ts
all(connections: readonly CacheScope[]): Promise<CachedListing[]>
version(connectionId: string): number
put(connection: CacheScope, prefix: string, listing: Listing, version: number): Promise<void>
invalidate(connectionId: string): Promise<void>
```

- [x] Tests first: successful/empty listings survive restart, scope/prefix boundaries are exact, invalid/corrupt caches fall back to empty, only metadata is persisted, atomic concurrent writes, mutation generations prevent stale writes, and invalidation persists.
- [x] Store `listing-cache.json`, version 1, private directory/file permissions, serialized atomic rename. Validate persisted records and entry shapes and immediate-child containment; preserve raw S3 keys. Bind each record to endpoint, bucket and configured root prefix. Ignore unknown connection IDs during restore.
- [x] Invalidate increments the version synchronously before awaiting disk I/O, so requests already running cannot repopulate stale data. Put checks its supplied generation inside the write queue.
- [x] Bound cache to 200 folders and 32 MiB, evicting oldest listing timestamps. Read oversized files safely as empty. Do not store credentials or arbitrary extra fields.
- [x] Run focused Vitest tests and write `/tmp/s3-listing-cache-report.md`.

## Task 2 — Main-process integration and renderer

Own shared types, `src/main/listings.ts`, main/preload changes, renderer changes, and their tests.

- [x] Test startup snapshot without worker calls, cache writes after successful listings, retention on failed refresh, and invalidation of in-flight requests after edit/remove.
- [x] Create a testable ListingService combining ConnectionStore, PythonBridge and ListingCache. Main IPC routes connection snapshots/list/save/remove through this service; copy preserves the original cache and starts with its own connection identity.
- [x] Hydrate renderer node state before selecting the initial root. Suppress the initial location's listing effect. Explicit selection, expansion, add/copy and refresh keep normal user-triggered loading behavior.
- [x] Show a List folder action when no cached result exists; show a Cached label and timestamp for restored data. Failed refresh preserves the previous listing and presents an inline retry notice.
- [x] Add meaningful renderer regressions for cache hit/miss startup, manual refresh, stale refresh responses, and edit/remove invalidation. Update older tests to explicitly open folders rather than rely on the removed startup request.

## Task 3 — Delivery

- [x] Add desktop integration coverage proving startup restores cached listings with zero worker calls, including unavailable credentials, and explicit Refresh reaches S3.
- [x] Run unit tests, typecheck/build, and desktop tests. Rebuild the unpacked app in staging with the installed Electron runtime and atomically update the desktop shortcut's app.asar.
- [x] Document cache path, manual refresh semantics, limits, and upgrade/restart instructions. Review cache/main/renderer behavior for stale request races and data-scope mismatches.

## Final verification

- `npm test`: 73 tests passed across seven suites.
- `npm run build`: TypeScript and main/preload/renderer production bundles passed.
- Staging package built with electron-builder and the installed Electron runtime; app.asar atomically updated at the desktop shortcut's existing executable location.
- `npm run test:e2e`: both source and packaged desktop tests passed. Cache-hit and cache-miss restarts made zero S3 listing requests and did not start Python. Cached folders remained navigable without credentials; manual requests continued working.
- Superseded same-folder refresh writes were reproduced with a failing test, fixed using per-folder request tokens, and verified alongside independent concurrent folder caching.
- Final integration review approved with no Important findings. `git diff --check` passed. Source remains in the supplied checkout without Git commits.
