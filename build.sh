#!/usr/bin/env bash
# Build standalone gather-spotify-status binaries (delegates to scripts/build.mjs).
#   ./build.sh          all 5 platforms -> bin/gather-spotify-status-v<ver>-<os>-<arch>[.exe] + bin/SHA256SUMS
#   ./build.sh --host   this machine only -> bin/gather-spotify-status[.exe]
set -euo pipefail
exec node "$(dirname "$0")/scripts/build.mjs" "$@"
