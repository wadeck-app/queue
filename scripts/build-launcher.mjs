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
const PACKAGE_DIR = path.join(__dirname, '..');

// Resolve build.sh via require.resolve (handles workspace hoisting)
const require = createRequire(import.meta.url);
const sdkPkg = require.resolve('@wadeck/singleton-daemon-kit/package.json');
const SDK_DIR = path.dirname(sdkPkg);
const BUILD_SH = path.join(SDK_DIR, 'go-launcher', 'build.sh');
const QUEUE_CONFIG = path.join(PACKAGE_DIR, 'launcher-queue.config.json');
const OUT_DIR = path.join(PACKAGE_DIR, 'launcher-go', 'dist');

if (!fs.existsSync(BUILD_SH)) {
	console.error(`build.sh not found at ${BUILD_SH}`);
	process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const toUnix = p => p.replace(/\\/g, '/');
console.log('Building queue launchers...');
execFileSync('bash', [toUnix(BUILD_SH), toUnix(QUEUE_CONFIG), toUnix(OUT_DIR)], { stdio: 'inherit' });
