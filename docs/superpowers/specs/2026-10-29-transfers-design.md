# Connection permissions and transfer queues

The user requested per-connection download/upload/delete checkboxes; row actions for files and folders; a destination directory chooser; recursive downloads with lazy subdirectory creation; serial-by-default transfers; and separate download/upload task panels with progress and individual/all start, stop and cancel controls. The user confirmed adding both Upload files and Upload folder actions.

## Behavior

- Permissions default to download=true, upload=false, delete=false for both new and existing connections. Persist and copy all three. Main-process checks enforce them before dialogs, planning, and each queued operation; these supplement the provider's IAM permissions.
- Every file and folder row shows Download and Delete only when permitted. Download opens the native directory chooser. Folder download creates the selected folder immediately inside that destination, enumerates every descendant file, then queues the files. Deeper directories are created only when a corresponding file starts. Empty leaf folders receive directory tasks after file tasks. Existing local items are preserved: allocate a unique top-level name.
- Upload files and Upload folder appear when upload is enabled. Native file/directory choosers grant source paths. Folder uploads retain their selected root folder and all descendant paths, including empty folder markers. Uploads use normal S3 replacement semantics for the same key.
- Delete opens a native confirmation naming the file/folder and explaining recursive deletion. It affects the exact object or exact slash-delimited prefix, including markers; it never deletes the bucket. Cancel overlapping transfers before deletion, and refresh/invalidate listings afterward. Errors must acknowledge possible partial folder deletion.
- Header buttons open separate Downloads and Uploads task panels. They show planning jobs, all individual files with status, transferred/total bytes and progress, errors, and individual Start/Stop/Cancel actions. Each queue has Start all, Stop all, Cancel all, and concurrency (default 1, range 1–8). Task lists paginate rather than hiding older jobs permanently.
- Stop aborts active requests and retains paused tasks; Start restarts incomplete files from byte zero. Cancel removes partial downloads and retains completed files. Cancel all also cancels recursive preparation. Completed tasks remain visible.
- Persist task metadata and concurrency locally without credentials. Restart restores unfinished tasks as paused and starts no network or Python worker until user action. Changing/removing a connection cancels its unfinished tasks. New operations resolve current credentials and permissions when they actually execute.

## Architecture

Use existing encrypted ConnectionStore and trusted IPC. A shared transfer contract connects renderer and main. A focused TransferQueue owns scheduling, persistence, progress, pause/start/cancel and generation guards. A TransferService owns path planning, source/destination validation, recursive enumeration, permission checks, delete operations and listing invalidation. A separate OperationRunner starts an isolated Python process for each active manifest/download/upload/delete operation, receives sanitized progress/results and terminates only that operation on cancellation. Existing listing/statistics workers remain independent.

Python uses existing boto3 client creation (endpoint, region, credentials, extra Config). Recursive enumeration streams list_objects_v2 pages without Delimiter and URL-decodes keys once. Download streams into a unique partial file and commits only after success. Upload uses bounded single-file SDK concurrency and progress callbacks. Delete consumes all pages and deletes exact keys in bounded batches, checking response errors. No SDK messages or signed URLs cross the protocol.

## Local paths and cancellation

Only native chooser results supply local roots/sources. Reject traversal components, platform-incompatible separators and ambiguous S3 paths rather than writing outside the destination. Reject symlinks in paths below the granted root. Create parents inside the per-file execution path, never during recursive enumeration. Partial files use a dedicated per-operation name and are removed after cancellation/failure; completed files are retained. Each file's abort controller and generation guard prevents late completion from undoing pause/cancel. Drain/kill the prior process before admitting a replacement into the concurrency slot.

## Verification

Test permission defaults/persistence/copy/enforcement; SDK manifest/download/upload/delete behavior and sanitization; runner cancellation and partial cleanup; queue concurrency, byte progress, pause/resume/cancel, stale completion, persistence and idle restart; exact requested lazy creation order; path/symlink boundaries; dialogs and row/header actions. Desktop checks use only temporary directories and loopback moto, dummy credentials, native-dialog mocks, real Electron/Python, nested transfers and queued controls. Build and update the existing desktop package without restarting the user's running instance.

## Explicit limits

Transfer restarts begin a file from byte zero rather than range/multipart resumption. Queues and manifest metadata are bounded; oversized preparations fail visibly before files begin. S3 listings and folder deletion are not snapshots if objects change during traversal. Permission changes/removal cancel active work, but requests already committed by S3 cannot be undone.
