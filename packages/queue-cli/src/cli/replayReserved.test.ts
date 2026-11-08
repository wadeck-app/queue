/**
 * `queue replay <eventId>` of a `queue.*` trigger is refused before anything is sent (the reserved namespace: only the daemon builds those events).
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
  tmpDir = mkdtempSync(join(tmpdir(), 'queue-replay-reserved-'));
  process.env['QUEUE_CONFIG_DIR'] = tmpDir;
  mkdirSync(join(tmpDir, 'history'), { recursive: true });
  const lines = [
    { ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-dlq', event: 'queue.dlq.added', matchedCount: 0, totalCount: 0, payload: { entryId: 'x', original: { $eventRef: 'ev-base' } }, cwd: tmpDir },
  ];
  writeFileSync(join(tmpDir, 'history', '2026-01-01.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

afterEach(() => {
  delete process.env['QUEUE_CONFIG_DIR'];
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('queue replay of a queue.* event', () => {
  it('exits 1 with an actionable message that names the event and the namespace, and does not start the daemon', async () => {
    const { stderr, stdout, exitCode } = await run(['replay', 'ev-dlq']);
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('[fail]');
    expect(stderr).toContain("'queue.dlq.added'");
    expect(stderr).toContain("'queue.' namespace");
    expect(stderr).toContain('cannot be replayed');
    expect(stderr).toContain('Fix:');
  });
});
