/**
 * Unit tests for queue business commands: push, retry, status, dlq.
 * QueueClient is mocked — no real daemon required.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runQueueCommand } from './QueueIndex.js';

// --- module mocks (hoisted) ---

const mockSend = vi.fn();
const mockIsRunning = vi.fn().mockResolvedValue(true);

vi.mock('./QueueClient.js', () => ({
	createQueueClient: vi.fn(() => ({ isRunning: mockIsRunning, send: mockSend })),
}));

vi.mock('@wadeck-app/shared-cli/CliLogger', () => ({ logCliInvocation: vi.fn() }));
vi.mock('@wadeck-app/shared-cli/CliMetaCommands', () => ({
	cliVersionCommand: vi.fn().mockResolvedValue(undefined),
	cliLogsCommand: vi.fn().mockResolvedValue(undefined),
	cliUpdateCommand: vi.fn().mockResolvedValue(undefined),
	cliRollbackCommand: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@wadeck-app/shared-cli/ChannelConfig', () => ({ readChannelFromConfig: vi.fn().mockReturnValue('latest') }));
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

function captureOutput() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const s1 = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
	const s2 = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
	return { stdout, stderr, restore: () => { s1.mockRestore(); s2.mockRestore(); } };
}

function mockExit() {
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
	tmpDir = mkdtempSync(join(tmpdir(), 'queue-cmd-test-'));
	process.env['QUEUE_CONFIG_DIR'] = tmpDir;
	process.env['LAUNCHER_BUNDLE_OVERRIDE'] = join(tmpDir, 'queue.cjs');
	vi.clearAllMocks();
	mockIsRunning.mockResolvedValue(true);
	mockSend.mockResolvedValue({ status: 'ok' });
});

afterEach(() => {
	delete process.env['QUEUE_CONFIG_DIR'];
	delete process.env['LAUNCHER_BUNDLE_OVERRIDE'];
	rmSync(tmpDir, { recursive: true, force: true });
});

// --- push ---

describe('queue push', () => {
	it('sends push command with parsed payload', async () => {
		mockSend.mockResolvedValue({ status: 'queued' });
		const { stdout, exitCode } = await run(['push', 'myEvent', '{"key":"val"}']);
		expect(mockSend).toHaveBeenCalledWith('push', expect.objectContaining({ event: 'myEvent', payload: { key: 'val' } }));
		expect(exitCode).toBe(0);
		expect(stdout).toContain('[ok] queued');
	});

	it('parses --timeout flag into ms', async () => {
		mockSend.mockResolvedValue({ status: 'queued' });
		await run(['push', 'myEvent', '{}', '--timeout', '30s']);
		expect(mockSend).toHaveBeenCalledWith('push', expect.objectContaining({ timeout: 30_000 }));
	});

	it('exits 1 on invalid JSON payload', async () => {
		const { stderr, exitCode } = await run(['push', 'myEvent', 'not-json']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('Invalid JSON');
	});

	it('exits 1 with error message when event is aborted', async () => {
		mockSend.mockResolvedValue({ status: 'aborted', reason: 'hook rejected' });
		const { stderr, exitCode } = await run(['push', 'myEvent', '{}']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('aborted');
	});

	it('exits 1 when event and payload are missing', async () => {
		const { stderr, exitCode } = await run(['push']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('Usage');
	});
});

// --- retry ---

describe('queue retry', () => {
	it('sends retry with eventId', async () => {
		const { stdout, exitCode } = await run(['retry', '--event', 'abc123']);
		expect(mockSend).toHaveBeenCalledWith('retry', { eventId: 'abc123' });
		expect(stdout).toContain('[ok] retry enqueued');
		expect(exitCode).toBe(0);
	});

	it('exits 1 when --event flag is missing', async () => {
		const { stderr, exitCode } = await run(['retry']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('Usage');
	});
});

// --- status ---

describe('queue status', () => {
	it('shows running status in JSON when daemon is up', async () => {
		mockSend.mockResolvedValue({ pendingCount: 3, dlqCount: 1 });
		// Force non-TTY to get JSON output
		const origIsTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
		const { stdout, exitCode } = await run(['status', '--json']);
		Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toMatchObject({ pendingCount: 3, dlqCount: 1 });
	});

	it('shows not-running status when daemon is down', async () => {
		mockIsRunning.mockResolvedValue(false);
		Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
		const { stdout, exitCode } = await run(['status', '--json']);
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.daemonRunning).toBe(false);
	});
});

// --- dlq ---

describe('queue dlq', () => {
	it('dlq list sends dlq-list command', async () => {
		mockSend.mockResolvedValue({ entries: [] });
		await run(['dlq', 'list']);
		expect(mockSend).toHaveBeenCalledWith('dlq-list', undefined);
	});

	it('dlq replay sends dlq-replay with id', async () => {
		mockSend.mockResolvedValue({ status: 'ok' });
		const { stdout, exitCode } = await run(['dlq', 'replay', '--id', 'entry-1']);
		expect(mockSend).toHaveBeenCalledWith('dlq-replay', { id: 'entry-1' });
		expect(stdout).toContain('[ok] replayed');
		expect(exitCode).toBe(0);
	});

	it('dlq replay exits 1 when --id is missing', async () => {
		const { stderr, exitCode } = await run(['dlq', 'replay']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('--id');
	});

	it('dlq clear sends dlq-clear command', async () => {
		mockSend.mockResolvedValue({ cleared: 2 });
		const { stdout } = await run(['dlq', 'clear']);
		expect(mockSend).toHaveBeenCalledWith('dlq-clear', { id: undefined });
		expect(stdout).toContain('cleared 2');
	});
});

// --- unknown command ---

describe('unknown command', () => {
	it('exits 1 with error message', async () => {
		const { stderr, exitCode } = await run(['totally-unknown-xyz']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('Unknown command');
	});
});
