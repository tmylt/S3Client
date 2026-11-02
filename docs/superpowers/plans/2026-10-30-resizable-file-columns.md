# Resizable File Columns Implementation Plan

**Goal:** Let users resize every file-list column and remember their choices.

**Design:** Place subtle draggable separators at the right edge of each of the seven headers. Keep sorting on its existing label button. Clamp widths so labels and row actions remain usable; keep independently sized columns aligned and use horizontal scrolling when needed. Arrow keys resize a focused separator, Shift increases the step, and double-click resets one column. Save widths locally across folders and app restarts, with safe defaults if storage is corrupt or unavailable.

**Architecture:** A small hook owns column definitions, validated pixel widths and local preference storage. A resize-handle component owns pointer capture, drag cleanup and keyboard actions. FileList renders header/body widths through colgroup; a decorative spacer fills unused horizontal space without stretching user-sized columns.

**Constraints:** Existing Electron/React/TypeScript dependencies only. No changes to S3 operations, connection settings, credentials or startup listing behavior. Preserve the running user app. Git metadata is read-only.

- [x] Add renderer regressions for keyboard resizing, independent widths, safe limits, reset and persisted preferences; observe failure before implementation.
- [x] Implement `useColumnWidths.ts`, `ColumnResizeHandle.tsx`, FileList integration and matching CSS.
- [x] Extend source/packaged desktop browser tests with real pointer drags, alignment, sorting isolation, overflow, and persistence across restart.
- [x] Run unit tests, typecheck/build and desktop tests; inspect a resized-table screenshot.
- [x] Package and atomically update the desktop launcher target; record verification and tell the user how to resize columns.
