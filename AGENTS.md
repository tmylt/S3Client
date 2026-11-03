# Project instructions

## GitHub push identity

- Push this repository only to `git@github.com:tmylt/S3Client.git` while SSH authenticates as `tmylt`. Never push as `skgmtmylt`.
- Before each push, check the push URL and SSH identity. If either is not `tmylt`, correct it before pushing.

## Desktop tests and focus

- Keep automated Electron and UI test windows hidden or run them on an isolated virtual display. Tests must not take focus from the user's desktop or move the system pointer.
- The Playwright desktop tests are hidden by default through `S3_CLIENT_E2E_HIDDEN=1`. Do not set `S3_CLIENT_E2E_VISIBLE=1` unless the user explicitly asks for a visible test window.
- Use `captureTestScreenshot` in `tests/desktop-test-window.ts` for optional screenshots. Direct `page.screenshot()` calls can stall when Electron is hidden.
- If a test requires a visible window and no isolated display is available, do not run it on the user's active desktop. Explain the limitation and use nonvisual checks where possible.
