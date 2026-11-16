# Resumable Downloads Implementation Plan

**Goal:** Retry stopped and failed downloads from durable partial bytes when the S3 endpoint supports byte ranges, including after an app restart.

**Architecture:** Each queued download owns a stable, private `.part` file and a small metadata file in its selected destination directory. The metadata records the source identity (endpoint, bucket, key, ETag, total size) before body bytes are written. On retry, the runner reads the actual partial length and sends `GetObject` with `Range` and `IfMatch`. It appends only after validating `206`, `ContentRange`, ETag, and expected length; otherwise it safely restarts from zero. Queue cancellation and row removal discard both files, while stop, failure, and app shutdown retain them.

**Tech stack:** Electron main process, TypeScript, AWS SDK for JavaScript v3, Node filesystem APIs, Vitest, hidden Playwright Electron tests.

## Global constraints

- Preserve Linux descriptor anchored path checks and prevent symlink traversal.
- Never publish partial content as a completed file; retain the hard-link commit behavior.
- Do not store credentials in resume metadata or transfer history.
- Keep upload behavior unchanged.
- Run Electron tests hidden so they do not take desktop focus or move the system pointer.

## Tasks

### 1. Task owned partial files

- [x] Add a bounded, validated resume metadata format and stable `.part` path derived from the queue task UUID.
- [x] Write a failing runner test for a stopped transfer, retained partial bytes, and a later ranged request.
- [x] Add a failing test for an ignored Range or changed ETag; the result must be a clean restart, never an append of full content.
- [x] Implement partial creation, durable metadata before streaming, strict response validation, and final atomic commit.

### 2. Queue lifecycle and progress

- [x] Test preservation of download progress on stop, failure, and restore, while uploads still restart from zero.
- [x] Test that resumed speed measures only bytes transferred during the current attempt.
- [x] Add a queue discard hook for cancel, row removal, clear, and connection cancellation; wait for active cleanup before discarding.
- [x] Wire the hook to safe local partial removal in the transfer service.

### 3. UI and integration

- [x] Update download task wording to explain resume and fallback to restarting when Range or an object validator is unavailable.
- [x] Extend hidden Electron transfer tests to verify partial survival through stop and app restart, a ranged retry, and cleanup after cancel and completion.
- [x] Update user and developer documentation.
- [x] Run focused tests, full unit suite, build, and relevant hidden Electron source and packaged tests.
