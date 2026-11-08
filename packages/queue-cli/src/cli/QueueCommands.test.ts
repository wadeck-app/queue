/**
 * Unit tests for queue business commands: push, retry, status, dlq.
 * QueueClient is mocked - no real daemon required.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { addProject } from '@wadeck-app/project-sdk';
import { join } from 'node:path';
import { runQueueCommand } from './QueueIndex.js';
import { WaiterRegistry, getErrorMessage } from '@wadeck-app/queue-core';

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
	tmpDir = mkdtempSync(join(tmpdir(), 'queue-cmd-test-'));
	vi.stubEnv('QUEUE_CONFIG_DIR', tmpDir);
	vi.stubEnv('LAUNCHER_BUNDLE_OVERRIDE', join(tmpDir, 'queue.cjs'));
	vi.clearAllMocks();
	mockIsRunning.mockResolvedValue(true);
	mockSend.mockResolvedValue({ status: 'ok' });
});

afterEach(() => {
	// Puts back what each test stubbed (the real values, or unset), never deletes a variable the developer's shell had
	vi.unstubAllEnvs();
	rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- push ---

describe('queue push', () => {
	it('sends push command with parsed payload', async () => {
		mockSend.mockResolvedValue({ status: 'queued', subscriberCount: 1 });
		const { stdout, exitCode } = await run(['push', 'myEvent', '{"key":"val"}']);
		expect(mockSend).toHaveBeenCalledWith('push', expect.objectContaining({ event: 'myEvent', payload: { key: 'val' } }));
		expect(exitCode).toBe(0);
		expect(stdout).toContain('[ok] queued');
	});

	it('parses --timeout flag into ms', async () => {
		mockSend.mockResolvedValue({ status: 'queued', subscriberCount: 1 });
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

	it('exits 1 and says nothing was recorded when the daemon rejects the push protocol', async () => {
		mockSend.mockResolvedValue({ status: 'rejected', reason: 'push protocol 2.0.0 is not accepted', supported: '^1.0.0' });
		const { stderr, exitCode } = await run(['push', 'myEvent', '{}']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('rejected (nothing was recorded)');
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

describe('queue retry refused by the daemon', () => {
	it('prints the reason on stderr and exits 1 (not a bare JSON on stdout)', async () => {
		mockSend.mockResolvedValue({ status: 'error', message: 'WAL entry w1 was already delivered (status acked)' });
		const { stdout, stderr, exitCode } = await run(['retry', '--event', 'w1']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('[fail] WAL entry w1 was already delivered');
		expect(stdout).toBe('');
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

	it('counts one project only with --project, from the queue files, and says which project', async () => {
		const configDir = process.env['QUEUE_CONFIG_DIR'] as string;
		// the registry the CLI reads is the one under XDG_CONFIG_HOME
		vi.stubEnv('XDG_CONFIG_HOME', join(tmpDir, 'xdg'));
		const project = await addProject(join(tmpDir, 'xdg', 'project'), { name: 'app', path: tmpDir });
		const entry = (id: string, projectId: string) => ({ id, timestamp: new Date().toISOString(), event: 'onFoo', payload: {}, meta: { cwd: '/p', projectId }, subscriberId: 's', status: 'pending' as const, attempts: 0 });
		writeFileSync(join(configDir, 'wal.ndjson'), [entry('a', project.id), entry('b', 'other')].map((line) => JSON.stringify(line)).join('\n') + '\n');
		mockSend.mockResolvedValue({ pendingCount: 2, dlqCount: 0 });
		Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
		const { stdout, exitCode } = await run(['status', '--project', 'app', '--json']);
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ projectId: project.id, pendingCount: 1, dlqCount: 0 });
	});

	it('refuses a --project that is not registered, with the reason, instead of counting nothing', async () => {
		vi.stubEnv('XDG_CONFIG_HOME', join(tmpDir, 'xdg'));
		const { stderr, exitCode } = await run(['status', '--project', 'no-such-project-zzz']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('no-such-project-zzz');
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

describe('queue status with the daemon down reads the queue files', () => {
	function seedQueueFiles(): void {
		const configDir = process.env['QUEUE_CONFIG_DIR'] as string;
		const wal = (id: string, status: string) => ({ id, timestamp: new Date().toISOString(), event: 'onFoo', payload: {}, meta: { cwd: '/p' }, subscriberId: 's', status, attempts: 0 });
		writeFileSync(join(configDir, 'wal.ndjson'), [wal('a', 'pending'), wal('b', 'pending'), wal('c', 'acked')].map((line) => JSON.stringify(line)).join('\n') + '\n');
		const row = (id: string) => ({ id, event: 'onFoo', payload: {}, meta: { cwd: '/p' }, subscriberId: 's', attempts: 3, lastError: 'boom', movedAt: new Date().toISOString() });
		writeFileSync(join(configDir, 'dlq.ndjson'), [row('d1')].map((line) => JSON.stringify(line)).join('\n') + '\n');
	}

	async function statusDown(args: string[], tty: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		mockIsRunning.mockResolvedValue(false);
		Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
		try {
			return await run(args);
		} finally {
			Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		}
	}

	it('--json: the real counts, daemonRunning false, where the counts come from; nothing asked of the daemon', async () => {
		seedQueueFiles();
		const { stdout, exitCode } = await statusDown(['status', '--json'], false);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ daemonRunning: false, pendingCount: 2, dlqCount: 1, source: 'queue-files' });
		expect(JSON.parse(stdout).cliVersion).toEqual(expect.any(String));
		expect(mockSend).not.toHaveBeenCalled();
	});

	it('terminal output: says the daemon is not running and the counts come from the queue files, with the numbers, exit 0, no [fail]', async () => {
		seedQueueFiles();
		const { stdout, stderr, exitCode } = await statusDown(['status'], true);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('daemon not running; counts read from the queue files');
		expect(stdout).toContain('pending: 2');
		expect(stdout).toContain('dlq:     1');
		expect(stdout + stderr).not.toContain('[fail]');
	});

	it('a running daemon is reported with source daemon', async () => {
		mockIsRunning.mockResolvedValue(true);
		mockSend.mockResolvedValue({ pendingCount: 3, dlqCount: 1, daemonRunning: true, uptimeSec: 5, pid: 1 });
		Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
		const { stdout } = await run(['status', '--json']);
		Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
		expect(JSON.parse(stdout)).toMatchObject({ daemonRunning: true, pendingCount: 3, source: 'daemon' });
	});
});

describe('queue retry: every refusal is a failure with a message', () => {
	it('an id that is not in the WAL (not-found) exits 1 and says how to find a valid one', async () => {
		mockSend.mockResolvedValue({ status: 'not-found' });
		const { stdout, stderr, exitCode } = await run(['retry', '--event', 'nope']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('[fail] no WAL entry with id nope');
		expect(stdout).toBe('');
	});

	it('an error without a message exits 1 and points to the daemon log', async () => {
		mockSend.mockResolvedValue({ status: 'error' });
		const { stdout, stderr, exitCode } = await run(['retry', '--event', 'w1']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("queue logs");
		expect(stdout).toBe('');
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

// --- dlq: destructive arguments are explicit ---

describe('queue dlq: a missing value never widens the operation', () => {
	const sentCommands = (): string[] => mockSend.mock.calls.map((call) => String(call[0]));

	it.each([
		['--id without a value', ['dlq', 'clear', '--id']],
		['--id followed by another flag', ['dlq', 'clear', '--id', '--json']],
		['--id with an empty value', ['dlq', 'clear', '--id', '']],
	])('dlq clear %s: usage error, exit 1, nothing sent, so nothing cleared', async (_name, args) => {
		const { stderr, stdout, exitCode } = await run(args);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('--id needs a value');
		expect(stderr).toContain('Nothing was cleared');
		expect(stderr).toContain("'queue dlq clear' without --id");
		expect(stdout).toBe('');
		expect(sentCommands()).not.toContain('dlq-clear');
	});

	it('dlq clear refuses an argument it does not know (a typo of --id must not clear everything)', async () => {
		for (const args of [['dlq', 'clear', '--idd', 'x'], ['dlq', 'clear', 'x']]) {
			const { stderr, exitCode } = await run(args);
			expect(exitCode, args.join(' ')).toBe(1);
			expect(stderr).toMatch(args[2] === 'x' ? /unexpected argument 'x'/ : /unknown option '--idd'/);
		}
		expect(sentCommands()).not.toContain('dlq-clear');
	});

	it('dlq clear without --id clears everything on purpose and says how many', async () => {
		mockSend.mockResolvedValue({ cleared: 3 });
		const { stdout, exitCode } = await run(['dlq', 'clear']);
		expect(exitCode).toBe(0);
		expect(mockSend).toHaveBeenCalledWith('dlq-clear', { id: undefined });
		expect(stdout).toContain('[ok] cleared 3 entries (the whole DLQ)');
	});

	it('dlq clear of an empty DLQ says so', async () => {
		mockSend.mockResolvedValue({ cleared: 0 });
		const { stdout, exitCode } = await run(['dlq', 'clear']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('the DLQ was already empty');
	});

	it('dlq clear --id <id> reports the entry it cleared', async () => {
		mockSend.mockResolvedValue({ cleared: 1 });
		const { stdout, exitCode } = await run(['dlq', 'clear', '--id', 'abc']);
		expect(exitCode).toBe(0);
		expect(mockSend).toHaveBeenCalledWith('dlq-clear', { id: 'abc' });
		expect(stdout).toContain('[ok] cleared 1 entries (id abc)');
	});

	it('dlq clear --id <unknown> exits 1 and says where to find the ids', async () => {
		mockSend.mockResolvedValue({ cleared: 0 });
		const { stderr, stdout, exitCode } = await run(['dlq', 'clear', '--id', 'nope']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('no DLQ entry with id nope (queue dlq list shows the ids)');
		expect(stdout).not.toContain('[ok]');
	});

	it('dlq clear surfaces the reason when the daemon refuses the request', async () => {
		mockSend.mockResolvedValue({ cleared: 0, reason: 'dlq-clear needs the id of one entry' });
		const { stderr, exitCode } = await run(['dlq', 'clear', '--id', 'x']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('dlq-clear needs the id of one entry');
	});

	it.each([
		['--id without a value', ['dlq', 'replay', '--id']],
		['--id followed by another flag', ['dlq', 'replay', '--id', '--json']],
	])('dlq replay %s: usage error, exit 1, nothing sent', async (_name, args) => {
		const { stderr, exitCode } = await run(args);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('--id needs a value');
		expect(sentCommands()).not.toContain('dlq-replay');
	});

	it('dlq replay --id <unknown> (daemon: not-found) exits 1 with a message on stderr and no JSON on stdout', async () => {
		mockSend.mockResolvedValue({ status: 'not-found' });
		const { stderr, stdout, exitCode } = await run(['dlq', 'replay', '--id', 'nope']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('no DLQ entry with id nope (queue dlq list shows the ids)');
		expect(stdout).toBe('');
	});

	it('dlq replay: a daemon error is printed as it is on stderr, exit 1, no JSON on stdout', async () => {
		mockSend.mockResolvedValue({ status: 'error', message: 'The replay of DLQ entry e1 did not start: Fix: repair subscribers.yml' });
		const { stderr, stdout, exitCode } = await run(['dlq', 'replay', '--id', 'e1']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('[fail] The replay of DLQ entry e1 did not start: Fix: repair subscribers.yml');
		expect(stdout).toBe('');
	});

	it('dlq replay: an answer the CLI does not know is a failure that shows the answer, not a silent success', async () => {
		mockSend.mockResolvedValue({ status: 'weird' });
		const { stderr, stdout, exitCode } = await run(['dlq', 'replay', '--id', 'e1']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain('{"status":"weird"}');
		expect(stdout).toBe('');
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

// --- waiters ---

describe('queue waiters and the "Waiting now" section', () => {
	const aWait = (name: string, events = ['onTaskDone']) => new WaiterRegistry(tmpDir).register({ name, events, whens: [], label: '', since: new Date().toISOString(), cwd: '/project' });

	async function listSubscribers(args: string[], tty: boolean): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		mockSend.mockResolvedValue({ subscribers: [] });
		const origIsTTY = process.stdout.isTTY;
		Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
		try {
			return await run(['list-subscribers', ...args]);
		} finally {
			Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
		}
	}

	it('list-subscribers on a terminal adds the waits that are running, after the subscribers', async () => {
		aWait('w-agent-wake.ab12cd34');
		const { stdout, exitCode } = await listSubscribers([], true);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('[ok] no subscribers');
		expect(stdout).toContain('Waiting now (1):');
		expect(stdout).toContain('w-agent-wake.ab12cd34');
		expect(stdout.indexOf('no subscribers')).toBeLessThan(stdout.indexOf('Waiting now'));
	});

	it('list-subscribers on a terminal without any wait prints no section', async () => {
		expect((await listSubscribers([], true)).stdout).toBe('[ok] no subscribers\n');
	});

	it('list-subscribers <event> keeps only the waits for that event', async () => {
		aWait('a.one', ['onTaskDone']);
		aWait('a.two', ['onOther']);
		const { stdout } = await listSubscribers(['onTaskDone'], true);
		expect(stdout).toContain('a.one');
		expect(stdout).not.toContain('a.two');
	});

	it('list-subscribers --json (and a pipe) is the bare array of subscribers, byte for byte, waits or not', async () => {
		aWait('a.one');
		expect((await listSubscribers(['--json'], true)).stdout).toBe('[]\n');
		expect((await listSubscribers([], false)).stdout).toBe('[]\n');
	});

	it('queue waiters --json lists the waits through the CLI', async () => {
		aWait('a.one');
		const { stdout, exitCode } = await run(['waiters', '--json']);
		expect(exitCode).toBe(0);
		expect((JSON.parse(stdout) as Array<{ name: string }>).map((wait) => wait.name)).toEqual(['a.one']);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it('queue waiters refuses an option nobody knows, with the closest one and the usage', async () => {
		const { stderr, exitCode } = await run(['waiters', '--histroy']);
		expect(exitCode).toBe(1);
		expect(stderr).toContain("did you mean '--history'?");
		expect(stderr).toContain('Usage: queue waiters');
	});

	it('queue waiters --help prints its help and reads nothing', async () => {
		const { stdout, exitCode } = await run(['waiters', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('queue waiters - Who is waiting');
		expect(stdout).toContain('--history');
	});
});
