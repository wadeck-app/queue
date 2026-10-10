#!/usr/bin/env bash
# Generates all platform + dist package directories for npm publish.
# Called by CI before copy-binaries.sh. Not needed locally.
# Usage: bash ci/scripts/generate-platform-packages.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/../templates"
REGISTRY="https://npm.pkg.github.com/"
CLI="queue"

generate_platform() {
  local name="$1" os="$2" cpu="$3" bin_file="$4"
  local dir="packages/${name}"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<EOF
{
  "name": "@wadeck-app/${name}",
  "version": "0.0.0",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": ["${bin_file}"],
  "publishConfig": {
    "@wadeck-app:registry": "${REGISTRY}"
  }
}
EOF
  echo "generated $dir/package.json"
}

generate_dist() {
  local dir="packages/${CLI}-cli-dist"
  mkdir -p "$dir/bin"

  cat > "$dir/package.json" <<EOF
{
  "name": "@wadeck-app/${CLI}-cli",
  "version": "0.0.0",
  "private": false,
  "type": "commonjs",
  "bin": {
    "${CLI}": "./bin/${CLI}.js"
  },
  "files": [
    "bin/",
    "${CLI}.cjs",
    "${CLI}-updater.cjs",
    "${CLI}-daemon.cjs",
    "package.json"
  ],
  "optionalDependencies": {
    "@wadeck-app/${CLI}-cli-win32-x64": ">=0.0.0-0",
    "@wadeck-app/${CLI}-cli-darwin-arm64": ">=0.0.0-0",
    "@wadeck-app/${CLI}-cli-darwin-x64": ">=0.0.0-0"
  },
  "publishConfig": {
    "@wadeck-app:registry": "${REGISTRY}"
  }
}
EOF

  sed -e "s/{{CLI_NAME}}/${CLI}/g" -e "s/{{PKG_PREFIX}}/${CLI}-cli/g" "$TEMPLATES_DIR/bin-launcher.js.tmpl" > "$dir/bin/${CLI}.js"
  chmod +x "$dir/bin/${CLI}.js"
  echo "generated $dir/"
}

generate_platform "queue-cli-win32-x64"    "win32"  "x64"   "queue.exe"
generate_platform "queue-cli-darwin-arm64" "darwin" "arm64" "queue"
generate_platform "queue-cli-darwin-x64"   "darwin" "x64"   "queue"
generate_dist
