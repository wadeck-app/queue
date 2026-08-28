#!/usr/bin/env bash
# Generates all platform + dist package directories for npm publish.
# Called by CI before copy-binaries.sh. Not needed locally.
# Usage: bash ci/scripts/generate-platform-packages.sh
set -euo pipefail

REGISTRY="https://gitlab.com/api/v4/projects/84445653/packages/npm/"
CLI="queue"
PKG_PREFIX="@wadeck/queue-cli"

generate_platform() {
  local name="$1" os="$2" cpu="$3" bin_file="$4"
  local dir="packages/${name}"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<EOF
{
  "name": "${PKG_PREFIX}-${os}-${cpu}",
  "version": "0.0.0",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": ["${bin_file}"],
  "publishConfig": {
    "@wadeck:registry": "${REGISTRY}"
  }
}
EOF
  echo "generated $dir/package.json"
}

generate_dist() {
  local dir="packages/queue-cli-dist"
  mkdir -p "$dir/bin"

  cat > "$dir/package.json" <<EOF
{
  "name": "@wadeck/queue-cli",
  "version": "0.0.0",
  "private": false,
  "type": "commonjs",
  "bin": {
    "queue": "./bin/queue.js"
  },
  "files": [
    "bin/",
    "queue.cjs",
    "queue-updater.cjs",
    "package.json"
  ],
  "optionalDependencies": {
    "@wadeck/queue-cli-win32-x64": ">=0.0.0-0",
    "@wadeck/queue-cli-darwin-arm64": ">=0.0.0-0",
    "@wadeck/queue-cli-darwin-x64": ">=0.0.0-0"
  },
  "publishConfig": {
    "@wadeck:registry": "${REGISTRY}"
  }
}
EOF

  cat > "$dir/bin/queue.js" <<'BINEOF'
#!/usr/bin/env node
'use strict';
const { execFileSync, execSync } = require('child_process');
const os = require('os');

const PLATFORM_PKG = {
  'win32-x64':    '@wadeck/queue-cli-win32-x64',
  'darwin-arm64': '@wadeck/queue-cli-darwin-arm64',
  'darwin-x64':   '@wadeck/queue-cli-darwin-x64',
};

const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
const key = `${process.platform}-${arch}`;
const pkgName = PLATFORM_PKG[key];
if (!pkgName) {
  process.stderr.write(`queue: unsupported platform ${key}\n`);
  process.exit(1);
}

const ext = process.platform === 'win32' ? '.exe' : '';

let launcherPath;
try {
  launcherPath = require.resolve(`${pkgName}/queue${ext}`);
} catch {
  process.stderr.write(`queue: platform package ${pkgName} missing -- installing...\n`);
  try {
    const out = execSync(`npm install -g ${pkgName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (out) process.stdout.write(out);
  } catch (installErr) {
    if (installErr.stdout) process.stdout.write(installErr.stdout);
    if (installErr.stderr) process.stderr.write(installErr.stderr);
    process.stderr.write(`queue: install failed (exit ${installErr.status})\n`);
    process.exit(1);
  }
  try {
    launcherPath = require.resolve(`${pkgName}/queue${ext}`);
  } catch {
    process.stderr.write(
      `queue: installed ${pkgName} but cannot resolve binary -- try: npm install -g @wadeck/queue-cli\n`
    );
    process.exit(1);
  }
}

const bundlePath = require('path').join(__dirname, '..', 'queue.cjs');
execFileSync(launcherPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, LAUNCHER_BUNDLE_OVERRIDE: bundlePath },
});
BINEOF

  chmod +x "$dir/bin/queue.js"
  echo "generated $dir/"
}

generate_platform "queue-cli-win32-x64"    "win32"  "x64"   "queue.exe"
generate_platform "queue-cli-darwin-arm64" "darwin" "arm64" "queue"
generate_platform "queue-cli-darwin-x64"   "darwin" "x64"   "queue"
generate_dist
