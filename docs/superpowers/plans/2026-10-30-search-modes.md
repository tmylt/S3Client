# Four Search Modes Implementation Plan

**Goal:** Let users choose page-local, exact current-folder, exact recursive, or current-folder prefix search, defaulting to exact current-folder.

**Architecture:** Keep page-local filtering in React. Send the three remote modes through a fixed Electron IPC channel and a separate lazy Python worker. Exact uses HeadObject, recursive uses ListObjectsV2 pagination without delimiter, and prefix uses one delimited ListObjectsV2 page per result page. Searches do not alter listing cache.

**Tech Stack:** Electron, React, TypeScript, Python, boto3, Vitest, unittest, Playwright.

## Global Constraints

- Preserve the current case-insensitive contains filter for page-local mode.
- Match exact file names case-sensitively for exact and recursive modes.
- Preserve opaque S3 keys, including spaces, plus signs, percent signs, and parentheses.
- Default mode is exact current-folder; submit remote searches with Search or Enter.
- Keep normal folder pagination separate from search results.

---

### Task 1: Worker search behavior

- [ ] Add failing Python tests for direct HEAD, missing/denied objects, recursive exact-name matching, prefix paging, and invalid input.
- [ ] Implement search dispatch with validation and sanitized errors.
- [ ] Run `npm run test:python`.

### Task 2: Electron search transport

- [ ] Add failing ListingService tests for scoped forwarding and no cache write.
- [ ] Add `SearchMode` and `S3API.search`, preload and IPC wiring, and a separate lazy search worker bridge.
- [ ] Run `npm test` and `npm run typecheck`.

### Task 3: Search interface

- [ ] Add renderer tests for default mode, all-mode behavior, result paging, navigation reset, and stale response handling.
- [ ] Add mode selector, explicit remote submission, result state, status and paging while preserving normal folder rows and actions.
- [ ] Update Browse documentation and run renderer tests.

### Task 4: End-to-end verification and install

- [ ] Extend desktop moto test to exercise all four search modes against real boto3.
- [ ] Run Python, unit, build, and desktop tests.
- [ ] Package and install the tested app resources for the desktop launcher.
