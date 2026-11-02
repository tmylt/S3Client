# Transfer Row Removal Implementation Plan

**Goal:** Add Clear all to each transfer list and a trash button to every task/preparation row.

**Design:** Use the existing app-styled confirmation for both actions, keeping Cancel as the default. Explain that active transfers are cancelled and completed local files/S3 objects are kept. Clear all affects only the open direction and every pagination page. Show busy state during cancellation and adjust pagination when rows disappear.

**Architecture:** Dedicated remove/clear methods pass through the typed bridge to main-process confirmations. TransferService cancels/drains preparations, handles a preparation becoming queued tasks during confirmation, and blocks new admissions while a direction is cleared. TransferQueue cancels/drains selected workers before deleting durable metadata, guards against restart during removal, and emits history changes without creating spurious S3 refreshes. Download filename reservations are released after their group is removed.

**Constraints:** Never delete completed local files or S3 objects. Preserve other direction, concurrency and queue pause settings. Prevent late preparation/worker results from recreating removed rows. No new dependencies, real-cloud operations, credential reads, or restarting the user's app. Git metadata is read-only.

- [x] Observe regressions for durable removal, cleanup waits, preparation races, direction isolation and no extra remote refreshes.
- [x] Implement queue/service operations, typed IPC and app-styled confirmations.
- [x] Add per-row trash buttons, Clear all, busy/error and pagination behavior with UI tests.
- [x] Verify unit/build and isolated source/packaged desktop cancellation/history persistence; package/install atomically and update docs.
