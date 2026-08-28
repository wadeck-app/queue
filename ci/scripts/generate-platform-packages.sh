#!/usr/bin/env bash
# Generates platform package directories for npm publish.
# Called by CI before copy-binaries.sh. Not needed locally.
# Usage: bash ci/scripts/generate-platform-packages.sh
set -euo pipefail

REGISTRY="https://gitlab.com/api/v4/projects/84445653/packages/npm/"

generate() {
  local name="$1" os="$2" cpu="$3" bin_file="$4"
  local dir="packages/${name}"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<EOF
{
  "name": "@wadeck/${name}",
  "version": "0.0.0",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": ["${bin_file}"],
  "publishConfig": {
    "@wadeck:registry": "${REGISTRY}"
  }
}
EOF
  echo "generated packages/${name}/package.json"
}

generate "queue-cli-win32-x64"    "win32"  "x64"   "queue.exe"
generate "queue-cli-darwin-arm64" "darwin" "arm64" "queue"
generate "queue-cli-darwin-x64"   "darwin" "x64"   "queue"
