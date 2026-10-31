#!/usr/bin/env node

/**
 * Builds the Go launcher binaries for queue-cli using the SDK build.sh script.
 * Usage: node scripts/build-launcher.mjs
 *
 * QUEUE_LAUNCHER_OUT_DIR=<dir>   build into <dir> instead of launcher-go/dist.
 * QUEUE_LAUNCHER_HOST_ONLY=1     build only the host platform (used by the regression test: build.sh itself targets
 *                                windows + 2 darwin only, so a Linux host would get no binary). Runs a patched
 *                                copy of build.sh (target list swapped, SCRIPT_DIR pinned) and fails loudly if
 *                                build.sh no longer has the expected shape. The release build never sets it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(__dirname, '../..');
const CI_DIR = path.join(__dirname, '..');

// Resolve build.sh via require.resolve (handles workspace hoisting)
const require = createRequire(import.meta.url);
const sdkPkg = require.resolve('@wadeck-app/singleton-daemon-kit/package.json');
const SDK_DIR = path.dirname(sdkPkg);
const BUILD_SH = path.join(SDK_DIR, 'go-launcher', 'build.sh');
const QUEUE_CONFIG = path.join(CI_DIR, 'launcher-queue.config.json');
// Custom template: the SDK default does not read QUEUE_CONFIG_DIR (see the header of the template).
const QUEUE_TEMPLATE = path.join(CI_DIR, 'launcher-main.go.tmpl');
// QUEUE_LAUNCHER_OUT_DIR lets the regression test build into a throwaway dir instead of launcher-go/dist.
const OUT_DIR = process.env.QUEUE_LAUNCHER_OUT_DIR || path.join(PACKAGE_DIR, 'launcher-go', 'dist');

for (const required of [BUILD_SH, QUEUE_TEMPLATE]) {
	if (!fs.existsSync(required)) {
		console.error(`Launcher build input not found: ${required}`);
		process.exit(1);
	}
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const toUnix = p => p.replace(/\\/g, '/');

/** build.sh with its 3 build_target calls replaced by the host's one (same output names as build.sh). */
function hostOnlyBuildScript() {
	const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
	const goarch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
	if (!goos || !goarch) {
		console.error(`No launcher can be built for host ${process.platform}/${process.arch}`);
		process.exit(1);
	}
	const suffix = goos === 'windows' ? 'windows_release.exe' : `${goos}_${goarch}_release`;
	let script = fs.readFileSync(BUILD_SH, 'utf8');
	const scriptDirLine = /^SCRIPT_DIR=.*$/m;
	const targetLines = /^build_target "[a-z]+"\s+"[a-z0-9]+"\s+"\$OUTPUT_DIR\/.*$/gm;
	const found = script.match(targetLines) ?? [];
	if (!scriptDirLine.test(script) || found.length !== 3) {
		console.error(`${BUILD_SH} changed shape (SCRIPT_DIR line and 3 build_target calls expected, found ${found.length} calls): update hostOnlyBuildScript in ${fileURLToPath(import.meta.url)}`);
		process.exit(1);
	}
	let first = true;
	script = script.replace(targetLines, () => {
		if (!first) return '';
		first = false;
		return `build_target "${goos}" "${goarch}" "$OUTPUT_DIR/\${APP_NAME}_${suffix}"`;
	});
	return script.replace(scriptDirLine, () => `SCRIPT_DIR="${toUnix(path.dirname(BUILD_SH))}"`);
}

let buildScript = BUILD_SH;
let tmpScriptDir;
if (process.env.QUEUE_LAUNCHER_HOST_ONLY === '1') {
	tmpScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-launcher-build-'));
	buildScript = path.join(tmpScriptDir, 'build-host.sh');
	fs.writeFileSync(buildScript, hostOnlyBuildScript(), { mode: 0o755 });
}
console.log('Building queue launchers...');
try {
	execFileSync('bash', [toUnix(buildScript), toUnix(QUEUE_CONFIG), toUnix(OUT_DIR), toUnix(QUEUE_TEMPLATE)], { stdio: 'inherit', windowsHide: true });
} finally {
	if (tmpScriptDir) fs.rmSync(tmpScriptDir, { recursive: true, force: true });
}
