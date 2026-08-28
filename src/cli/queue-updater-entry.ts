// queue-updater-entry.ts -- background auto-update entry point
// This module is bundled separately as queue-updater.cjs.
// It must NOT import any queue runtime modules
// Allowed: node:fs, node:path, node:child_process, node:os
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Injected by esbuild at bundle time via define; falls back to a dev placeholder.
declare const __QUEUE_CLI_VERSION__: string;

// Package name is injected by the caller via env var.
const PKG_NAME = process.env['UPDATER_PKG_NAME'] ?? '@wadeck-app/queue-cli';
// Version regex — kept inline to avoid importing shared-cli at runtime (separate bundle).
const VERSION_RE = /^\d+\.\d+\.\d+([-+][\w.-]+)?$/;

export function semverLte(a: string, b: string): boolean {
    const parse = (v: string): [number, number, number] => {
        const core = v.split(/[-+]/)[0] ?? v;
        const [maj = '0', min = '0', pat = '0'] = core.split('.');
        return [parseInt(maj, 10), parseInt(min, 10), parseInt(pat, 10)];
    };
    const [aMaj, aMin, aPat] = parse(a);
    const [bMaj, bMin, bPat] = parse(b);
    if (aMaj !== bMaj) return aMaj < bMaj;
    if (aMin !== bMin) return aMin < bMin;
    return aPat <= bPat;
}

interface UpdateState {
    status: 'success' | 'rolled-back' | 'update-failed' | 'applying';
    newVersion?: string;
    previousVersion?: string;
    targetVersion?: string;
    reason?: string;
    timestamp: string;
}

interface UpdateCache {
    checkedAt: number;
}

interface UpdateConfig {
    channel: string;
    checkIntervalMs: number;
    disabled: boolean;
}

function getLockPath(configDir: string): string {
    return path.join(configDir, '.update.lock');
}

function getCachePath(configDir: string): string {
    return path.join(configDir, '.update-cache.json');
}

function getStatePath(configDir: string): string {
    return path.join(configDir, 'update-state.json');
}

function getLogPath(configDir: string): string {
    return path.join(configDir, 'update-log.txt');
}

function appendLog(logFile: string, message: string): void {
    try {
        const line = `[${new Date().toISOString()}] ${message}\n`;
        fs.appendFileSync(logFile, line, 'utf-8');
    } catch {
        // ignore log write errors
    }
}

function writeState(statePath: string, state: UpdateState): void {
    try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
        // ignore state write errors
    }
}

export function parseCheckInterval(value: string): number {
    const match = /^(\d+)([mhd])$/.exec(value.trim());
    if (!match) {
        return 30 * 60 * 1000;
    }
    const num = parseInt(match[1]!, 10);
    switch (match[2]) {
        case 'm':
            return num * 60 * 1000;
        case 'h':
            return num * 60 * 60 * 1000;
        case 'd':
            return num * 24 * 60 * 60 * 1000;
        default:
            return 30 * 60 * 1000;
    }
}

function readConfig(configDir: string): UpdateConfig {
    const configFile = path.join(configDir, 'config.yml');
    const defaults: UpdateConfig = {
        channel: 'edge',
        checkIntervalMs: 30 * 60 * 1000,
        disabled: false,
    };

    if (!fs.existsSync(configFile)) return defaults;

    try {
        const raw = fs.readFileSync(configFile, 'utf-8');
        const channelMatch = /^\s*channel:\s*['"]?(\S+?)['"]?\s*$/m.exec(raw);
        const intervalMatch = /^\s*checkInterval:\s*['"]?(\S+?)['"]?\s*$/m.exec(raw);
        const disabledMatch = /^\s*disabled:\s*(true|false)\s*$/m.exec(raw);

        return {
            channel: channelMatch?.[1] ?? defaults.channel,
            checkIntervalMs: intervalMatch?.[1] ? parseCheckInterval(intervalMatch[1]) : defaults.checkIntervalMs,
            disabled: disabledMatch?.[1] === 'true',
        };
    } catch {
        return defaults;
    }
}

export function tryAcquireLock(lockFile: string): boolean {
    try {
        const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true;
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'EEXIST') {
            try {
                const existingPid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
                if (!isNaN(existingPid)) {
                    try {
                        process.kill(existingPid, 0);
                        return false;
                    } catch {
                        // Process is dead -- stale lock
                    }
                }
                fs.unlinkSync(lockFile);
                const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
                fs.writeSync(fd, String(process.pid));
                fs.closeSync(fd);
                return true;
            } catch {
                return false;
            }
        }
        return false;
    }
}

export async function main(): Promise<void> {
    const cliName = PKG_NAME.replace(/^@[^/]+\//, '').replace(/-cli$/, ''); // 'queue'
    const configDir = ConfigDir.get(cliName);
    fs.mkdirSync(configDir, { recursive: true });

    const lockFile = getLockPath(configDir);
    const logFile = getLogPath(configDir);
    let lockAcquired = false;

    try {
        lockAcquired = tryAcquireLock(lockFile);
        if (!lockAcquired) {
            return;
        }

        const config = readConfig(configDir);
        if (config.disabled) {
            return;
        }

        const force = process.env['UPDATER_FORCE'] === '1';
        const cachePath = getCachePath(configDir);
        if (!force && fs.existsSync(cachePath)) {
            try {
                const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as UpdateCache;
                if (Date.now() - cache.checkedAt < config.checkIntervalMs) {
                    return;
                }
            } catch {
                // Cache unreadable -- proceed
            }
        }
        try {
            fs.writeFileSync(cachePath, JSON.stringify({ checkedAt: Date.now() }), 'utf-8');
        } catch {
            // ignore
        }

        const statePath = getStatePath(configDir);
        const timestamp = new Date().toISOString();
        let latestVersion: string;
        try {
            const { stdout } = await execFileAsync('npm', ['view', PKG_NAME, `dist-tags.${config.channel}`], {
                timeout: 15000,
            });
            latestVersion = stdout.trim();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const reason = msg.includes('EUNAUTHORIZED') || msg.includes('401') ? 'auth' : 'network';
            writeState(statePath, { status: 'update-failed', reason, timestamp });
            appendLog(logFile, `Update check failed: ${msg}`);
            return;
        }

        if (!VERSION_RE.test(latestVersion)) {
            writeState(statePath, { status: 'update-failed', reason: 'invalid-version', timestamp });
            return;
        }

        let currentVersion: string;
        try {
            currentVersion = __QUEUE_CLI_VERSION__;
        } catch {
            return;
        }

        if (semverLte(latestVersion, currentVersion)) {
            return;
        }

        writeState(statePath, {
            status: 'applying',
            previousVersion: currentVersion,
            targetVersion: latestVersion,
            timestamp,
        });

        try {
            await execFileAsync('npm', ['install', '-g', `${PKG_NAME}@${latestVersion}`], { timeout: 120000 });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const reason = msg.includes('EUNAUTHORIZED') || msg.includes('401') ? 'auth' : 'install-failed';
            writeState(statePath, {
                status: 'update-failed',
                reason,
                targetVersion: latestVersion,
                timestamp,
            });
            appendLog(logFile, `Install failed for ${latestVersion}: ${msg}`);
            return;
        }

        try {
            const bundleFile = `${cliName}.cjs`; // 'queue.cjs'
            const { stdout: npmRootOut } = await execFileAsync('npm', ['root', '-g'], { timeout: 10000 });
            const globalBundlePath = path.join(npmRootOut.trim(), PKG_NAME, bundleFile);

            execFileSync(process.execPath, [globalBundlePath, 'cli', 'self-check'], {
                stdio: 'pipe',
                timeout: 15000,
                env: { ...process.env, CLI_SELF_CHECK_QUIET: '1' },
            });
            writeState(statePath, {
                status: 'success',
                newVersion: latestVersion,
                previousVersion: currentVersion,
                timestamp,
            });
        } catch (healthErr: unknown) {
            const msg = healthErr instanceof Error ? healthErr.message : String(healthErr);
            try {
                await execFileAsync('npm', ['install', '-g', `${PKG_NAME}@${currentVersion}`], { timeout: 120000 });
            } catch {
                // rollback failure
            }
            writeState(statePath, {
                status: 'rolled-back',
                reason: 'self-check-failed',
                previousVersion: currentVersion,
                targetVersion: latestVersion,
                timestamp,
            });
            appendLog(logFile, `Self-check failed after updating to ${latestVersion}, rolled back: ${msg}`);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(logFile, `Unexpected updater error: ${msg}`);
    } finally {
        if (lockAcquired) {
            try {
                fs.unlinkSync(lockFile);
            } catch {
                // ignore
            }
        }
    }
}

// Auto-execute only when this is the actual entry point (spawned as detached process).
const isEntryPoint =
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith('queue-updater-entry.js') ||
        process.argv[1].endsWith('queue-updater-entry.ts') ||
        process.argv[1].endsWith('queue-updater.cjs'));

if (isEntryPoint) {
    main().catch(() => {
        process.exit(1);
    });
}
