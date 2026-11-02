# Folder List Pages Implementation Plan

**Goal:** Request and display one immediate-child S3 page at a time, with a user-set page size defaulting to 1,000.

**Design:** Use one `ListObjectsV2` request per page, returning its opaque continuation token. Previous/Next use tokens held per folder; changing page size or refreshing returns to page 1. Keep search and sorting scoped to the current page and say so in the UI. The tree remembers folder names discovered on visited pages. Save visited page snapshots by folder, page size and index so existing statistics survive navigation and restart; restore only page 1 at startup. Legacy full listings below 1,000 entries can be restored; larger legacy snapshots require an explicit fresh listing.

**Constraints:** Page size is 1–1,000. Validate tokens and sizes at the worker and bridge boundaries. Never list additional pages in the background. Keep credentials out of cache and diagnostics. Preserve stats scans, transfer behavior, permissions and cached idle startup.

- [x] Test and implement one-page Python listing with continuation-token validation and exact key decoding.
- [x] Test and implement typed bridge, per-page metadata cache and page-specific listing service.
- [x] Test and implement current-folder pagination, page-size control, page-local search/sort labels and tree behavior.
- [x] Update desktop tests for 1,005 objects; verify source and packaged builds, install the desktop update and document behavior.
