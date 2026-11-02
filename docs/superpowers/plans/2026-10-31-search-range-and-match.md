# Search Range and Match Implementation Plan

**Goal:** Replace the combined search mode with independent range and name-match selectors covering all nine combinations.

**Architecture:** Page searches filter the loaded page locally. Folder exact uses HeadObject; folder prefix uses one delimited ListObjectsV2 page per result page. Folder contains scans delimited listing pages, while every recursive match scans object keys below the folder. Scanned results are paged locally and searches never alter the saved folder listing.

**Tech Stack:** Electron, React, TypeScript, Python, boto3, Vitest, unittest, Playwright.

## Global Constraints

- Default range is this folder and default match is exact.
- Preserve case-insensitive contains behavior for the current page; S3 backed matches are case-sensitive.
- Preserve opaque S3 keys and the existing download, delete, and folder statistics row actions.
- Require Search or Enter for remote searches, and ignore stale responses after any selector, query, or folder change.

---

### Task 1: Search worker

- [x] Add failing tests for folder contains and recursive prefix/contains, and for the two-parameter validation.
- [x] Implement range and match routing while keeping exact HEAD and folder prefix paging efficient.
- [x] Run Python tests.

### Task 2: Electron API

- [x] Add failing service tests for two-parameter forwarding and validation.
- [x] Update shared types, preload, IPC, worker, and bridge signatures.
- [x] Run TypeScript tests and typecheck.

### Task 3: Renderer

- [x] Add failing tests for both selectors, all page matches, folder searches, and stale result handling.
- [x] Update search state, two selectors, hints, result paging, and documentation.
- [x] Run renderer tests and build.

### Task 4: Desktop verification

- [x] Exercise representative combinations through local moto and the packaged desktop app.
- [x] Run all verification and install the final app resources for the desktop launcher.
