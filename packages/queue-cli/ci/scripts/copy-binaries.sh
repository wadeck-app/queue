#!/usr/bin/env bash
# Copies Go launcher binaries and esbuild bundles into platform packages and dist package.
# Usage: bash ci/scripts/copy-binaries.sh
set -euo pipefail

QUEUE_LAUNCHER_DIST="packages/queue-cli/launcher-go/dist"
QUEUE_DIST_BUNDLE="packages/queue-cli/dist-bundle"

cp "$QUEUE_LAUNCHER_DIST/queue_windows_release.exe"  packages/queue-cli-win32-x64/queue.exe
cp "$QUEUE_LAUNCHER_DIST/queue_darwin_arm64_release"  packages/queue-cli-darwin-arm64/queue
cp "$QUEUE_LAUNCHER_DIST/queue_darwin_amd64_release"  packages/queue-cli-darwin-x64/queue
chmod +x packages/queue-cli-darwin-arm64/queue packages/queue-cli-darwin-x64/queue
cp "$QUEUE_DIST_BUNDLE/queue.cjs"          packages/queue-cli-dist/queue.cjs
cp "$QUEUE_DIST_BUNDLE/queue-updater.cjs"  packages/queue-cli-dist/queue-updater.cjs
cp "$QUEUE_DIST_BUNDLE/queue-daemon.cjs"   packages/queue-cli-dist/queue-daemon.cjs
echo "queue artifacts copied"
