#!/usr/bin/env node

/**
 * Builds the Go launcher binaries for queue-cli using the SDK build.sh script.
 * Usage: node scripts/build-launcher.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
console.log('Building queue launchers...');
execFileSync('bash', [toUnix(BUILD_SH), toUnix(QUEUE_CONFIG), toUnix(OUT_DIR), toUnix(QUEUE_TEMPLATE)], { stdio: 'inherit', windowsHide: true });
