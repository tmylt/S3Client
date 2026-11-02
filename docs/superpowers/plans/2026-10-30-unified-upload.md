# Unified Upload Implementation Plan

**Goal:** One Upload button accepts files, folders, or a mixed selection and infers each source type.

**Design:** An app-styled local chooser lists regular files and folders together, with checkboxes, folder navigation, an editable local path, Cancel and Upload. Folder selections keep their selected root and all descendants, including empty folders. Electron's native open dialog cannot select both files and directories on Linux/Windows, so combining native open flags would not meet the requirement.

**Architecture:** The main process authorizes source browsing and uploads using existing connection permissions and prefix checks. A focused source-listing utility returns only local metadata. UploadDialog handles navigation/selection; the bridge passes selected paths, and uploadPlan infers every source's type using lstat while retaining canonical-path, symlink, duplicate-name, cancellation and queue guards. Existing download destination dialogs remain native.

**Constraints:** No new dependencies; no user credential reads or real S3 writes; preserve the running user app; use isolated local fixtures in tests; no changes to transfer concurrency or directory preservation. Git metadata is read-only.

- [x] Observe failing regressions for one-button selection and mixed file/folder planning.
- [x] Implement authorized local source browsing, automatic planning, typed IPC and a matching chooser.
- [x] Update unit/desktop tests to interact with the real chooser for file, folder, mixed selections and cancellation.
- [x] Run unit/typecheck/build and source/packaged transfer checks, inspect screenshot, then package/install atomically and update documentation.
