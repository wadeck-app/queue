import { describe, it, expect } from 'vitest';
import { parseEventWaitArgs, EVENT_WAIT_KNOWN_FLAGS } from './eventWaitArgs.js';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

describe('parseEventWaitArgs', () => {
  it('defaults: only events after now, 15 minutes, human output', () => {
    expect(parseEventWaitArgs(['onStatusChange'], NOW)).toEqual({
      ok: true,
      options: { event: 'onStatusChange', whens: [], sinceMs: NOW, timeoutMs: 15 * 60_000, pollMs: 500, json: false },
    });
  });

  it('collects every repeated --when', () => {
    const result = parseEventWaitArgs(['onStatusChange', '--when', 'payload.taskId=abc', '--when', 'payload.newStatus=done'], NOW);
    expect(result).toMatchObject({ ok: true, options: { whens: ['payload.taskId=abc', 'payload.newStatus=done'] } });
  });

  it('--timeout and --json', () => {
    expect(parseEventWaitArgs(['onFoo', '--timeout', '30s', '--json'], NOW)).toMatchObject({ ok: true, options: { timeoutMs: 30_000, json: true } });
  });

  it('--since accepts a duration (counted back from now)', () => {
    expect(parseEventWaitArgs(['onFoo', '--since', '10m'], NOW)).toMatchObject({ ok: true, options: { sinceMs: NOW - 10 * 60_000 } });
  });

  it('--since accepts an ISO timestamp', () => {
    expect(parseEventWaitArgs(['onFoo', '--since', '2026-10-18T11:00:00Z'], NOW)).toMatchObject({ ok: true, options: { sinceMs: Date.parse('2026-10-18T11:00:00Z') } });
  });

  it('rejects a --since that is neither, with examples', () => {
    const result = parseEventWaitArgs(['onFoo', '--since', 'yesterdayish'], NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('--since');
    expect((result as { message: string }).message).toContain('10m');
  });

  it('rejects a bad --timeout with the accepted forms', () => {
    const result = parseEventWaitArgs(['onFoo', '--timeout', 'soon'], NOW);
    expect((result as { message: string }).message).toContain('30s, 15m, 1h');
  });

  it('rejects a --when without "=" at once, instead of waiting for a filter that can never match', () => {
    const result = parseEventWaitArgs(['onFoo', '--when', 'payload.taskId'], NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('--when');
    expect((result as { message: string }).message).toContain("no '='");
  });

  it('rejects a flag that is missing its value', () => {
    const result = parseEventWaitArgs(['onFoo', '--when'], NOW);
    expect((result as { message: string }).message).toContain('--when needs a value');
  });

  it('rejects a missing event name', () => {
    const result = parseEventWaitArgs(['--json'], NOW);
    expect((result as { message: string }).message).toContain('event');
  });
});

describe('parseEventWaitArgs --strict', () => {
  it('is off by default and does not appear in the options', () => {
    const result = parseEventWaitArgs(['onFoo'], NOW);
    expect(result.ok && 'strict' in result.options).toBe(false);
  });

  it('--strict turns it on and is not taken for the event name', () => {
    expect(parseEventWaitArgs(['--strict', 'onFoo'], NOW)).toMatchObject({ ok: true, options: { event: 'onFoo', strict: true } });
  });

  it('is a known flag', () => {
    expect(EVENT_WAIT_KNOWN_FLAGS).toContain('--strict');
  });
});
