import { describe, it, expect } from 'vitest';
import { parseEventWaitArgs, EVENT_WAIT_KNOWN_FLAGS } from './eventWaitArgs.js';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

describe('parseEventWaitArgs', () => {
  it('defaults: only events after now, 30 minutes, the first event that happens, human output', () => {
    expect(parseEventWaitArgs(['onStatusChange'], NOW)).toEqual({
      ok: true,
      options: { targets: [{ event: 'onStatusChange', whens: [] }], mode: 'any', sinceMs: NOW, timeoutMs: 30 * 60_000, pollMs: 500, json: false },
    });
  });

  it('collects every repeated --when', () => {
    const result = parseEventWaitArgs(['onStatusChange', '--when', 'payload.taskId=abc', '--when', 'payload.newStatus=done'], NOW);
    expect(result).toMatchObject({ ok: true, options: { targets: [{ event: 'onStatusChange', whens: ['payload.taskId=abc', 'payload.newStatus=done'] }] } });
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
    expect(parseEventWaitArgs(['--strict', 'onFoo'], NOW)).toMatchObject({ ok: true, options: { targets: [{ event: 'onFoo' }], strict: true } });
  });

  it('is a known flag', () => {
    expect(EVENT_WAIT_KNOWN_FLAGS).toContain('--strict');
  });
});

describe('parseEventWaitArgs: several events at once', () => {
  it('every name starts a wait, and a --when belongs to the event written before it', () => {
    const result = parseEventWaitArgs(['onTaskDone', '--when', 'payload.taskId=abc', 'onTaskFailed', '--when', 'payload.taskId=abc', '--when', 'payload.code=1'], NOW);
    expect(result).toMatchObject({
      ok: true,
      options: {
        mode: 'any',
        targets: [
          { event: 'onTaskDone', whens: ['payload.taskId=abc'] },
          { event: 'onTaskFailed', whens: ['payload.taskId=abc', 'payload.code=1'] },
        ],
      },
    });
  });

  it('the same event can be waited for twice with different filters', () => {
    const result = parseEventWaitArgs(['onStatusChange', '--when', 'payload.newStatus=done', 'onStatusChange', '--when', 'payload.newStatus=blocked'], NOW);
    expect(result).toMatchObject({ ok: true, options: { targets: [{ whens: ['payload.newStatus=done'] }, { whens: ['payload.newStatus=blocked'] }] } });
  });

  it('flags for the whole wait can come anywhere and are not taken for events', () => {
    const result = parseEventWaitArgs(['--timeout', '1h', 'onA', '--json', 'onB', '--all'], NOW);
    expect(result).toMatchObject({ ok: true, options: { mode: 'all', timeoutMs: 3_600_000, json: true, targets: [{ event: 'onA' }, { event: 'onB' }] } });
  });

  it('refuses a --when written before any event, saying that a filter belongs to the event before it', () => {
    const result = parseEventWaitArgs(['--when', 'payload.a=1', 'onFoo'], NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('belongs to the event written before it');
  });

  it('refuses --all together with --any', () => {
    const result = parseEventWaitArgs(['onA', 'onB', '--all', '--any'], NOW);
    expect((result as { message: string }).message).toContain('exclude each other');
  });

  it('knows --all and --any', () => {
    expect(EVENT_WAIT_KNOWN_FLAGS).toEqual(expect.arrayContaining(['--all', '--any']));
  });

  it.each([
    [['onFoo', '--timeout', '5m', '--timeout', '10m'], '--timeout is given twice'],
    [['onFoo', '--since', '5m', '--since', '10m'], '--since is given twice'],
  ])('rejects a flag given twice, the second would be silently ignored: %j', (args, expected) => {
    const result = parseEventWaitArgs(args, NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain(expected);
  });

  it.each([
    [['onFoo', '--timeout=5m'], '--timeout 5m'],
    [['onFoo', '--since=10m'], '--since 10m'],
    [['onFoo', '--when=payload.a=b'], '--when payload.a=b'],
  ])('refuses the --flag=value form and says to write the flag and its value apart: %j', (args, expected) => {
    const result = parseEventWaitArgs(args, NOW);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain(expected);
  });

  it('rejects a flag with an empty value', () => {
    expect((parseEventWaitArgs(['onFoo', '--timeout', ''], NOW) as { message: string }).message).toContain('--timeout needs a value');
  });
});

describe('parseEventWaitArgs: an unknown option is a usage error', () => {
  it('names the option and suggests the closest valid one (a typo used to wait with the default timeout)', () => {
    const result = parseEventWaitArgs(['onFoo', '--timout', '5m'], NOW) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unknown option '--timout'");
    expect(result.message).toContain("did you mean '--timeout'?");
  });

  it('refuses an unknown switch and does not take the word after it for an event name', () => {
    const result = parseEventWaitArgs(['onFoo', '--jsno'], NOW) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did you mean '--json'?");
  });

  it('an unrelated option has no suggestion but is still refused', () => {
    const result = parseEventWaitArgs(['onFoo', '--zzzzzzzzzz'], NOW) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unknown option '--zzzzzzzzzz'");
    expect(result.message).not.toContain('did you mean');
  });

  it('every known flag is still accepted', () => {
    expect(parseEventWaitArgs(['onFoo', '--all', '--json', '--strict'], NOW)).toMatchObject({ ok: true });
    expect(parseEventWaitArgs(['onFoo', '--any', '-h'], NOW)).toMatchObject({ ok: true });
  });
});
