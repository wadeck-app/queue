import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { waitersDir, type WaitRowOutcome } from '@wadeck-app/queue-core';
import { listWaiterHistory } from './waiterHistory.js';
import { registerFixtureWait, registryAt, snapshotTree } from './waitersFixture.testUtil.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const T0 = Date.parse('2026-11-08T09:00:00.000Z');
const MINUTE = 60_000;
const NOW = T0 + 3 * 60 * MINUTE;

let configDir: string;
beforeEach(() => {
  configDir = makeTempDir('app-module-waiter-history-');
});
afterEach(() => {
  removeTempDir(configDir);
});

interface FlatQuery { name?: string; outcome?: WaitRowOutcome; sinceMs?: number; limit?: number; offset?: number; page?: number }

const list = (query: FlatQuery = {}, now = NOW) => {
  const { name, outcome, sinceMs, limit, offset, page } = query;
  const parsed = {
    filter: { ...(name !== undefined && { name }), ...(outcome !== undefined && { outcome }), ...(sinceMs !== undefined && { sinceMs }) },
    pagination: { ...(limit !== undefined && { limit }), ...(offset !== undefined && { offset }), ...(page !== undefined && { page }) },
  };
  return listWaiterHistory(configDir, parsed, { now: () => now, isAlive: () => true });
};

/** A wait that registered at `at` and ended `afterMs` later. */
function finished(name: string, at: number, afterMs: number, end: Parameters<ReturnType<typeof registryAt>['deregister']>[1], extra: { events?: string[]; label?: string; whens?: string[] } = {}): void {
  const { registration } = registerFixtureWait(configDir, { name, at, ...extra });
  registryAt(configDir, at + afterMs).deregister(registration, end);
}

describe('listWaiterHistory: who waited, from when to when, how it ended', () => {
  it('an empty answer when no wait was ever recorded: no entries, total 0, the default page', () => {
    expect(list()).toEqual({ entries: [], total: 0, limit: 20, offset: 0 });
  });

  it('a wait that matched: from, to, duration (number and text), outcome, and the event with its id', () => {
    finished('agent.ci', T0, 5 * MINUTE + 3000, { outcome: 'matched', eventId: 'evt-1', event: 'onFoo' }, { events: ['onFoo'], label: 'abc1234', whens: ['payload.a=1'] });
    const page = list();
    expect(page.total).toBe(1);
    expect(page.entries[0]).toEqual({
      name: 'agent.ci',
      anonymousText: '',
      events: ['onFoo'],
      eventsText: 'onFoo',
      whens: ['payload.a=1'],
      whensText: 'payload.a=1',
      label: 'abc1234',
      contact: 'none',
      pid: 4242,
      cwd: '/work/project',
      from: new Date(T0).toISOString(),
      to: new Date(T0 + 5 * MINUTE + 3000).toISOString(),
      durationMs: 5 * MINUTE + 3000,
      durationText: '5m 3s',
      outcome: 'matched',
      event: 'onFoo',
      eventId: 'evt-1',
    });
  });

  it('every ending is reported with its own outcome: matched, timeout, cancelled, refused, lost', () => {
    finished('a.matched', T0, MINUTE, { outcome: 'matched', eventId: 'e', event: 'onFoo' });
    finished('b.timeout', T0 + 1, MINUTE, { outcome: 'timeout' });
    finished('c.cancelled', T0 + 2, MINUTE, { outcome: 'cancelled' });
    registerFixtureWait(configDir, { name: 'd.refused', at: T0 + 3 });
    expect(() => registerFixtureWait(configDir, { name: 'd.refused', at: T0 + 4, id: 'second' })).toThrow();
    registerFixtureWait(configDir, { name: 'e.lost', at: T0 + 5 });
    unlinkSync(join(waitersDir(configDir), 'waiter-e.lost.json'));
    const byName = Object.fromEntries(list().entries.map((entry) => [entry.name, entry.outcome]));
    // d.refused appears twice: the live one (waiting) and the refused attempt
    expect(list({ outcome: 'refused' }).entries.map((entry) => entry.name)).toEqual(['d.refused']);
    expect(byName).toMatchObject({ 'a.matched': 'matched', 'b.timeout': 'timeout', 'c.cancelled': 'cancelled', 'e.lost': 'lost' });
  });

  it('a start without an end whose record is live is waiting: no end time, the duration so far', () => {
    registerFixtureWait(configDir, { name: 'live.one', at: NOW - 20_000 });
    const [entry] = list().entries;
    expect(entry).toMatchObject({ name: 'live.one', outcome: 'waiting', durationText: '20s' });
    expect(entry).not.toHaveProperty('to');
    expect(entry).not.toHaveProperty('durationMs');
  });

  it('a start without an end and without a record is lost, with no end time and a duration said to be unknown', () => {
    registerFixtureWait(configDir, { name: 'killed.one', at: T0 });
    unlinkSync(join(waitersDir(configDir), 'waiter-killed.one.json'));
    const [entry] = list().entries;
    expect(entry).toMatchObject({ name: 'killed.one', outcome: 'lost', durationText: 'unknown' });
    expect(entry).not.toHaveProperty('to');
  });

  it('a stale record is not swept by the GET: the wait is shown lost and ends at its last heartbeat, and nothing is written', () => {
    registerFixtureWait(configDir, { name: 'silent.one', at: T0 });
    const before = snapshotTree(configDir);
    const page = list();
    expect(page.entries[0]).toMatchObject({ name: 'silent.one', outcome: 'lost', to: new Date(T0).toISOString(), durationText: '0s' });
    expect(page).not.toHaveProperty('sweptText');
    expect(list()).toEqual(page);
    expect(snapshotTree(configDir)).toEqual(before);
  });

  it('a waiters folder that cannot be listed is an error that names it and what to do, never a history that calls every running wait lost', () => {
    registerFixtureWait(configDir, { name: 'run.one', at: T0 });
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const readdir = (dir: string): string[] => { if (dir.endsWith('waiters')) throw denied; return []; };
    expect(() => listWaiterHistory(configDir, { filter: {}, pagination: {} }, { now: () => NOW, isAlive: () => true, fs: { readdir } })).toThrow(/EACCES.*Fix:/);
  });

  it('newest first, and the event is absent (not empty) for a wait that did not match', () => {
    finished('old.one', T0, MINUTE, { outcome: 'timeout' });
    finished('new.one', T0 + 10 * MINUTE, MINUTE, { outcome: 'matched', eventId: 'e9', event: 'onBar' });
    const { entries } = list();
    expect(entries.map((entry) => entry.name)).toEqual(['new.one', 'old.one']);
    expect(entries[1]).not.toHaveProperty('event');
    expect(entries[1]).not.toHaveProperty('eventId');
  });

  it('marks a wait without --name as anonymous', () => {
    finished('anon.55', T0, MINUTE, { outcome: 'timeout' });
    expect(list().entries[0]).toMatchObject({ anonymousText: 'anonymous' });
  });

  it('filters by name with * as any characters', () => {
    finished('agent.one', T0, MINUTE, { outcome: 'timeout' });
    finished('agent.two', T0 + 1, MINUTE, { outcome: 'timeout' });
    finished('other.one', T0 + 2, MINUTE, { outcome: 'timeout' });
    expect(list({ name: 'agent.*' }).entries.map((entry) => entry.name).sort()).toEqual(['agent.one', 'agent.two']);
    expect(list({ name: 'agent.one' }).total).toBe(1);
    expect(list({ name: 'agent.*' }).total).toBe(2);
  });

  it('filters by outcome, including waiting', () => {
    finished('a.one', T0, MINUTE, { outcome: 'timeout' });
    finished('b.two', T0 + 1, MINUTE, { outcome: 'matched', eventId: 'e', event: 'onFoo' });
    registerFixtureWait(configDir, { name: 'c.three', at: NOW - 1000 });
    expect(list({ outcome: 'timeout' }).entries.map((entry) => entry.name)).toEqual(['a.one']);
    expect(list({ outcome: 'waiting' }).entries.map((entry) => entry.name)).toEqual(['c.three']);
  });

  it('sinceMs keeps the waits that ended at or after it, and the ones still waiting', () => {
    finished('old.one', T0, MINUTE, { outcome: 'timeout' });
    finished('new.one', T0 + 30 * MINUTE, MINUTE, { outcome: 'timeout' });
    registerFixtureWait(configDir, { name: 'live.one', at: NOW - 1000 });
    expect(list({ sinceMs: T0 + 20 * MINUTE }).entries.map((entry) => entry.name).sort()).toEqual(['live.one', 'new.one']);
  });

  describe('paging (the conventions of the History route)', () => {
    beforeEach(() => {
      for (let index = 0; index < 5; index++) {
        finished(`w.n${index}`, T0 + index * MINUTE, 1000, { outcome: 'timeout' });
      }
    });

    it('limit and offset slice the newest-first list and total counts every match', () => {
      const page = list({ limit: 2, offset: 1 });
      expect(page.entries.map((entry) => entry.name)).toEqual(['w.n3', 'w.n2']);
      expect(page).toMatchObject({ total: 5, limit: 2, offset: 1 });
    });

    it('page * limit is the offset, and the answer carries the offset (no page field)', () => {
      const page = list({ limit: 2, page: 2 });
      expect(page.entries.map((entry) => entry.name)).toEqual(['w.n0']);
      expect(page).toMatchObject({ total: 5, limit: 2, offset: 4 });
      expect(page).not.toHaveProperty('page');
    });

    it('the default page size is the one of the History route (20)', () => {
      expect(list().limit).toBe(20);
    });

    it('an offset past the end is an empty page with the real total, not an error', () => {
      expect(list({ offset: 50 })).toMatchObject({ entries: [], total: 5, offset: 50 });
    });

    it('the filter applies before the paging', () => {
      const page = list({ name: 'w.n*', outcome: 'timeout', limit: 3 });
      expect(page).toMatchObject({ total: 5, limit: 3 });
      expect(page.entries).toHaveLength(3);
    });
  });

  it('a torn line in a day file is skipped and said (warningText), the other waits are listed', () => {
    finished('a.one', T0, MINUTE, { outcome: 'timeout' });
    const day = new Date(T0).toISOString().slice(0, 10);
    appendFileSync(join(configDir, 'waiters', 'history', `${day}.ndjson`), '{"kind":"start","id":"torn');
    const page = list();
    expect(page.entries.map((entry) => entry.name)).toEqual(['a.one']);
    expect(page.warningText).toMatch(/1 line.*could not be read/);
  });

  it('strips control characters from the strings printed in the page', () => {
    finished('a.one', T0, MINUTE, { outcome: 'matched', eventId: 'e\u001b1', event: 'on\u0007Foo' }, { label: 'x\u001b[0my' });
    const [entry] = list().entries;
    expect(entry).toMatchObject({ label: 'x[0my', event: 'onFoo', eventId: 'e1' });
  });
});

