# Parallel Downloads Implementation Plan

**Goal:** Improve large-file download speed with four validated concurrent S3 ranges while preserving restart-safe resume.

**Architecture:** A dedicated parallel worker handles new large downloads and version 2 partials. The existing operation runner remains the single-stream fallback and handles older version 1 partials. The parallel worker checkpoints only fully synced chunks.

**Tech Stack:** TypeScript, Electron main process, AWS SDK v3, Node filesystem APIs, Vitest, hidden Playwright.

## Global constraints

- Preserve descriptor-anchored paths and `O_NOFOLLOW`.
- Keep the existing version 1 resume format readable.
- Commit a completed file only after all ranges have been verified and synced.
- Never run visible Electron tests on the user's desktop.

## Tasks

### 1. Parallel checkpoint

**Files:** `src/main/parallel-resume.ts`, `tests/parallel-download.test.ts`

- [x] Write a failing test showing that a version 2 checkpoint records completed chunks separately from the `.part` file size.
- [x] Implement bounded bitmap parsing, atomic checkpoint writes, and safe cleanup with the existing directory anchor.
- [x] Run the focused test and confirm it passes.

### 2. Parallel worker and fallback

**Files:** `src/main/parallel-download.ts`, `src/main/operation-runner.ts`, `tests/parallel-download.test.ts`

- [x] Write a failing integration test with a local S3 HTTP fixture proving four disjoint 8 MiB ranges are requested and bytes match.
- [x] Add HEAD negotiation, first-response range validation, four workers, positional writes, and per-chunk durable checkpoints.
- [x] Write failing tests for stop/restart, ignored Range, changed ETag, and transient failure; implement fallback or retention as specified.
- [x] Run focused tests and existing sequential resume tests.

### 3. Documentation and verification

**Files:** `README.md`, `README.developer.md`, `tests/transfers.e2e.ts`

- [x] Explain automatic parallel downloads, the threshold, and the distinction between task and per-file concurrency.
- [x] Add or extend a hidden Electron test of the large-file path and cancellation cleanup.
- [x] Run full unit tests, typecheck/package build, hidden source and packaged Electron tests, and `git diff --check`.
