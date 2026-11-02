# S3 Client developer guide

This guide covers running, testing, and packaging S3 Client from source. For connection setup and everyday use, see the [user guide](README.md).

## Requirements

- Node.js **22.12 or newer** and npm.
- A desktop display for development and Electron integration tests. On Linux CI, an isolated virtual display such as Xvfb can provide one.
- No Python installation. The app uses the AWS SDK for JavaScript, and tests use a local Node.js S3 fixture.

The local transfer implementation currently requires Linux with `/proc/self/fd`. Download destinations must support hard links. Browsing, searching, and S3 metadata operations do not depend on those local file operations.

## Start from a checkout

Run these commands in the repository root:

```bash
npm ci
npm run dev
```

`npm run dev` starts Electron with the development renderer and watches source files. It opens an app window. If you want a separate development profile, create an existing absolute directory and set `S3_CLIENT_DATA_DIR` before starting:

```bash
mkdir -p /tmp/s3-client-dev-profile
S3_CLIENT_DATA_DIR=/tmp/s3-client-dev-profile npm run dev
```

To run the production bundle with the installed Electron binary:

```bash
npm run build
npm start
```

`npm start` requires a completed build. It previews the production main process, preload, and renderer from `out/`.

## Project layout

| Location | Responsibility |
| --- | --- |
| `src/renderer/` | React interface: connection tree, folder list, search, dialogs, video player, and task panels. |
| `src/preload/index.ts` | Narrow, typed renderer API exposed across Electron's context isolation boundary. |
| `src/main/index.ts` | Window and menu setup, IPC validation, connection lifecycle, and service wiring. |
| `src/main/s3-client.ts`, `s3-worker.ts`, `listings.ts` | S3 client configuration, listing, search, and statistics work. |
| `src/main/operation-runner.ts`, `transfer-service.ts`, `transfer-queue.ts` | Download, upload, copy, rename, delete, task control, and queue persistence. |
| `src/main/video-service.ts` | Private loopback video proxy and range or download playback preparation. |
| `src/main/connections.ts`, `listing-cache.ts`, `window-size-store.ts` | Persisted connection settings, cached pages, and saved window size. |
| `src/shared/` | Types, validation, storage URI logic, permissions, and formatting shared between processes. |
| `tests/` | Vitest unit tests, Playwright Electron scenarios, and the local S3 fixture. |

The renderer cannot access credentials or the filesystem directly. It calls the preload API; Electron's main process validates the caller and input, then uses the AWS SDK or local file services. S3 operations use bounded timeouts and retries. Listings and statistics run asynchronously; transfer tasks have independent abort controllers.

Connections and other state are stored under Electron's `userData` directory. The main files are `connections.json`, `listing-cache.json`, `transfer-queue.json`, and `window-size.json`. `S3_CLIENT_DATA_DIR` overrides `userData` when set to an existing absolute directory. On a typical Linux desktop, the default is `~/.config/s3-client/`. Credentials are encrypted with Electron's OS secure storage when it is available; otherwise they remain in memory for the session. Do not use a real credential profile for automated tests.

## Day-to-day development

1. Start `npm run dev` with a separate `S3_CLIENT_DATA_DIR` profile when you want to interact with the app. Electron's **View → Toggle Developer Tools** menu item opens the renderer tools; main-process output appears in the terminal.
2. Make changes in the process that owns the behavior. For an IPC feature, update the shared types, preload API, main handler, renderer caller, and relevant tests together.
3. Run `npm run typecheck` and `npm test`. Build with `npm run build` before previewing production behavior. For changes to a desktop workflow, run the relevant hidden Playwright scenarios after `npm run pack`.

Keep saved credentials out of test profiles and screenshots. Keep error messages sanitized: raw service responses, credentials, and signed URLs must not reach the renderer or task history.

## Test and verify

```bash
npm run typecheck
npm test
npm run build
```

`npm test` runs the Vitest suite. The tests create temporary directories and use dummy credentials. To run a focused test file, for example:

```bash
npm test -- tests/s3-test-server.test.ts
```

The Playwright suite drives source and packaged Electron builds against a loopback-only Node.js S3 service. Build the packaged app before running it:

```bash
npm run pack
npm run test:e2e
```

The desktop test windows are **hidden by default** so they do not take focus or move the system pointer. Keep them hidden or use an isolated virtual display; do not make test windows visible on a user's active desktop. For optional screenshots, use `captureTestScreenshot` in `tests/desktop-test-window.ts`. The test-only `NODE_OPTIONS=--openssl-legacy-provider` setting supports the fixture server's pagination tokens; it is not part of normal app launches.

`tests/s3-test-server.ts` starts and cleans up the local S3 fixture. The desktop tests adapt a few fixture-only differences from S3, including URL-encoded listings, encoded copy source headers, and one-byte range responses. Transfer tests reset their fixture objects before each case so uploads and deletes in one case cannot affect another. Tests do not contact an external S3 account.

Run a subset of desktop cases with Playwright's grep option when investigating a specific behavior:

```bash
npm run test:e2e -- --grep 'bulk downloads'
```

## Build and package

| Command | Result |
| --- | --- |
| `npm run build` | Typechecks and bundles main, preload, and renderer into `out/`. |
| `npm run pack` | Builds and creates an unpacked desktop app in `release/` for the current operating system. |
| `npm run dist` | Builds an installer in `release/` using `electron-builder.yml`. |

Configured installer targets are a Linux AppImage, macOS DMG, and Windows NSIS installer. Build each target on its corresponding operating system; signing and macOS notarization are not configured. Linux's unpacked executable is `release/linux-unpacked/s3-client`. A packaged app includes the JavaScript S3 runtime and does not need Node.js or Python installed separately.

To refresh the screenshots in the user guide, run `npm run build` and then `node scripts/capture-doc-screenshots.mjs`. The script renders the built UI in headless Chrome with fictional data and does not read a saved connection or contact S3. It writes images to `docs/images/` and never opens a visible window. On Linux it uses `/usr/bin/google-chrome`.

`scripts/launch-client.sh` is a checkout-based Linux launcher. It runs `release/linux-unpacked/s3-client` when available, then falls back to a built `out/` bundle with the project's Electron binary. It is not a general installer: a desktop shortcut pointing to it depends on the location of this checkout.

## Connection and S3 behavior

Connection options live in `src/shared/extra-config.ts` and are translated into AWS SDK settings by `src/main/s3-client.ts`. Supported extra JSON fields are S3 addressing style, retry mode and attempt counts, connect/read timeouts in seconds, and `s3v4` signature version. The connection's URI scheme affects displayed and copied URIs, while API requests continue to use its endpoint.

Ordinary browsing requests one `ListObjectsV2` page with `/` as the delimiter and a maximum of 1,000 immediate items. Cached first pages can appear at startup without a network call. Exact name and full key searches check a single object or folder path; contains and recursive searches may scan many pages. Folder statistics scan descendants on demand without downloading their contents. Mutating operations invalidate relevant cached listings.

Files over 8 MiB use multipart upload. Downloads stream into temporary files and are committed only on completion. Transfer history stores task metadata without credentials, and unfinished tasks restore as stopped. Local path validation rejects unsafe S3 names and symbolic links within selected trees; changes to transfer I/O need to preserve these protections.

When changing a persisted format, update its reader, writer, migration behavior, and tests together.
