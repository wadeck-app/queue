/**
 * `queue history --event-id <id>`: one entry by its exact id, read straight from the history files (no daemon).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runQueueCommand } from './QueueIndex.js';
import { getErrorMessage } from '@wadeck-app/queue-core';

vi.mock('@wadeck-app/shared-cli/CliLogger', () => ({ logCliInvocation: vi.fn() }));

let tmpDir: string;

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const s1 = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { stdout.push(String(c)); return true; });
  const s2 = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { stderr.push(String(c)); return true; });
  const exitCodes: number[] = [];
  // violations-suppress: ts/no-union-with-string process.exit Node.js type includes string
  const exit = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    exitCodes.push(Number(code ?? 0));
    throw new Error(`process.exit(${code})`);
  });
  const origArgv = process.argv;
  process.argv = ['node', 'queue.cjs', ...args];
  let exitCode = 0;
  try {
    await runQueueCommand();
  } catch (e) {
    if (e instanceof Error && getErrorMessage(e).startsWith('process.exit(')) {
      exitCode = exitCodes[0] ?? 1;
    } else {
      throw e;
    }
  } finally {
    process.argv = origArgv;
    s1.mockRestore();
    s2.mockRestore();
    exit.mockRestore();
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'queue-history-eventid-'));
  process.env['QUEUE_CONFIG_DIR'] = tmpDir;
  mkdirSync(join(tmpDir, 'history'), { recursive: true });
  const lines = [
    { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 1, totalCount: 1, payload: { a: 1 } },
    { ts: '2026-01-01T10:00:01.000Z', type: 'outcome', eventId: 'ev-1', event: 'onA', subscriberId: 's1', status: 'success' },
    { ts: '2026-01-01T11:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0 },
  ];
  writeFileSync(join(tmpDir, 'history', '2026-01-01.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

afterEach(() => {
  delete process.env['QUEUE_CONFIG_DIR'];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue history --event-id', () => {
  it('--json returns the entry (payload and outcomes), not a page', async () => {
    const { stdout, exitCode } = await run(['history', '--event-id', 'ev-1', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ eventId: 'ev-1', event: 'onA', payload: { a: 1 }, subscribers: [{ subscriberId: 's1', status: 'success' }] });
  });

  it('prints the formatted entry without --json, and only that one', async () => {
    const { stdout, exitCode } = await run(['history', '--event-id', 'ev-2']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('onB');
    expect(stdout).not.toContain('onA');
  });

  it('an unknown id exits 1 and says what the history keeps and how to find the id', async () => {
    const { stderr, exitCode } = await run(['history', '--event-id', 'nope']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[fail] No history entry for eventId nope');
    expect(stderr).toMatch(/at most 90 days and 200 MB/);
    expect(stderr).toContain("check the id with 'queue history'");
  });

  it('refuses a combination with a filter instead of ignoring one of them', async () => {
    const { stderr, exitCode } = await run(['history', '--event-id', 'ev-1', '--event', 'onA']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('cannot be combined with --event');
  });
});
