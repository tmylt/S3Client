#!/usr/bin/env bash
set -euo pipefail

S3_CLIENT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$S3_CLIENT_ROOT"

# Run the packaged build directly, without opening a terminal or development server.
if [[ -x "$S3_CLIENT_ROOT/release/linux-unpacked/s3-client" ]]; then
  exec "$S3_CLIENT_ROOT/release/linux-unpacked/s3-client" "$@"
fi

# The production JavaScript build can also run with the development Electron binary.
if [[ -x "$S3_CLIENT_ROOT/node_modules/electron/dist/electron" && -f "$S3_CLIENT_ROOT/out/main/index.js" ]]; then
  exec "$S3_CLIENT_ROOT/node_modules/electron/dist/electron" "$S3_CLIENT_ROOT" "$@"
fi

if command -v zenity >/dev/null 2>&1; then
  zenity --error --title="S3 Client" --text="Build S3 Client first: run npm run pack in $S3_CLIENT_ROOT."
else
  printf 'Build S3 Client first: run npm run pack in %s.\n' "$S3_CLIENT_ROOT" >&2
fi
exit 1
