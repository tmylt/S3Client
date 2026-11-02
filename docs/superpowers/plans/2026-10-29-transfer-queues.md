# Transfer queues implementation plan

> Use subagent-driven development for isolated backend, permission, and renderer deliverables; root integrates and verifies the queue/service.

**Goal:** Permission-controlled recursive transfers and deletion with visible, cancellable queues.

**Architecture:** Shared contracts; ConnectionStore permissions; isolated one-operation Python runner; persisted main-process scheduler/service; fixed IPC; renderer task dialogs and row actions.

**Constraints:** Defaults download=true/upload=false/delete=false; concurrency=1 per direction; no automatic transfers on startup; configured prefix containment; lazy descendant directories; credentials stay out of task/cache files; dummy credentials/local endpoints for tests; no git mutation in this untracked workspace; preserve the running user app.

- [x] Shared contracts in src/shared/transfers.ts and src/shared/types.ts; defaults helper src/shared/permissions.ts. Interfaces are the handoff contract for independent work.
- [x] Permissions: ConnectionStore normalization/save/copy/load and forOperation method, connection dialog checkboxes, focused permission tests. Owner permissions agent; exact brief /tmp/s3-transfer-permissions-brief.md.
- [x] Operations: backend/s3_operations.py, src/main/operation-runner.ts, narrow Python runtime helper export, backend/test_s3_operations.py and tests/operation-runner.test.ts; package Python resource. Owner operation agent; exact brief /tmp/s3-transfer-operations-brief.md.
- [x] Queue: src/main/transfer-queue.ts, tests/transfer-queue.test.ts. Scheduler dependency execute(task, progress, AbortSignal), metadata snapshot persistence, concurrency and generation guards. Root owns. Test serial execution and no capacity release before cancellation cleanup.
- [x] Service/paths: src/main/transfer-service.ts and src/main/transfer-paths.ts, focused tests. Root owns. Plan recursively before enqueue, create root immediately and nested parents only at execution, preserve empty leaves, cancel preparation, handle permissions/config mutation, native chooser grants and deletes.
- [x] Renderer: task dialog, hook, row/header actions and associated CSS/tests. Owner renderer agent; exact brief /tmp/s3-transfer-renderer-brief.md. Preserve keyboard navigation and existing timestamps/stats.
- [x] IPC and preload: trusted handlers/dialogs, task snapshot subscriptions, storage change events, shutdown cleanup, connection mutation cancellation. Root owns; use existing fixed-channel patterns.
- [x] Integration: run JS/Python tests/typecheck/build, real desktop tests for permissions, nested upload/download, lazy directories, progress/cancellation, delete confirmation and cached startup; independent review and fix findings.
- [x] Document behavior, stage package, atomically replace app.asar and bundled Python resources, verify packaged app, leave user app running and report completion.

## Completion evidence (2026-10-30)

162 JavaScript tests, 59 Python tests, typecheck and production build passed after all reviewed source fixes. Independent review is clean, including shared parent-descriptor cancellation cleanup, mutation barriers, active deletion cancellation and retry refresh. Final real desktop run: all five tests passed in 58.2 seconds, covering both existing browser tests, permission/lazy-folder/upload/delete/history integration, throttled active transfer stop/resume/cancel, and a mandatory packaged transfer. Screenshots inspected: test-results/transfers-browser.png and test-results/transfers.png. Installed app.asar matches staging and both bundled Python workers match source. Desktop shortcut target is updated; the user's running instance was preserved. Local transfer file access currently requires Linux/POSIX descriptor support as documented in README.
