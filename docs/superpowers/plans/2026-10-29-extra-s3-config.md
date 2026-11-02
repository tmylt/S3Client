# Extra S3 connection config

**Goal:** Add per-connection JSON options for botocore.config.Config, including `{"s3":{"addressing_style":"virtual"}}`, matching the user's Python example without using its credentials.

## Contract and behavior

- Optional `extraConfig` JSON object on Connection/ConnectionInput/WorkerConnection. Legacy connections default to `{}`.
- Add/Edit exposes an Extra config (JSON) textarea, pretty-printing saved values. Blank means `{}`; malformed JSON, non-object input, non-JSON values, oversized/deep structures and unsafe property names are rejected with fixed messages.
- Persist, load, forward and copy extraConfig without aliasing caller-owned dictionaries. Existing AK/SK/session-token, null-region and prefix behavior stays intact.
- Python passes extras to botocore.config.Config, overlaying existing defaults. Merge supplied S3/retry dictionaries over defaults. Explicit retries.max_attempts should replace the default total_max_attempts when no explicit total_max_attempts is supplied.
- Bad SDK options return a fixed INVALID_CONFIG error without echoing raw option values or exceptions.
- Listing cache scope includes a stable SHA-256 digest of nonempty extraConfig. Persist only this digest in the listing cache, and preserve compatibility with old cache records for default/empty config. Settings edits still invalidate listings.

## Tasks

- [x] Tests first for JSON validation/parse, persistence/edit/copy/worker forwarding, invalid input, and dialog round trips.
- [x] Implement shared JSON config types/validation and the main/renderer flow.
- [x] Implement backend Config overrides and test real SDK URL generation for virtual vs path addressing without making network requests.
- [x] Test cache scope digest and settings-change invalidation.
- [x] Extend real Electron tests to enter, edit, copy and restore extra config using a loopback endpoint with non-addressing Config overrides.
- [x] Run JS/Python tests, production build, desktop integration; stage/repackage updated app and worker resources at the existing shortcut target.
- [x] Update docs with the Aliyun JSON example, review changes, and record verification.

## Final verification

- JavaScript tests: 80 passed across eight suites; typecheck and production bundles passed.
- Python tests: 24 passed, including offline real-boto3 virtual/path URL checks and Config override validation.
- Desktop integration: both source and packaged tests passed; extra config is entered, edited, copied, persisted and restored alongside cached listings.
- Integration review approved without material findings.
- Rebuilt staging app with the installed Electron distribution. Updated app.asar and the bundled Python worker atomically at the existing desktop shortcut target; byte comparisons confirmed both match the staged/source files.
- `git diff --check` passed. No external S3 endpoint or user credentials were used during verification.
