# Delete Confirmation Implementation Plan

**Goal:** Replace native destructive-action prompts with a dialog styled like S3 Client.

**Architecture:** The main process requests confirmation through a typed event and waits for a matching single-use response. React displays the target and action-specific consequences in an accessible modal. Existing mutation and permission guards continue to apply.

**Tech Stack:** Electron, React, TypeScript, Lucide, Vitest, Playwright.

## Constraints

Use existing styling and dependencies. Default to Cancel. Preserve all remote scope and connection mutation checks. Tests use dummy credentials and temporary loopback S3. Preserve the running user app and package into its existing desktop launcher target. Git metadata is read-only; no commits or branch changes.

### Task 1: Confirmation bridge

- [x] Add `ConfirmationRequest` and typed event/response methods to the shared/preload API.
- [x] Test and implement a main-process confirmation controller that accepts only the active request ID and a boolean answer, cancels concurrent requests, handles delivery failures, and cancels on lifecycle changes.
- [x] Replace the two `showMessageBox` calls with authoritative confirmation requests; mutations still follow explicit confirmation.

### Task 2: Styled dialog

- [x] Add an app-styled confirmation component with target card, full wrapping path, folder/connection-specific copy, default Cancel, keyboard focus trapping, Escape/overlay/close dismissal, and focus restoration.
- [x] Subscribe once in App, block background interaction/shortcuts, and respond once per request.
- [x] Verify renderer interaction, permissions, cancellation, and listener cleanup with focused UI tests.

### Task 3: Desktop verification and installation

- [x] Update existing desktop tests to interact with actual styled dialogs instead of mocking native confirmations; exercise Cancel/confirm for files, folders, and connection removal.
- [x] Run unit suite, typecheck, and production build; stage package using installed Electron.
- [x] Install packaged resources atomically without restarting the user app; verify source and packaged desktop cases and visually inspect the confirmation screenshot.
- [x] Update progress notes with results and tell the user to reopen from the desktop icon.
