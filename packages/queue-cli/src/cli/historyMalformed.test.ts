/**
 * `queue history` with a torn line in a day file: the readable entries are shown and the skipped line is reported as a [warn] on stderr, never silently.
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

const TORN = '{"ts":"2026-01-01T10:30:00.000Z","type":"trigger","eventId":"ev-torn","event":"onTorn","matchedCount":1,"tot';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'queue-history-malformed-'));
  process.env['QUEUE_CONFIG_DIR'] = tmpDir;
  mkdirSync(join(tmpDir, 'history'), { recursive: true });
  const lines = [
    JSON.stringify({ ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 1, totalCount: 1 }),
    TORN,
    JSON.stringify({ ts: '2026-01-01T11:00:00.000Z', type: 'trigger', eventId: 'ev-2', event: 'onB', matchedCount: 0, totalCount: 0 }),
  ];
  writeFileSync(join(tmpDir, 'history', '2026-01-01.ndjson'), lines.join('\n') + '\n');
});

afterEach(() => {
  delete process.env['QUEUE_CONFIG_DIR'];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('queue history with a malformed line', () => {
  it('lists the readable entries, exits 0 and prints a [warn] naming the file, the count and what to do', async () => {
    const { stdout, stderr, exitCode } = await run(['history']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('onA');
    expect(stdout).toContain('onB');
    expect(stdout).toContain('Showing 1-2 of 2.');
    expect(stderr).toContain('[warn] ');
    expect(stderr).toContain(join(tmpDir, 'history', '2026-01-01.ndjson'));
    expect(stderr).toContain('1 malformed line');
    expect(stderr).toContain(TORN.slice(0, 40));
    expect(stderr).toMatch(/Repair or delete that line/);
  });

  it('--json keeps stdout a clean JSON page (with the warnings in it) and still warns on stderr', async () => {
    const { stdout, stderr, exitCode } = await run(['history', '--json']);
    expect(exitCode).toBe(0);
    const page = JSON.parse(stdout) as { total: number; warnings?: string[] };
    expect(page.total).toBe(2);
    expect(page.warnings).toHaveLength(1);
    expect(stderr).toContain('[warn] ');
  });

  it('prints no warning when every line is readable', async () => {
    writeFileSync(join(tmpDir, 'history', '2026-01-01.ndjson'), JSON.stringify({ ts: '2026-01-01T10:00:00.000Z', type: 'trigger', eventId: 'ev-1', event: 'onA', matchedCount: 1, totalCount: 1 }) + '\n');
    const { stderr, exitCode } = await run(['history']);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('[warn]');
  });
});
