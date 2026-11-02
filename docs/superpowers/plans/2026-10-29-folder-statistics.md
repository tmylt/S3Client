# On-demand recursive folder statistics

**Goal:** Each folder row in the right pane has a refresh action that recursively counts all current files and sums their sizes, then shows the result, completion timestamp and elapsed scan time.

## Contract

```ts
interface FolderStats { fileCount: number; totalSize: number; updatedAt: string; durationMs: number }
// Entry optionally contains stats?: FolderStats (folder entries only).
// S3API.stats(connectionId: string, prefix: string): Promise<FolderStats>
```

The worker JSON protocol adds `method: 'stats'` with the same params as list, returning FolderStats. Use list_objects_v2 paginator with Bucket, Prefix and EncodingType=url, and no Delimiter, to count all descendant objects without downloading file contents. Ignore all keys ending in `/` (folder markers), count zero-byte files, enforce exact configured-root containment, honor extraConfig/credentials, and close clients on all paths. The completion time is UTC ISO; duration uses a monotonic clock. Scan deadline is ten minutes, with existing SDK network timeouts. No partial counts are reported on failure.

## Tasks

- [x] TDD Python aggregation: pagination, nested objects, markers, empty folders, raw keys, wrong-scope server entries, config forwarding, deadline/error cleanup and protocol dispatch. Implement stats only in backend/s3_worker.py and its tests.
- [x] Add shared FolderStats shape and runtime validation/latest-result helpers. Bridge supports stats and a ten-minute timeout, validated IPC calls the listing service with the same prefix/credential validation.
- [x] Store stats on folder entries in the existing bounded listing cache. Successful row scans update matching cached entries; regular folder refresh retains the most recent stats; changing/removing connections prevents stale scans from repopulating data. No automatic scan occurs at startup or during ordinary browsing.
- [x] Renderer has per-row loading/error and request-generation state, retains previous results on failure, and ignores results from edited/deleted connections. A stats button stops row click/double-click/keyboard events from opening the folder.
- [x] Show summed size in the Size column, add Files and Stats updated columns, and show timestamp plus elapsed duration. Keep filename/modified/type columns and regular folder navigation. Size sorting uses folder totals where known, with folders still first.
- [x] Test bridge, service, cache persistence/refresh, UI button behavior/errors and stale scan invalidation. Desktop tests scan nested/empty/paginated folders, verify persisted results on restart without new requests, and verify the packaged worker.
- [x] Review fix: separate lazy statistics/listing workers, cap concurrent statistics at four before dispatch, and test saturated/timeout isolation so scans never delay browsing.
- [x] Run JS/Python tests, typecheck/build, desktop checks, review, then atomically update app.asar and worker resources at the existing shortcut target. Document recursive current-object semantics and on-demand behavior.

## Final verification

96 JavaScript tests, 38 Python tests, typecheck/production build, and both real desktop tests pass. Desktop coverage verifies nested, empty, and paginated recursive scans, recalculation after a new file, statistics persistence across restart without S3 calls, and the packaged worker. The scheduling regression fills all four scan threads and verifies ordinary listings and listing-process survival after scan timeout. Review is clean after the isolation fix. Packaged app.asar and backend worker are installed at the existing desktop shortcut target; source and staged resource comparisons match. The user's running app was left open.
