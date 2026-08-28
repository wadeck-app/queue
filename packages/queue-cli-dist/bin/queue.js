#!/usr/bin/env node
'use strict';
const { execFileSync, execSync } = require('child_process');
const os = require('os');

const PLATFORM_PKG = {
	'win32-x64': '@wadeck/queue-cli-win32-x64',
	'darwin-arm64': '@wadeck/queue-cli-darwin-arm64',
	'darwin-x64': '@wadeck/queue-cli-darwin-x64',
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

// Use __dirname so this works both when installed globally and as devDependency.
const bundlePath = require('path').join(__dirname, '..', 'queue.cjs');

execFileSync(launcherPath, process.argv.slice(2), {
	stdio: 'inherit',
	env: { ...process.env, LAUNCHER_BUNDLE_OVERRIDE: bundlePath },
});
