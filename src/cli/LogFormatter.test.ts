import { describe, it, expect } from 'vitest';
import { LogFormatter } from './LogFormatter.js';

const TS = '2026-09-13T13:05:22.000Z';

describe('LogFormatter', () => {
  it('blank line renders nothing', () => {
    expect(LogFormatter.format('   ')).toBe('');
  });

  it('non-JSON line is passed through', () => {
    expect(LogFormatter.format('not json')).toBe('not json');
  });

  it('CLI invocation renders the command', () => {
    expect(LogFormatter.format(JSON.stringify({ ts: TS, msg: 'cmd: queue push onTest' }))).toBe('[13:05:22] queue push onTest');
  });

  it('successful dispatch renders one line without output', () => {
    const line = LogFormatter.format(JSON.stringify({
      ts: TS, type: 'dispatch', status: 'success', subscriberId: 'onTest[0]', target: 'my-cli', durationMs: 12,
    }));
    expect(line).toBe('[13:05:22] [ok] onTest[0] -> my-cli (12ms)');
  });

  it('failed dispatch renders the captured stderr, one prefixed line per output line', () => {
    const line = LogFormatter.format(JSON.stringify({
      ts: TS,
      type: 'dispatch',
      status: 'failed',
      subscriberId: 'onTest[0]',
      target: 'my-cli run',
      durationMs: 120,
      error: 'exited with code 3',
      stderr: "Cannot find module 'extension-points/extension-points.json'\n    at loader\n",
    }));
    const lines = line.split('\n');
    expect(lines[0]).toBe('[13:05:22] [fail] onTest[0] -> my-cli run - exited with code 3 (120ms)');
    expect(lines[1]).toContain("stderr | Cannot find module 'extension-points/extension-points.json'");
    expect(lines[2]).toContain('stderr |     at loader');
    // trailing newline of the stream must not produce an empty output line
    expect(lines).toHaveLength(3);
  });

  it('failed dispatch renders stdout before stderr', () => {
    const line = LogFormatter.format(JSON.stringify({
      ts: TS, type: 'dispatch', status: 'failed', subscriberId: 'onTest[0]', error: 'exited with code 1',
      stdout: 'progress 50%', stderr: 'boom',
    }));
    expect(line.split('\n').slice(1).map(l => l.trim())).toEqual(['stdout | progress 50%', 'stderr | boom']);
  });

  it('dlq dispatch renders attempts and output', () => {
    const line = LogFormatter.format(JSON.stringify({
      ts: TS, type: 'dispatch', status: 'dlq', subscriberId: 'onTest[0]', target: 'my-cli',
      error: 'exited with code 3', attempts: 5, stderr: 'boom',
    }));
    expect(line.split('\n')[0]).toBe('[13:05:22] [warn] dlq onTest[0] -> my-cli - exited with code 3 (attempts: 5)');
    expect(line).toContain('stderr | boom');
  });

  it('filter miss renders path, expected and actual', () => {
    const line = LogFormatter.format(JSON.stringify({
      ts: TS, type: 'filter-miss', subscriberId: 'onTest[1]', filter: 'payload.exitCode=1',
      reason: 'value mismatch', path: 'payload.exitCode', expected: '1', actual: '0',
    }));
    expect(line).toBe('[13:05:22] [miss] filter-miss onTest[1] when "payload.exitCode=1" - value mismatch: path "payload.exitCode" expected "1", found "0"');
  });

  it('filter miss without details has no dangling colon', () => {
    const line = LogFormatter.format(JSON.stringify({
      ts: TS, type: 'filter-miss', subscriberId: 'onTest[1]', filter: 'payload.exitCode', reason: 'bad syntax',
    }));
    expect(line).toBe('[13:05:22] [miss] filter-miss onTest[1] when "payload.exitCode" - bad syntax');
  });

  it('diagnostic renders source and message', () => {
    const line = LogFormatter.format(JSON.stringify({
      ts: TS, type: 'diagnostic', source: 'AsyncDispatcher', message: 'no WAL entry for subscriber onTest[0]',
    }));
    expect(line).toBe('[13:05:22] [info] AsyncDispatcher: no WAL entry for subscriber onTest[0]');
  });

  it('missing ts is rendered explicitly, not silently dropped', () => {
    expect(LogFormatter.format(JSON.stringify({ type: 'diagnostic', source: 's', message: 'm' })))
      .toBe('[??:??:??] [info] s: m');
  });

  it('unknown record type falls back to the raw line', () => {
    const raw = JSON.stringify({ ts: TS, type: 'future-type', a: 1 });
    expect(LogFormatter.format(raw)).toBe(raw);
  });
});
