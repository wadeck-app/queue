import { describe, it, expect } from 'vitest';
import type { HistoryEntry } from '../storage/HistoryReader.js';
import { findMatch, toEnvelope, waiterCountsFor, whensHold } from './WaiterMatch.js';

const T0 = Date.parse('2026-11-08T12:00:00.000Z');

function entry(overrides: Partial<HistoryEntry> = {}, atMs = T0): HistoryEntry {
  return { ts: new Date(atMs).toISOString(), eventId: `evt-${atMs}`, event: 'onTaskDone', subscribers: [], orphan: false, ...overrides };
}

describe('toEnvelope', () => {
  it('builds the envelope a wait matches its filters against: history fields, meta reduced to cwd and projectName', () => {
    expect(toEnvelope(entry({ payload: { a: 1 }, cwd: '/p', project: 'proj' }))).toEqual({
      id: `evt-${T0}`,
      timestamp: new Date(T0).toISOString(),
      event: 'onTaskDone',
      payload: { a: 1 },
      meta: { cwd: '/p', projectName: 'proj' },
    });
  });

  it('an entry without cwd or project gives empty strings, as the wait always did', () => {
    expect(toEnvelope(entry()).meta).toEqual({ cwd: '', projectName: '' });
  });
});

describe('findMatch (the rule of `queue wait`, shared with the daemon)', () => {
  it('returns the oldest entry that satisfies every filter', () => {
    const entries = [entry({ payload: { s: 'x' } }, T0 + 3000), entry({ payload: { s: 'done' } }, T0 + 2000), entry({ payload: { s: 'done' } }, T0 + 4000)];
    expect(findMatch(entries, ['payload.s=done'])?.ts).toBe(new Date(T0 + 2000).toISOString());
  });

  it('is null when a filter fails, and when there is no entry', () => {
    expect(findMatch([entry({ payload: { s: 'x' } })], ['payload.s=done'])).toBeNull();
    expect(findMatch([], [])).toBeNull();
  });
});

describe('whensHold', () => {
  const envelope = toEnvelope(entry({ payload: { s: 'done', n: 2 } }));

  it('holds without a filter, with all filters true; fails when one fails', () => {
    expect(whensHold([], envelope)).toBe(true);
    expect(whensHold(['payload.s=done', 'payload.n=2'], envelope)).toBe(true);
    expect(whensHold(['payload.s=done', 'payload.n=3'], envelope)).toBe(false);
  });
});

describe('waiterCountsFor (the counting rule of the daemon)', () => {
  const envelope = toEnvelope(entry({ payload: { s: 'done' } }));
  const waiter = (events: string[], whens: string[] = []) => ({ events, whens });

  it('a name equal to the event counts', () => {
    expect(waiterCountsFor(waiter(['onTaskDone']), envelope)).toBe(true);
  });

  it('a pattern counts when it matches the name', () => {
    expect(waiterCountsFor(waiter(['onTask.*']), toEnvelope(entry({ event: 'onTask.done' })))).toBe(true);
    expect(waiterCountsFor(waiter(['>']), envelope)).toBe(true);
  });

  it('any one of several events is enough', () => {
    expect(waiterCountsFor(waiter(['onOther', 'onTaskDone']), envelope)).toBe(true);
  });

  it('another event does not count', () => {
    expect(waiterCountsFor(waiter(['onOther']), envelope)).toBe(false);
  });

  it('every filter must hold', () => {
    expect(waiterCountsFor(waiter(['onTaskDone'], ['payload.s=done']), envelope)).toBe(true);
    expect(waiterCountsFor(waiter(['onTaskDone'], ['payload.s=done', 'payload.s=other']), envelope)).toBe(false);
  });

  it('a filter that cannot be evaluated counts (a waiter is never hidden)', () => {
    // a JSONPath the evaluator rejects while walking the document
    expect(waiterCountsFor(waiter(['onTaskDone'], ['$[?(']), envelope)).toBe(true);
  });

  it('a filter that simply does not match does not count', () => {
    expect(waiterCountsFor(waiter(['onTaskDone'], ['payload.s=nope']), envelope)).toBe(false);
  });
});

describe('parity with the wait', () => {
  // The daemon decides "someone waits" and the wait decides "it happened" on the same entry: they must agree whenever the filter can be evaluated
  const payloads: unknown[] = [{ s: 'done', n: 2 }, { s: 'x' }, null, 'text', { nested: { deep: true } }, undefined];
  const filters = [[], ['payload.s=done'], ['payload.n=2'], ['payload.s=done', 'payload.n=2'], ['$.payload.nested.deep'], ['$.payload.nothing'], ['meta.cwd=/p'], ['meta.projectName=proj'], ['event=onTaskDone']];

  it.each(payloads.flatMap((payload) => filters.map((whens) => [JSON.stringify(payload) ?? 'undefined', whens.join(' & ') || '(none)', payload, whens] as const)))(
    'payload %s, filters %s',
    (_payload, _filters, payload, whens) => {
      const e = entry({ payload, cwd: '/p', project: 'proj' });
      const waits = findMatch([e], whens as string[]) !== null;
      expect(waiterCountsFor({ events: ['onTaskDone'], whens: whens as string[] }, toEnvelope(e))).toBe(waits);
    },
  );
});
