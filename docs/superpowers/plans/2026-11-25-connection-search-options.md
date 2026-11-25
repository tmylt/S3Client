# Connection Search Options Implementation Plan

**Goal:** Let each connection choose permitted search ranges and match types while preserving all options by default.

**Architecture:** A shared search-options module owns validation and mode selection. Connection persistence normalizes the options. The renderer presents only permitted options, while the listings service enforces them for remote searches and URI lookups.

**Tech Stack:** TypeScript, React, Electron IPC, Vitest, hidden Playwright Electron tests.

## Global constraints

- Existing connection files and copied connections must keep working.
- Full S3 key requires Exact matching.
- A connection with no valid combination must offer no search controls, while Upload remains available.
- Automated Electron windows must stay hidden.

## Tasks

### 1. Shared policy and persistence

**Files:** `src/shared/search-options.ts`, `src/shared/types.ts`, `src/main/connections.ts`, `tests/connections.test.ts`, `tests/search-options.test.ts`

- [x] Test that a missing policy permits all values, restricted lists survive save/reload/copy, and invalid values are rejected.
- [x] Add canonical list normalization, `isSearchAllowed`, and default mode selection.
- [x] Run focused tests.

### 2. Enforce backend searches

**Files:** `src/main/listings.ts`, `tests/listings.test.ts`

- [x] Test direct search and URI lookup rejection for disallowed modes.
- [x] Check the policy after connection resolution and before S3 worker calls.
- [x] Run focused tests.

### 3. Editor and browser controls

**Files:** `src/renderer/src/components/ConnectionDialog.tsx`, `src/renderer/src/useFileSearch.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`, `tests/renderer-state.test.ts`

- [x] Test editor defaults, persistence of checkbox choices, search mode reconciliation, and global URI connection choice.
- [x] Render permitted controls and disabled state, and filter global URI candidates.
- [x] Run focused renderer tests.

### 4. Documentation and verification

**Files:** `README.md`, `README.developer.md`, `tests/desktop.e2e.ts`

- [x] Explain the new connection settings and key/exact rule.
- [x] Add a hidden desktop smoke test for saved restrictions.
- [x] Run unit suite, typecheck/production build, hidden desktop smoke test, and `git diff --check`.
