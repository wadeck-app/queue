/**
 * Unit tests for queue CLI meta-commands: version, logs, update, waitForDaemon (via start).
 * Uses vi.mock to avoid real process spawns and real npm calls.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runQueueCommand } from './QueueIndex.js';
import { getErrorMessage } from '@wadeck-app/queue-core';

// --- module mocks (hoisted) ---

vi.mock('@wadeck-app/shared-cli/CliMetaCommands', () => ({
	cliVersionCommand: vi.fn().mockResolvedValue(undefined),
	cliLogsCommand: vi.fn().mockResolvedValue(undefined),
	cliUpdateCommand: vi.fn().mockResolvedValue(undefined),
	cliRollbackCommand: vi.fn().mockResolvedValue(undefined),
	warnUnknownArgs: vi.fn(),
}));

// UpdateManager lives in node_modules (externalised), so the node:child_process mock below does not reach its spawn:
// replace it, otherwise a test could really spawn an updater and read the real update-state.json.
const updateManagerMock = vi.hoisted(() => ({ scheduleBackgroundUpdate: vi.fn(), configDirs: [] as Array<string | undefined> }));
vi.mock('@wadeck-app/shared-cli/UpdateManager', () => ({
	UpdateManager: class {
		constructor(_pkgName: string, configDir?: string) { updateManagerMock.configDirs.push(configDir); }
		readAndClearState(): null { return null; }
		scheduleBackgroundUpdate(bundlePath: string, updaterName: string, version?: string): void { updateManagerMock.scheduleBackgroundUpdate(bundlePath, updaterName, version); }
	},
}));

vi.mock('@wadeck-app/shared-cli/ChannelConfig', () => ({
	readChannelFromConfig: vi.fn().mockReturnValue('latest'),
}));

vi.mock('@wadeck-app/shared-cli/CliLogger', () => ({
	logCliInvocation: vi.fn(),
}));

vi.mock('./QueueClient.js', () => ({
	createQueueClient: vi.fn(() => ({
		isRunning: vi.fn().mockResolvedValue(true),
		send: vi.fn().mockResolvedValue({ status: 'ok' }),
	})),
}));

vi.mock('node:child_process', async () => {
	const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
	return { ...actual, spawn: vi.fn(() => ({ unref: vi.fn() })) };
});

// --- helpers ---

let tmpDir: string;
let testStartedAt = 0;

function withArgv(args: string[], fn: () => Promise<void>): Promise<void> {
	const orig = process.argv;
	process.argv = ['node', 'queue.cjs', ...args];
	return fn().finally(() => { process.argv = orig; });
}

function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
	const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
	return { stdout, stderr, restore: () => { spyOut.mockRestore(); spyErr.mockRestore(); } };
}

function mockExit(): { calls: number[]; restore: () => void } {
	const calls: number[] = [];
	// violations-suppress: ts/no-union-with-string process.exit Node.js type includes string
	const spy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
		calls.push(Number(code ?? 0));
		throw new Error(`process.exit(${code})`);
	});
	return { calls, restore: () => spy.mockRestore() };
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const out = captureOutput();
	const exit = mockExit();
	let exitCode = 0;
	try {
		await withArgv(args, runQueueCommand);
	} catch (e) {
		if (e instanceof Error && getErrorMessage(e).startsWith('process.exit(')) {
			exitCode = exit.calls[0] ?? 1;
		} else {
			throw e;
		}
	} finally {
		out.restore();
		exit.restore();
	}
	return { stdout: out.stdout.join(''), stderr: out.stderr.join(''), exitCode };
}

beforeEach(() => {
	testStartedAt = Date.now();
	tmpDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
	process.env['QUEUE_CONFIG_DIR'] = tmpDir;
	process.env['LAUNCHER_BUNDLE_OVERRIDE'] = join(tmpDir, 'queue.cjs');
	vi.clearAllMocks();
});

afterEach(() => {
	delete process.env['QUEUE_CONFIG_DIR'];
	delete process.env['LAUNCHER_BUNDLE_OVERRIDE'];
	rmSync(tmpDir, { recursive: true, force: true });
	// A daemon spawn writes a queue-spawn-<ms>-<random>.vbs that the (mocked) wscript never runs, so nobody deletes it: remove those this test caused
	for (const name of readdirSync(tmpdir())) {
		const written = /^queue-spawn-(\d+)-.*\.vbs$/.exec(name);
		if (written !== null && Number(written[1]) >= testStartedAt) {
			rmSync(join(tmpdir(), name), { force: true });
		}
	}
});

// --- tests ---

describe('queue cli version', () => {
	it('calls cliVersionCommand with pkgName and channel', async () => {
		const { cliVersionCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await run(['cli', 'version']);
		expect(cliVersionCommand).toHaveBeenCalledWith('@wadeck-app/queue-cli', expect.any(String), 'latest');
	});
});

describe('queue cli logs', () => {
	it('queue cli logs exits 0 and outputs no-log-file message when no log exists', async () => {
		const { stdout, exitCode } = await run(['cli', 'logs']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('No log file for today');
	});

	it('top-level queue logs exits 0', async () => {
		const { exitCode } = await run(['logs']);
		expect(exitCode).toBe(0);
	});
});

describe('queue cli history', () => {
	it('is not a cli subcommand -- history is a domain concept, not CLI tooling, so only top-level `queue history` exists', async () => {
		const { stderr, exitCode } = await run(['cli', 'history']);
		expect(exitCode).toBe(1);
		expect(stderr).toMatch(/Unknown cli subcommand/);
		expect(stderr).not.toMatch(/Use:.*history/);
	});
});

describe('background update scheduling', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	// The shared UpdateManager refuses to spawn the updater for a version that is not a release: the CLI must hand it its version
	it('hands its version to the update manager, so that a dev build spawns nothing', async () => {
		await run(['cli', 'version']);
		const [, , version] = updateManagerMock.scheduleBackgroundUpdate.mock.calls[0] ?? [];
		expect(typeof version).toBe('string');
		expect(version).not.toBe('');
	});

	it('schedules the updater next to the bundle for a release build', async () => {
		vi.stubGlobal('__QUEUE_CLI_VERSION__', '2026.10.25-020-6cb52900');
		await run(['cli', 'version']);
		expect(updateManagerMock.scheduleBackgroundUpdate).toHaveBeenCalledTimes(1);
		expect(updateManagerMock.scheduleBackgroundUpdate).toHaveBeenCalledWith(join(tmpDir, 'queue.cjs'), 'queue-updater.cjs', '2026.10.25-020-6cb52900');
	});

	it('reads the update state from QUEUE_CONFIG_DIR, never from the real config dir', async () => {
		updateManagerMock.configDirs.length = 0;
		await run(['cli', 'version']);
		expect(updateManagerMock.configDirs).toEqual([tmpDir]);
	});
});

describe('queue cli update from a dev build', () => {
	// The test runner has no bundler define: the build version is the dev placeholder, not a CalVer release.
	it('refuses with an actionable message and exits 1 without reaching the updater', async () => {
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(tmpDir, 'queue-updater.cjs'), '');
		const { cliUpdateCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		const { stderr, exitCode } = await run(['cli', 'update']);
		expect(exitCode).toBe(1);
		expect(stderr).toMatch(/refusing to update the global install of queue/);
		expect(stderr).toContain('queue cli update');
		expect(cliUpdateCommand).not.toHaveBeenCalled();
	});
});

describe('queue cli update', () => {
	// A release build (CalVer, as stamped by CI): the update path is open.
	beforeEach(() => { vi.stubGlobal('__QUEUE_CLI_VERSION__', '2026.10.25-020-6cb52900'); });
	afterEach(() => { vi.unstubAllGlobals(); });

	it('exits 1 with error message when updater bundle not found', async () => {
		const { stderr, exitCode } = await run(['cli', 'update']);
		expect(exitCode).toBe(1);
		expect(stderr).toMatch(/updater not found/i);
	});

	it('calls cliUpdateCommand when updater bundle exists', async () => {
		const { writeFileSync } = await import('node:fs');
		const updaterPath = join(tmpDir, 'queue-updater.cjs');
		writeFileSync(updaterPath, '');
		process.env['LAUNCHER_BUNDLE_OVERRIDE'] = join(tmpDir, 'queue.cjs');

		const { cliUpdateCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await run(['cli', 'update']);
		expect(cliUpdateCommand).toHaveBeenCalledWith(updaterPath, '@wadeck-app/queue-cli', expect.objectContaining({ rawArgs: expect.any(Array) }));
	});

	it('passes --force in rawArgs so cliUpdateCommand can warn the user', async () => {
		const { writeFileSync } = await import('node:fs');
		const updaterPath = join(tmpDir, 'queue-updater.cjs');
		writeFileSync(updaterPath, '');
		process.env['LAUNCHER_BUNDLE_OVERRIDE'] = join(tmpDir, 'queue.cjs');

		const { cliUpdateCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await run(['cli', 'update', '--force']);
		expect(cliUpdateCommand).toHaveBeenCalledWith(
			updaterPath,
			'@wadeck-app/queue-cli',
			expect.objectContaining({ rawArgs: expect.arrayContaining(['--force']) }),
		);
	});
});

describe('queue start / waitForDaemon', () => {
	it('reports daemon already running when isRunning returns true', async () => {
		const { createQueueClient } = await import('./QueueClient.js');
		vi.mocked(createQueueClient).mockReturnValue({
			isRunning: vi.fn().mockResolvedValue(true),
			send: vi.fn().mockResolvedValue({ status: 'ok' }),
		} as never);

		const { stderr } = await run(['start']);
		expect(stderr).toContain('already running');
	});

	it('exits 1 when daemon fails to start within timeout (isRunning always false)', async () => {
		const { createQueueClient } = await import('./QueueClient.js');
		vi.mocked(createQueueClient).mockReturnValue({
			isRunning: vi.fn().mockResolvedValue(false),
			send: vi.fn().mockResolvedValue({ status: 'ok' }),
		} as never);

		const { spawn } = await import('node:child_process');
		vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);

		// The 5 s start wait runs on a fake clock (setTimeout and Date only: real I/O such as module loading keeps running): it is stepped
		// until the command ends, so the outcome never depends on how fast the machine is
		vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
		try {
			let finished = false;
			const running = run(['start']).finally(() => { finished = true; });
			while (!finished) {
				await vi.advanceTimersByTimeAsync(200);
			}
			const { exitCode, stderr } = await running;
			expect(exitCode).toBe(1);
			expect(stderr).toMatch(/failed to start/i);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('queue cli unknown subcommand', () => {
	it('exits 1 with error message for unknown cli sub', async () => {
		const { stderr, exitCode } = await run(['cli', 'foobar']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('foobar');
	});
});
