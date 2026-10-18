import { describe, it, expect } from 'vitest';
import type { HistoryEntry } from '@wadeck-app/queue-core';
import { eventWaitCommand, findMatch, WAIT_EXIT, type EventWaitOptions, type EventWaitDeps } from './eventWaitCommand.js';

const T0 = Date.parse('2026-10-18T12:00:00.000Z');

function entry(overrides: Partial<HistoryEntry> & { payload?: unknown }, atMs: number): HistoryEntry {
  return { ts: new Date(atMs).toISOString(), eventId: `evt-${atMs}`, event: 'onStatusChange', subscribers: [], orphan: false, ...overrides };
}

interface Harness { deps: EventWaitDeps; out: string[]; err: string[]; readSinces: number[]; clock: { now: number } }

/** `visibleAt(callIndex)` returns the entries the history holds at that poll (0-based). */
function harness(visibleAt: (call: number) => HistoryEntry[]): Harness {
  const clock = { now: T0 };
  const out: string[] = [];
  const err: string[] = [];
  const readSinces: number[] = [];
  let call = 0;
  const deps: EventWaitDeps = {
    readEntries: (sinceMs) => { readSinces.push(sinceMs); return visibleAt(call++).filter((e) => Date.parse(e.ts) >= sinceMs); },
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    io: { stdout: { write: (s) => { out.push(s); } }, stderr: { write: (s) => { err.push(s); } } },
  };
  return { deps, out, err, readSinces, clock };
}

const base: EventWaitOptions = { event: 'onStatusChange', whens: [], sinceMs: T0, timeoutMs: 60_000, pollMs: 500, json: false };

describe('findMatch', () => {
  const payload = (taskId: string, newStatus: string) => ({ taskId, newStatus });

  it('returns the oldest entry that satisfies every --when (AND)', () => {
    const entries = [
      entry({ payload: payload('abc', 'in-progress') }, T0 + 2000),
      entry({ payload: payload('abc', 'done') }, T0 + 3000),
      entry({ payload: payload('abc', 'done') }, T0 + 4000),
    ];
    const match = findMatch(entries, ['payload.taskId=abc', 'payload.newStatus=done']);
    expect(match?.ts).toBe(new Date(T0 + 3000).toISOString());
  });

  it('does not match when one of the conditions fails', () => {
    expect(findMatch([entry({ payload: payload('abc', 'done') }, T0)], ['payload.taskId=abc', 'payload.newStatus=review'])).toBeNull();
  });

  it('without any --when, the first entry of the event matches', () => {
    expect(findMatch([entry({}, T0)], [])).not.toBeNull();
  });

  it('an entry with no recorded payload cannot satisfy a --when', () => {
    expect(findMatch([entry({}, T0)], ['payload.taskId=abc'])).toBeNull();
  });

  it('understands JSONPath filters ("$...") like the subscribers do', () => {
    const entries = [entry({ payload: payload('abc', 'done') }, T0)];
    expect(findMatch(entries, ['$.payload.newStatus'])).not.toBeNull();
    expect(findMatch(entries, ['$.payload.noSuchField'])).toBeNull();
  });
});

describe('eventWaitCommand', () => {
  it('answers at once when a matching event already happened since the given point', async () => {
    const h = harness(() => [entry({ payload: { taskId: 'abc' } }, T0 + 1000)]);
    const code = await eventWaitCommand({ ...base, whens: ['payload.taskId=abc'] }, h.deps);
    expect(code).toBe(WAIT_EXIT.MATCHED);
    expect(h.readSinces).toHaveLength(1);
    expect(h.clock.now).toBe(T0);
    expect(h.out.join('')).toContain('onStatusChange');
  });

  it('ignores events older than --since', async () => {
    const h = harness(() => [entry({ payload: { taskId: 'abc' } }, T0 - 5000)]);
    const code = await eventWaitCommand({ ...base, whens: ['payload.taskId=abc'], timeoutMs: 2000 }, h.deps);
    expect(code).toBe(WAIT_EXIT.TIMEOUT);
  });

  it('keeps polling until the event shows up, then matches', async () => {
    const arrival = entry({ payload: { taskId: 'abc', newStatus: 'done' } }, T0 + 1200);
    const h = harness((call) => (call >= 3 ? [arrival] : []));
    const code = await eventWaitCommand({ ...base, whens: ['payload.newStatus=done'] }, h.deps);
    expect(code).toBe(WAIT_EXIT.MATCHED);
    expect(h.readSinces.length).toBeGreaterThanOrEqual(4);
  });

  it('times out with its own exit code and names what it was waiting for', async () => {
    const h = harness(() => []);
    const code = await eventWaitCommand({ ...base, whens: ['payload.taskId=abc'], timeoutMs: 3000 }, h.deps);
    expect(code).toBe(WAIT_EXIT.TIMEOUT);
    expect(h.err.join('')).toContain('onStatusChange');
    expect(h.err.join('')).toContain('payload.taskId=abc');
    expect(h.clock.now - T0).toBeGreaterThanOrEqual(3000);
  });

  it('--json prints the matched entry on stdout', async () => {
    const h = harness(() => [entry({ payload: { taskId: 'abc' } }, T0 + 10)]);
    await eventWaitCommand({ ...base, json: true }, h.deps);
    const parsed = JSON.parse(h.out.join('')) as { matched: boolean; entry: HistoryEntry };
    expect(parsed.matched).toBe(true);
    expect(parsed.entry.payload).toEqual({ taskId: 'abc' });
  });

  it('--json also reports a timeout in a machine-readable way', async () => {
    const h = harness(() => []);
    const code = await eventWaitCommand({ ...base, json: true, timeoutMs: 1000 }, h.deps);
    expect(code).toBe(WAIT_EXIT.TIMEOUT);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ matched: false, timedOut: true, event: 'onStatusChange' });
  });

  it('the human output carries the payload so an agent woken by the event can read it', async () => {
    const h = harness(() => [entry({ payload: { taskId: 'abc', newStatus: 'done' } }, T0 + 10)]);
    await eventWaitCommand(base, h.deps);
    expect(h.out.join('')).toContain('"newStatus":"done"');
  });
});
