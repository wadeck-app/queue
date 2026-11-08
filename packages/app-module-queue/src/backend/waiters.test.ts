import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWaiterHistory, waitersDir } from '@wadeck-app/queue-core';
import { WAITER_STALE_AFTER_MS as STALE_AFTER_MS } from '@wadeck-app/queue-core';
import { getWaiters } from './waiters.js';
import { registerFixtureWait, snapshotTree } from './waitersFixture.testUtil.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const NOW = Date.parse('2026-11-08T10:00:00.000Z');
const SECOND = 1000;

let configDir: string;
beforeEach(() => {
  configDir = makeTempDir('app-module-waiters-');
});
afterEach(() => {
  removeTempDir(configDir);
});

const get = (overrides: { now?: number; isAlive?: (pid: number) => boolean } = {}) =>
  getWaiters(configDir, { now: () => overrides.now ?? NOW, isAlive: overrides.isAlive ?? (() => true) });

/** Rewrites one field of a waiter file (a record another process could have written) and keeps its heartbeat time. */
function editFile(name: string, edit: (record: Record<string, unknown>) => void): void {
  const path = join(waitersDir(configDir), `waiter-${name}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(record);
  writeFileSync(path, JSON.stringify(record) + '\n');
  utimesSync(path, new Date(NOW), new Date(NOW));
}

describe('getWaiters: the waits running now, read from the waiter files (no daemon)', () => {
  it('nobody waits and the folder does not exist: an empty answer with zero counts, not an error', () => {
    expect(get()).toEqual({ waiters: [], count: 0, staleCount: 0, anonymousCount: 0 });
  });

  it('lists a live wait with what the page shows: name, events, filters as written, label, contact, since, last heartbeat', () => {
    registerFixtureWait(configDir, { name: 'agent.ci', at: NOW - 5 * SECOND, events: ['on.github.workflow_run', 'onFoo'], whens: ['payload.sha=abc', 'payload.ok=true'], label: 'abc1234', cwd: '/work/app' });
    const answer = get();
    expect(answer.count).toBe(1);
    expect(answer.waiters[0]).toEqual({
      name: 'agent.ci',
      anonymous: false,
      anonymousText: '',
      events: ['on.github.workflow_run', 'onFoo'],
      eventsText: 'on.github.workflow_run, onFoo',
      whens: ['payload.sha=abc', 'payload.ok=true'],
      whensText: 'payload.sha=abc and payload.ok=true',
      label: 'abc1234',
      contact: 'none',
      contactText: 'polling only',
      pid: 4242,
      cwd: '/work/app',
      since: new Date(NOW - 5 * SECOND).toISOString(),
      lastSeen: new Date(NOW - 5 * SECOND).toISOString(),
      stale: false,
      staleText: '',
    });
  });

  it('never carries the id of the registration (a nonce nobody needs) nor the secret of anything', () => {
    registerFixtureWait(configDir, { name: 'agent.ci', at: NOW, id: 'nonce-that-must-not-leak' });
    expect(JSON.stringify(get())).not.toContain('nonce-that-must-not-leak');
  });

  it('sorts by name', () => {
    registerFixtureWait(configDir, { name: 'b.two', at: NOW });
    registerFixtureWait(configDir, { name: 'a.one', at: NOW });
    expect(get().waiters.map((waiter) => waiter.name)).toEqual(['a.one', 'b.two']);
  });

  it('a wait without --name (anon.<pid>) is flagged anonymous and counted', () => {
    registerFixtureWait(configDir, { name: 'anon.777', at: NOW });
    registerFixtureWait(configDir, { name: 'agent.ci', at: NOW });
    const answer = get();
    expect(answer.anonymousCount).toBe(1);
    expect(answer.waiters.map((waiter) => [waiter.name, waiter.anonymous, waiter.anonymousText])).toEqual([['agent.ci', false, ''], ['anon.777', true, 'anonymous']]);
  });

  it('a heartbeat later than two periods is flagged stale and still listed; the limit is exactly STALE_AFTER_MS', () => {
    expect(STALE_AFTER_MS).toBe(30_000);
    registerFixtureWait(configDir, { name: 'edge.ok', at: NOW - STALE_AFTER_MS });
    registerFixtureWait(configDir, { name: 'edge.late', at: NOW - STALE_AFTER_MS - 1 });
    const answer = get();
    expect(answer.waiters.map((waiter) => [waiter.name, waiter.stale, waiter.staleText])).toEqual([['edge.late', true, 'stale'], ['edge.ok', false, '']]);
    expect(answer.staleCount).toBe(1);
    expect(answer.count).toBe(2);
  });

  it('shows the contact: pipe for a wait the daemon wakes, polling only for one it cannot, and never the path', () => {
    registerFixtureWait(configDir, { name: 'a.piped', at: NOW, contact: { kind: 'pipe', path: '/c/waiters/wake-0123456789abcdef.sock' } });
    registerFixtureWait(configDir, { name: 'b.polled', at: NOW });
    const answer = get();
    expect(answer.waiters.map((waiter) => [waiter.name, waiter.contact, waiter.contactText])).toEqual([['a.piped', 'pipe', 'pipe'], ['b.polled', 'none', 'polling only']]);
    expect(JSON.stringify(answer)).not.toContain('wake-0123456789abcdef');
  });

  it('a wait silent for more than the TTL is not listed, shows as lost in the history, and the GET writes nothing (the CLI and the daemon sweep, this route only reads)', () => {
    registerFixtureWait(configDir, { name: 'gone.silent', at: NOW - 61 * SECOND });
    const before = snapshotTree(configDir);
    const answer = get();
    expect(answer.waiters).toEqual([]);
    expect(answer).not.toHaveProperty('sweptText');
    expect(readWaiterHistory(configDir, { now: () => NOW, isAlive: () => true }).rows[0]).toMatchObject({ name: 'gone.silent', outcome: 'lost' });
    expect(snapshotTree(configDir)).toEqual(before);
  });

  it('a wait whose process is gone is not listed either, and a second GET gives the same answer without writing', () => {
    registerFixtureWait(configDir, { name: 'dead.proc', at: NOW, pid: 9999 });
    registerFixtureWait(configDir, { name: 'live.proc', at: NOW, pid: 1 });
    const before = snapshotTree(configDir);
    const isAlive = (pid: number): boolean => pid === 1;
    const first = get({ isAlive });
    expect(first.waiters.map((waiter) => waiter.name)).toEqual(['live.proc']);
    expect(get({ isAlive })).toEqual(first);
    expect(snapshotTree(configDir)).toEqual(before);
  });

  it('strips control characters from every string a file can carry (terminal escapes, line breaks)', () => {
    registerFixtureWait(configDir, { name: 'a.one', at: NOW });
    editFile('a.one', (record) => {
      record['label'] = 'ab\u001b[31mc\u0007d\ne';
      record['cwd'] = '/w\u0000ork\u007f';
      record['whens'] = ['payload.a=\u001b1'];
      record['events'] = ['on\u001bFoo'];
    });
    const [waiter] = get().waiters;
    expect(waiter).toMatchObject({ label: 'ab[31mcde', cwd: '/work', whens: ['payload.a=1'], whensText: 'payload.a=1', events: ['onFoo'], eventsText: 'onFoo' });
    // eslint-disable-next-line no-control-regex
    expect(JSON.stringify(get())).not.toMatch(/\\u00(0|1)[0-9a-f]|\\u007f|\\n/);
  });

  it('shows the filters and the working directory as written (no payload is stored, nothing to mask)', () => {
    registerFixtureWait(configDir, { name: 'a.one', at: NOW, whens: ['payload.token=hunter2'], cwd: 'C:\\Users\\me\\app' });
    expect(get().waiters[0]).toMatchObject({ whens: ['payload.token=hunter2'], cwd: 'C:\\Users\\me\\app' });
  });

  it('a record that cannot be used is reported with its path and the others are still listed (never a silent shorter list)', () => {
    registerFixtureWait(configDir, { name: 'good.one', at: NOW });
    mkdirSync(waitersDir(configDir), { recursive: true });
    const bad = join(waitersDir(configDir), 'waiter-bad.one.json');
    writeFileSync(bad, '{not json');
    utimesSync(bad, new Date(NOW), new Date(NOW));
    const answer = get();
    expect(answer.waiters.map((waiter) => waiter.name)).toEqual(['good.one']);
    expect(answer.warningText).toContain(bad);
    expect(answer.warningText).toContain('not valid JSON');
  });

  it('says a path once when the sweep and the scan both complain about the same file', () => {
    mkdirSync(waitersDir(configDir), { recursive: true });
    const bad = join(waitersDir(configDir), 'waiter-bad.one.json');
    writeFileSync(bad, '{not json');
    utimesSync(bad, new Date(NOW), new Date(NOW));
    const text = get().warningText!;
    expect(text.split(bad).length - 1).toBe(1);
  });

  it('a folder that cannot be read is an error that names the folder and what to do, not an empty list', () => {
    mkdirSync(waitersDir(configDir), { recursive: true });
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(() => getWaiters(configDir, { now: () => NOW, isAlive: () => true, fs: { readdir: () => { throw denied; } } })).toThrow(/EACCES[\s\S]*Fix:/);
  });
});
