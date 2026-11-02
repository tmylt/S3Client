# S3 Client

S3 Client is a desktop file browser for S3-compatible storage. Connections appear in a folder tree on the left. Select a connection or folder to see its immediate files and folders on the right.

This guide is for people using the app. To build it from source, run tests, or change the code, see the [developer guide](README.developer.md).

## Before you start

You need an S3-compatible endpoint, a bucket name, an access key (AK), and a secret key (SK). Your account needs permission to list the bucket. Downloading, uploading, copying, renaming, and deleting also need the corresponding permissions from your storage provider.

For Linux x86-64, download [S3.Client-0.1.0.AppImage](https://github.com/tmylt/S3Client/releases/download/0.1/S3.Client-0.1.0.AppImage) from the [0.1 release](https://github.com/tmylt/S3Client/releases/tag/0.1). Make it executable and run it from the download folder:

```bash
chmod +x S3.Client-0.1.0.AppImage
./S3.Client-0.1.0.AppImage
```

The release also provides a [SHA-256 checksum file](https://github.com/tmylt/S3Client/releases/download/0.1/S3.Client-0.1.0.AppImage.sha256). Download it beside the AppImage and run `sha256sum -c S3.Client-0.1.0.AppImage.sha256` to verify the download. Installed builds include the S3 client library; Python is not needed. To make an installer from this checkout, follow the [build instructions](README.developer.md#build-and-package).

**Platform limitation:** Browsing, searching, and connection management are available in the desktop app. Local file transfers currently require Linux with `/proc/self/fd`; downloads also require hard-link support in the destination filesystem. Uploads and downloads on macOS and Windows are not supported by the current local file safety implementation.

## Add your first connection

1. Click **Add your first connection** or **Add connection** in the left sidebar.
2. Fill in the connection name, endpoint URL, bucket, access key, and secret key.
3. Enter a region if your provider supplies one. Set a prefix if you want the connection to start inside a folder.
4. Review the **Allow downloads**, **Allow uploads**, and **Allow deletes** checkboxes. Downloads are enabled by default; uploads and deletes are disabled by default.
5. Click **Connect & browse**. The app checks the connection and opens its first folder page.

| Field | What to enter |
| --- | --- |
| **Connection name** | A label used only in this app, such as `Work backups`. |
| **Endpoint URL** | The HTTPS or HTTP S3 API endpoint, such as `https://s3.us-east-1.amazonaws.com` or a local service at `http://localhost:9000`. |
| **Bucket** | The bucket to browse. You may leave this blank if the Prefix field contains a full storage URI. |
| **Region** | Your provider's signing region. New connections start with `us-east-1`. If you clear it, the app saves an unset region and uses `us-east-1` only as a signing fallback. |
| **URI scheme** | The scheme shown in copied addresses, such as `s3`, `oss`, or `obs`. This does not change the API endpoint. |
| **Prefix** | Optional starting folder, for example `projects/reports/`. Leave blank for the whole bucket. |
| **Default page size** | Number of immediate items requested per page: 100, 250, 500, or 1,000. The default is 1,000. |
| **Access key / Secret key** | Credentials issued by the storage provider. Use **Temporary credentials** to add a session token if required. |

You can enter a full URI in **Prefix**, such as `s3://my-bucket/projects/reports/`, and leave **Bucket** blank. The URI scheme must match the connection's **URI scheme** field. Browsing and file actions stay within the resulting bucket and prefix. The app adds a trailing `/` to folder prefixes when needed.

### Provider-specific options

**Extra config (JSON)** is optional. For a service that needs virtual-host addressing, such as some Aliyun OSS setups, enter:

```json
{
  "s3": {
    "addressing_style": "virtual"
  }
}
```

The app also accepts `s3.addressing_style` values `path` and `auto`, retry settings (`retries.mode`, `retries.total_max_attempts`, `retries.max_attempts`), `connect_timeout`, `read_timeout`, and `signature_version` set to `s3v4`. Timeouts are in seconds. Leave the field blank for defaults. Other keys are rejected with a configuration error.

## Browse folders and files

- Click a connection or folder in the left tree to show its immediate contents on the right. Use the arrow beside a tree node to expand or collapse its subfolders. Double-click a folder row to open it.
- Use the breadcrumbs above the list, **Back**, and **Forward** to navigate. A collapsed tree node hides its children; it does not delete anything.
- Click the refresh icon beside a tree node to list it again, or **Refresh folder** above the right pane to update the selected folder. Refresh asks S3 for a new result.
- Use **Previous** and **Next** below the list to load one page at a time. Changing **Page size** applies to all folders in that connection until you close the app. On the next launch, that connection uses its configured **Default page size** again.
- Click a column heading to sort the displayed rows. Folders appear before files. Drag a column divider to change its width; double-click the divider to reset that column. Wide tables scroll horizontally.
- Drag a connection row or its grip in the left sidebar above or below another connection to save a new connection order.

File modification times include hours, minutes, and seconds in your local time. The app remembers the window size, sidebar width, and file-list column widths between launches. Use **View → Reset Sizes to Default** to restore them. **Window → Zoom** toggles maximize and restore. **View → Toggle Full Screen** enters full screen; press **Esc** or **F11** to leave it.

### Folder statistics

Each folder row has a statistics refresh icon. Click it to count all files in that folder and its subfolders and sum their sizes. The row shows the file count, total size, when the scan finished, and how long it took. The app reads object metadata without downloading file contents. Large folders can take time; ordinary folder browsing does not calculate these totals automatically. Click the icon again to recalculate them.

### Cached listings

The app saves successful folder pages locally. When it opens, it selects the first connection and shows its saved first page without listing S3 again. A **Cached** label means the displayed listing may be older than the objects in your bucket; click **Refresh folder** to check S3. If no page is saved, click **List folder**. Refresh failures leave the previous listing visible and offer a retry.

Only the first page is restored automatically at startup. Opening a later page requests it again. Folder statistics remain visible with their original scan time until you recalculate them. See [Where settings are saved](#where-settings-are-saved) for the cache file.

## Find an object

The search controls above the file list have **Range** and **Match** selectors. The default is **This folder + Exact file name**. Type a name and press **Enter** or **Search** unless you choose **This page**, which filters as you type.

| Range | What it searches | Useful for |
| --- | --- | --- |
| **This page** | Rows already loaded on the current page. | Quick filtering without an S3 request. |
| **This folder** | Immediate children of the current folder, across pages. | Finding an item without manually paging. |
| **All subfolders** | Objects anywhere below the current folder. | Finding a name in a nested folder; this may scan many keys. |
| **Full S3 key** | One complete file key or folder path within the connection. | Checking a known key without listing the folder. Match is fixed to **Exact S3 key**. |

**Match** can be **Prefix**, **Contains**, or **Exact file name**. An exact file name in **This folder** checks one constructed key directly. A **Full S3 key** can point to a file or a virtual folder; a trailing `/` explicitly asks for a folder. For example, if the current folder is `reports/`, search for `summary.csv` with **This folder + Exact file name**, or search for `reports/2026/summary.csv` with **Full S3 key**. Recursive and contains searches can take longer because they scan listings. S3-backed matches are case-sensitive; **This page + Contains** ignores case.

The search box at the right of the top toolbar accepts a full URI, such as `oss://my-bucket/reports/2026/`. It searches across saved connections with that URI scheme and bucket. If several connections match, it favors one whose configured prefix contains the key, then the connection with the longest matching folder path; a tie follows sidebar order. If no connection has that scheme and bucket, the app says so. A result outside the chosen connection's normal browsing prefix is shown read-only.

## File and folder actions

Select a row and open **Information** to see its S3 key, size, modified time, and storage class. The **Copy URI** button copies an address such as `s3://my-bucket/reports/file.csv`. Right-click a row for **Copy URI**, **Copy S3 key**, or **Copy file/folder name**. The keyboard copy shortcut copies the full URI. Folder keys keep the final `/`; copied folder names do not.

The right-click menu also has these actions:

- **Copy to…** copies a file or folder to another folder **in the same connection**. You can change its name in the copy dialog. Enable **Allow uploads** to use this action; your S3 account also needs copy permissions.
- **Rename…** changes a file or folder name in its current parent folder. The app copies the object or folder contents, then deletes the original after the copy succeeds. Enable both **Allow uploads** and **Allow deletes**. Existing destination names are not replaced.

Use the `…` menu beside a connection to **Edit connection**, **Copy connection**, or **Remove connection**. Copying creates a new connection with the same settings and a name such as `Work backups (copy)`; edit the copy to give it a different name. Removing a connection asks for confirmation and leaves the S3 objects untouched.

### Download

When downloads are allowed, click a row's download icon and choose a local destination folder. Downloading a folder preserves its structure. The selected top-level folder appears immediately; deeper folders appear when files within them start downloading. Empty leaf folders are preserved. If a local name already exists, the app chooses a new top-level name such as `reports (2)`.

Use row checkboxes to download several files or folders with one destination choice. The header checkbox selects the current page. Selections clear when you change folder, page, or search; cancelling the chooser keeps the selection.

### Upload

Enable **Allow uploads** in the connection settings. Click **Upload** above the list to open the app's file chooser. Select files, folders, or both with checkboxes, then click **Upload** in the chooser. A folder upload preserves its root folder, nested files, and empty folders. You can enter a local folder path and click **Go** to browse there. Uploading to an existing S3 key replaces its current contents.

### Delete

Enable **Allow deletes** in the connection settings. Click a row's delete icon, or check several rows and use **Delete selected**. A confirmation dialog shows the S3 path and what will be removed; **Cancel** has focus initially. A folder delete removes its objects and markers under that exact folder prefix. The app verifies the target is gone before reporting success. If a recursive delete fails partway through, refresh the folder to see what remains before retrying.

### Transfer tasks

The **Downloads** and **Uploads** buttons in the header open separate task lists. Each file shows its status, bytes transferred, percentage, and current attempt's speed. The lists offer **Start**, **Stop**, and **Cancel** per task, plus **Start all**, **Stop all**, and **Cancel all**. You can set 1 to 8 concurrent tasks per direction; the default is 1.

**Stop** pauses unfinished work. **Start** retries an incomplete file from the beginning. **Cancel** removes an unfinished download's partial file and keeps completed files. Use the trash icon on a task row to remove it from the list. **Clear all** asks whether to keep unfinished tasks while removing finished rows, or cancel everything and remove every row. Removing a row does not delete an already completed local file or S3 object.

Unfinished tasks return as **Stopped** after an app restart. They do not contact S3 until you start them. Changing or removing a connection cancels its unfinished tasks.

## Play an MP4

Double-click an MP4 file to open the in-app player. If the S3 service supports byte-range requests, the player streams the needed parts as you play or seek. If the service ignores or rejects ranges, the app downloads the video temporarily and plays it when ready. Closing the player cancels preparation and removes its temporary copy. Playback also depends on whether Chromium supports the video's codecs.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| **⌘/Ctrl F** | Focus the file search box. |
| **⌘/Ctrl R** | Refresh the selected folder. |
| **Up / Down / Home / End** | Move selection in the file list. |
| **Enter** | Open the selected folder or file. |
| **Backspace** | Go to the parent folder from a selected row. |
| **⌘/Ctrl C** | Copy the selected row's full storage URI. |
| **Esc** | Close a dialog or leave native full screen. |

## Where settings are saved

The app stores `connections.json`, `listing-cache.json`, `transfer-queue.json`, and `window-size.json` in Electron's application data folder. On a typical Linux installation, that is `~/.config/s3-client/`. The listing cache contains keys, names, sizes, dates, and folder statistics, but not file contents or credentials.

When operating-system secure storage is available, the app encrypts saved credentials. In **Edit connection**, the saved AK is shown and the SK is masked as password dots; use the eye button to reveal the SK temporarily. The edit dialog starts with the SK masked each time. A saved session token is not displayed. If secure storage is unavailable, keys remain in memory for the current session and you must re-enter them after restarting; the dialog tells you when this applies.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| **Folder not loaded** on startup | There is no saved page. Click **List folder** or **Refresh folder**. |
| A **Cached** list is missing a recent change | Click **Refresh folder**. The app does not refresh cached pages automatically at startup. |
| Connection or listing fails | Check the endpoint URL, bucket, signing region, AK/SK, prefix, provider-specific extra config, and `ListBucket` permission. Use **Edit connection** to correct them. |
| A search takes a long time | **All subfolders** and **Contains** can scan many keys. Use **This folder + Exact file name** or **Full S3 key** if you know the exact name or path. |
| Upload, download, or delete button is absent | Enable the corresponding checkbox in **Edit connection** and check the provider permissions. Local transfers currently require Linux as noted above. |
| An upload fails on a large file | Large files use multipart requests. Check that the service supports multipart upload, the account can create/upload/complete parts, and any proxy allows the file size. The task shows the failed request and recognized service error. |
| A video waits before playing | The service may not support range requests, so the app is downloading the MP4 first. |
| Keys must be entered again after restart | Your system's secure credential storage is unavailable. The connection dialog shows this state. |

For setup, architecture, testing, and packaging, see the [developer guide](README.developer.md).
