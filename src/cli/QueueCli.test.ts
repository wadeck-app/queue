/**
 * Unit tests for queue CLI meta-commands: version, logs, update, waitForDaemon (via start).
 * Uses vi.mock to avoid real process spawns and real npm calls.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runQueueCommand } from './QueueIndex.js';

// --- module mocks (hoisted) ---

vi.mock('@wadeck-app/shared-cli/CliMetaCommands', () => ({
	cliVersionCommand: vi.fn().mockResolvedValue(undefined),
	cliLogsCommand: vi.fn().mockResolvedValue(undefined),
	cliUpdateCommand: vi.fn().mockResolvedValue(undefined),
	cliRollbackCommand: vi.fn().mockResolvedValue(undefined),
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
		if (e instanceof Error && e.message.startsWith('process.exit(')) {
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
	tmpDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
	process.env['QUEUE_CONFIG_DIR'] = tmpDir;
	process.env['LAUNCHER_BUNDLE_OVERRIDE'] = join(tmpDir, 'queue.cjs');
	vi.clearAllMocks();
});

afterEach(() => {
	delete process.env['QUEUE_CONFIG_DIR'];
	delete process.env['LAUNCHER_BUNDLE_OVERRIDE'];
	rmSync(tmpDir, { recursive: true, force: true });
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
	it('calls cliLogsCommand without follow by default', async () => {
		const { cliLogsCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await run(['cli', 'logs']);
		expect(cliLogsCommand).toHaveBeenCalledWith(tmpDir, { follow: false });
	});

	it('calls cliLogsCommand with follow: true when --follow passed', async () => {
		const { cliLogsCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await run(['cli', 'logs', '--follow']);
		expect(cliLogsCommand).toHaveBeenCalledWith(tmpDir, { follow: true });
	});

	it('top-level `queue logs` alias also calls cliLogsCommand', async () => {
		const { cliLogsCommand } = await import('@wadeck-app/shared-cli/CliMetaCommands');
		await run(['logs', '--follow']);
		expect(cliLogsCommand).toHaveBeenCalledWith(tmpDir, { follow: true });
	});
});

describe('queue cli update', () => {
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
});

describe('queue start / waitForDaemon', () => {
	it('reports daemon already running when isRunning returns true', async () => {
		const { createQueueClient } = await import('./QueueClient.js');
		vi.mocked(createQueueClient).mockReturnValue({
			isRunning: vi.fn().mockResolvedValue(true),
			send: vi.fn().mockResolvedValue({ status: 'ok' }),
		} as never);

		const { stdout } = await run(['start']);
		expect(stdout).toContain('already running');
	});

	it('exits 1 when daemon fails to start within timeout (isRunning always false)', async () => {
		const { createQueueClient } = await import('./QueueClient.js');
		vi.mocked(createQueueClient).mockReturnValue({
			isRunning: vi.fn().mockResolvedValue(false),
			send: vi.fn().mockResolvedValue({ status: 'ok' }),
		} as never);

		const { spawn } = await import('node:child_process');
		vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);

		const { exitCode, stderr } = await run(['start']);
		expect(exitCode).toBe(1);
		expect(stderr).toMatch(/failed to start/i);
	}, 10_000);
});

describe('queue cli unknown subcommand', () => {
	it('exits 1 with error message for unknown cli sub', async () => {
		const { stderr, exitCode } = await run(['cli', 'foobar']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('foobar');
	});
});
