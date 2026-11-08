import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventLogger } from './EventLogger.js';

// The day file is locked for a moment (antivirus, indexer): the append throws
const disk = { failure: undefined as Error | undefined };
vi.mock('./AppendLine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AppendLine.js')>();
  return {
    ...actual,
    appendLine: vi.fn((file: string, line: string) => {
      if (disk.failure !== undefined) {
        throw disk.failure;
      }
      actual.appendLine(file, line);
    }),
  };
});

describe('EventLogger when the log file cannot be written', () => {
  let dir: string;
  let logger: EventLogger;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T12:00:00.000Z'));
    dir = mkdtempSync(join(tmpdir(), 'queue-logger-fail-'));
    logger = new EventLogger(dir);
    disk.failure = undefined;
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const records = (): Array<{ type: string; message?: string; level?: string; source?: string }> =>
    readFileSync(join(dir, '2026-10-19.ndjson'), 'utf-8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { type: string });

  it.each([
    ['logDispatch', (l: EventLogger) => l.logDispatch({ event: 'e', subscriberId: 's', status: 'failed' })],
    ['logFilterMiss', (l: EventLogger) => l.logFilterMiss({ event: 'e', subscriberId: 's', filter: 'f', reason: 'r' })],
    ['logDiagnostic', (l: EventLogger) => l.logDiagnostic({ source: 't', message: 'm' })],
  ])('%s does not throw into the caller', (_name, write) => {
    disk.failure = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    expect(() => write(logger)).not.toThrow();
  });

  it('says it once per cause on stderr, however many records are lost', () => {
    disk.failure = new Error('EBUSY: resource busy or locked');
    for (let i = 0; i < 5; i++) {
      logger.logDiagnostic({ source: 't', message: `m${i}` });
    }
    const said = stderr.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('EBUSY'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(dir);
  });

  it('a different cause is said again', () => {
    disk.failure = new Error('EBUSY: resource busy or locked');
    logger.logDiagnostic({ source: 't', message: 'a' });
    disk.failure = new Error('ENOSPC: no space left on device');
    logger.logDiagnostic({ source: 't', message: 'b' });
    const text = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('EBUSY');
    expect(text).toContain('ENOSPC');
  });

  it('the first record written after the failure says in the log how many were lost and why', () => {
    disk.failure = new Error('EBUSY: resource busy or locked');
    logger.logDiagnostic({ source: 't', message: 'lost 1' });
    logger.logDispatch({ event: 'e', subscriberId: 's', status: 'failed' });
    disk.failure = undefined;
    logger.logDiagnostic({ source: 't', message: 'kept' });

    const written = records();
    const notice = written.find((r) => r.message?.includes('could not be written'));
    expect(notice).toBeDefined();
    expect(notice).toMatchObject({ type: 'diagnostic', level: 'warn', source: 'EventLogger' });
    expect(notice!.message).toContain('2 log record');
    expect(notice!.message).toContain('EBUSY');
    expect(written.some((r) => r.message === 'kept')).toBe(true);
    // said once: a later record carries no second notice
    logger.logDiagnostic({ source: 't', message: 'later' });
    expect(records().filter((r) => r.message?.includes('could not be written'))).toHaveLength(1);
  });

  it('a notice that cannot be written either is kept for the next record', () => {
    disk.failure = new Error('EBUSY: resource busy or locked');
    logger.logDiagnostic({ source: 't', message: 'lost' });
    disk.failure = undefined;
    logger.logDiagnostic({ source: 't', message: 'kept' });
    expect(records().filter((r) => r.message?.includes('could not be written'))).toHaveLength(1);
  });
});
