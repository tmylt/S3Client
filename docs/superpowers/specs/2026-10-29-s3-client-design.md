# S3 Client desktop app

## Outcome

Build an Electron desktop app with a macOS Finder-style split view for browsing multiple S3-compatible connections. The workspace is currently an empty Git repository.

## Architecture and alternatives

Use Electron with a React and TypeScript renderer and a Python boto3 child process. Electron's main process communicates with Python over newline-delimited JSON on stdin/stdout and exposes a narrow, typed API through a context-isolated preload. Keep filesystem access and saved session tokens outside the renderer. Expose configured AK/SK only through the dedicated connection-edit API, as requested by the user.

An alternative is a Python HTTP server, but it adds port allocation, server authentication, and lifecycle management. A JavaScript-only AWS SDK implementation would simplify packaging but would not meet the boto3 requirement. The child-process approach is recommended.

## Connections

The Add Connection dialog accepts a display name, S3 endpoint URL, access key (AK), secret key (SK), bucket, optional prefix, and optional region (initially `us-east-1`). Persist an unset region as null and show it as empty when editing. Apply the `us-east-1` signing fallback only when preparing S3 requests. Accept `s3://bucket/prefix` as an alternative way to specify the bucket and prefix. Use path-style addressing for compatibility with MinIO and other S3-compatible endpoints.

Each connection also accepts optional Extra config (JSON) for botocore.config.Config, including `{"s3":{"addressing_style":"virtual"}}` for Aliyun OSS. Validate JSON object shape/size, persist it with settings, restore it into the edit pane, copy it independently and pass it to the Python client. Missing/blank extras default to `{}` for backward compatibility. Overlay SDK options on defaults, merge nested S3/retry dictionaries, and report sanitized INVALID_CONFIG errors for invalid SDK settings. Scope cached listings to a stable options digest and exclude raw options from cache records.

Connections are independent top-level tree nodes. Persist non-secret connection settings in Electron's application data directory. Persist credentials using Electron safeStorage when operating-system encryption is available. Otherwise keep credentials in memory and clearly explain that the user must re-enter them after restarting. Never log credentials or include them in ordinary connection metadata. The edit dialog loads the configured AK and SK through a dedicated validated IPC call. The SK uses a password input by default; the eye button reveals/hides the actual saved value. Reopening always resets masking. The saved session token stays in the main process. Saving unchanged AK/SK preserves the saved session token. Keeping the AK unchanged with a blank SK also preserves saved credentials.

## Navigation and listing

The connection menu includes Edit, Copy, and Remove. Copy immediately creates and selects an independent root with a new ID and a unique name (`Name (copy)`, then `Name (copy 2)`, etc.). All endpoint, bucket, prefix, nullable region, and credential settings, including session tokens, remain identical. The main process copies encrypted or session-only credentials directly, preserving the existing persistence policy. Editing or removing either connection does not alter the other.

Use a resizable sidebar containing connection roots and nested folders. Every root and folder has an expand/collapse arrow and a refresh button. Expanding an unloaded or collapsed folder fetches its immediate children through boto3. Collapsing hides its descendants without fetching. Refresh always fetches fresh results, including when the node is collapsed. Selecting a folder shows its immediate folders and files in the right pane. Double-clicking a folder in the file list navigates into it and reveals it in the tree.

Call `list_objects_v2` with `Bucket`, `Prefix`, and `Delimiter='/'`. Consume all paginator pages. Translate `CommonPrefixes` into folders and `Contents` into files, excluding the selected prefix's own folder marker. Preserve raw S3 object keys and normalize only directory-prefix boundaries; do not treat S3 keys as local filesystem paths. Restrict browsing to the configured bucket and prefix. Keep folders before files and provide name, size, type, and modified-date columns.

Provide breadcrumbs, back/forward navigation, an up button bounded by the connection root, current-folder search, sortable columns, and a status bar. File selection displays metadata and permits copying the S3 URI. File transfer and modification are outside this browsing-focused scope.

## Visual design

Use a clean, light Finder-inspired interface: muted sidebar, native system font, subtle separators, blue folder icons and selection states, compact toolbar, and alternating list rows. Keep controls keyboard accessible with visible focus, descriptive labels, and a proper connection dialog. Use native window controls on macOS and the normal operating-system frame elsewhere.

## Loading and errors

Persist successful folder listings as bounded, private metadata in `listing-cache.json` in userData. Restore matching cached nodes at startup without S3 requests or Python worker startup. If the first selected root has no cache, show a List folder action and wait for explicit interaction. Mark restored data Cached with a listing timestamp. Manual refresh/expansion fetches fresh results; navigating an uncached folder fetches on demand. Retain previous results and show an inline retry notice if refresh fails. Clear a connection's cache on edit/remove. Validate endpoint, bucket, exact configured prefix and immediate-child containment on restore, and exclude credentials. Keep at most 200 folder snapshots and 32 MiB, evict oldest snapshots, and ignore corrupt caches. Startup does not auto-expire cached listings.

Show per-node loading and errors and a clear loading state in the file list. Authentication, endpoint, permission, and missing-bucket errors should have useful messages without secrets. Reject stale responses after refresh, navigation changes, or connection removal, including disk-cache writes from superseded requests. A failed folder refresh must be retryable. Bound S3 connection and read timeouts; terminate the Python process with the app and reject outstanding requests if the process exits.

## Verification and delivery

Add meaningful automated coverage for boto3 pagination and immediate-child behavior, prefix boundaries, folder markers, connection validation, credential persistence, and navigation state. Use a local S3-compatible test service for a desktop integration smoke test when the environment supports it. Check the production renderer build and Electron startup. Document installation, Python requirements, launching, packaging, connection configuration, and limitations. Provide scripts for development, tests, build, and packaging.

## Runtime and packaging

Require Node.js 22 or newer and Python 3.10 or newer with boto3 installed. Permit an explicit Python executable override and otherwise discover an appropriate local interpreter. Package the Electron frontend and Python source with electron-builder; document that Python and boto3 are prerequisites for the initial release. Report a clear setup error if the Python runtime or boto3 is unavailable.
