import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WaiterHistoryLog, waiterHistoryDir, type WaiterEndRecord } from './WaiterHistory.js';
import { readWaiterHistory, type ReadWaiterHistoryOptions } from './WaiterHistoryReader.js';
import { WAITER_RECORD_VERSION, type WaiterRecord } from './WaiterRecord.js';
import { WaiterRegistry } from './WaiterRegistry.js';
import { defaultWaiterFs, type WaiterFs } from './WaiterLiveness.js';

const D1 = Date.parse('2026-11-06T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let configDir: string;
let clock: { ms: number };
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'waiter-reader-'));
  clock = { ms: D1 };
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const journal = (): WaiterHistoryLog => new WaiterHistoryLog(waiterHistoryDir(configDir), { now: () => new Date(clock.ms), onRetention: () => undefined });

function record(id: string, name: string, startedMs: number, overrides: Partial<WaiterRecord> = {}): WaiterRecord {
  return { v: WAITER_RECORD_VERSION, id, name, events: ['onX'], whens: ['payload.a=1'], label: 'L', contact: { kind: 'none' }, pid: 50, cwd: '/p', since: new Date(startedMs - 1000).toISOString(), startedAt: new Date(startedMs).toISOString(), ...overrides };
}

function end(id: string, name: string, startedMs: number, endedMs: number, outcome: WaiterEndRecord['outcome'], extra: Partial<WaiterEndRecord> = {}): WaiterEndRecord {
  return { kind: 'end', id, name, endedAt: new Date(endedMs).toISOString(), durationMs: endedMs - startedMs, outcome, ...extra };
}

/** Writes a start at `startedMs` and an end at `endedMs`, each in the file of the day it happened. */
function wait(id: string, name: string, startedMs: number, endedMs: number | null, outcome: WaiterEndRecord['outcome'] = 'matched', extra: Partial<WaiterEndRecord> = {}): void {
  clock.ms = startedMs;
  journal().recordStart(record(id, name, startedMs));
  if (endedMs !== null) {
    clock.ms = endedMs;
    journal().recordEnd(end(id, name, startedMs, endedMs, outcome, extra));
  }
}

const read = (options: Partial<ReadWaiterHistoryOptions> = {}) => readWaiterHistory(configDir, { now: () => D1 + 5 * DAY, isAlive: () => true, ...options });

describe('readWaiterHistory', () => {
  it('pairs a start with its end: who, from when to when, how it ended', () => {
    wait('i1', 'a.one', D1, D1 + 60_000, 'matched', { eventId: 'evt-1', event: 'onX' });
    const { rows } = read();
    expect(rows).toEqual([
      {
        id: 'i1', name: 'a.one', events: ['onX'], whens: ['payload.a=1'], label: 'L', contact: { kind: 'none' }, pid: 50, cwd: '/p',
        since: new Date(D1 - 1000).toISOString(), startedAt: new Date(D1).toISOString(), endedAt: new Date(D1 + 60_000).toISOString(), durationMs: 60_000, outcome: 'matched', eventId: 'evt-1', event: 'onX',
      },
    ]);
  });

  it('newest first', () => {
    wait('i1', 'a.one', D1, D1 + 1000);
    wait('i2', 'b.two', D1 + 2000, D1 + 3000);
    wait('i3', 'c.three', D1 + 1000, D1 + 1500);
    expect(read().rows.map((row) => row.name)).toEqual(['b.two', 'c.three', 'a.one']);
  });

  it('an end in a later day file than its start is paired', () => {
    wait('i1', 'a.one', D1 + 23 * 60 * 60 * 1000, D1 + DAY + 2 * 60 * 60 * 1000, 'timeout');
    const { rows } = read();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'timeout', durationMs: 3 * 60 * 60 * 1000 });
  });

  it('a start with no end whose file is live is waiting', () => {
    const registry = new WaiterRegistry(configDir, { pid: 50, now: () => D1, isAlive: () => true, newId: () => 'live-1', onRetention: () => undefined });
    registry.register({ name: 'live.one', events: ['onX'], whens: [], label: '', since: new Date(D1).toISOString(), cwd: '/p' });
    const { rows } = read({ now: () => D1 + 1000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'live-1', outcome: 'waiting' });
    expect(rows[0]!.endedAt).toBeUndefined();
    expect(rows[0]!.durationMs).toBeUndefined();
  });

  it('a wait that started before `since` and is still waiting is in the window', () => {
    const registry = new WaiterRegistry(configDir, { pid: 50, now: () => D1, isAlive: () => true, newId: () => 'live-1', onRetention: () => undefined });
    registry.register({ name: 'live.one', events: ['onX'], whens: [], label: '', since: new Date(D1).toISOString(), cwd: '/p' });
    expect(read({ now: () => D1 + 1000, since: D1 + 500 }).rows.map((row) => row.id)).toEqual(['live-1']);
  });

  it('a start with no end and no live file is lost, even if no sweep wrote it yet', () => {
    wait('i1', 'dead.one', D1, null);
    const { rows } = read();
    expect(rows[0]).toMatchObject({ id: 'i1', outcome: 'lost' });
    expect(rows[0]!.endedAt).toBeUndefined();
  });

  it('a start with no end whose process is gone is lost even if the file is still there', () => {
    const registry = new WaiterRegistry(configDir, { pid: 50, now: () => D1, isAlive: () => true, newId: () => 'live-1', onRetention: () => undefined });
    registry.register({ name: 'live.one', events: ['onX'], whens: [], label: '', since: new Date(D1).toISOString(), cwd: '/p' });
    expect(read({ now: () => D1 + 1000, isAlive: () => false }).rows[0]).toMatchObject({ outcome: 'lost' });
  });

  it('an end whose start was pruned is not shown', () => {
    clock.ms = D1;
    journal().recordEnd(end('orphan', 'x.y', D1 - 1000, D1, 'matched'));
    expect(read().rows).toEqual([]);
  });

  describe('filters', () => {
    beforeEach(() => {
      wait('i1', 'w-agent-wake.aaa', D1, D1 + 1000, 'matched');
      wait('i2', 'w-agent-wake.bbb', D1 + DAY, D1 + DAY + 1000, 'timeout');
      wait('i3', 'poll-event.ccc', D1 + 2 * DAY, D1 + 2 * DAY + 1000, 'cancelled');
      wait('i4', 'poll-event.ddd', D1 + 3 * DAY, D1 + 3 * DAY + 1000, 'matched');
    });

    it('by name, with * as the wildcard', () => {
      expect(read({ name: 'w-agent-wake.*' }).rows.map((row) => row.id)).toEqual(['i2', 'i1']);
      expect(read({ name: '*.ccc' }).rows.map((row) => row.id)).toEqual(['i3']);
      expect(read({ name: 'poll-event.ccc' }).rows.map((row) => row.id)).toEqual(['i3']);
    });

    it('the wildcard is the only special character in a name filter', () => {
      expect(read({ name: 'poll-event.c(c' }).rows).toEqual([]);
      expect(read({ name: 'poll-event.c.c' }).rows).toEqual([]);
      expect(read({ name: 'poll-event+ccc' }).rows).toEqual([]);
    });

    it('by outcome', () => {
      expect(read({ outcome: 'matched' }).rows.map((row) => row.id)).toEqual(['i4', 'i1']);
      expect(read({ outcome: 'timeout' }).rows.map((row) => row.id)).toEqual(['i2']);
    });

    it('since keeps the waits that ended at or after it, and the ones still waiting', () => {
      expect(read({ since: D1 + 2 * DAY }).rows.map((row) => row.id)).toEqual(['i4', 'i3']);
      expect(read({ since: D1 + 2 * DAY + 1000 }).rows.map((row) => row.id)).toEqual(['i4', 'i3']);
      expect(read({ since: D1 + 2 * DAY + 1001 }).rows.map((row) => row.id)).toEqual(['i4']);
    });

    it('limit keeps the newest', () => {
      expect(read({ limit: 2 }).rows.map((row) => row.id)).toEqual(['i4', 'i3']);
    });

    it('limit defaults to 100', () => {
      for (let i = 0; i < 105; i++) {
        wait(`m${i}`, `many.w${i}`, D1 + 4 * DAY + i * 1000, D1 + 4 * DAY + i * 1000 + 10);
      }
      expect(read().rows).toHaveLength(100);
    });

    it('does not read the day files older than since, except to find the start of a wait that ended after it', () => {
      const reads: string[] = [];
      const fs: WaiterFs = { ...defaultWaiterFs, readFile: (path) => { reads.push(path); return readFileSync(path, 'utf8'); } };
      read({ since: D1 + 3 * DAY, fs });
      expect(reads.map((path) => path.slice(-17))).toEqual(['2026-11-09.ndjson']);
    });
  });

  it('reads further back for the start of a wait that ended inside the window', () => {
    wait('long', 'long.one', D1, D1 + 3 * DAY, 'timeout');
    const { rows } = read({ since: D1 + 3 * DAY - 1000 });
    expect(rows.map((row) => row.id)).toEqual(['long']);
  });

  describe('tolerance', () => {
    it('skips a torn line and a line that is not a record, and counts them', () => {
      wait('i1', 'a.one', D1, D1 + 1000);
      const file = join(waiterHistoryDir(configDir), '2026-11-06.ndjson');
      writeFileSync(file, readFileSync(file, 'utf8') + '{"kind":"start","id":"cut\n[1,2]\n{"kind":"start"}\n');
      const result = read();
      expect(result.rows.map((row) => row.id)).toEqual(['i1']);
      expect(result.skippedLines).toBe(3);
    });

    it('a missing journal is an empty history', () => {
      expect(read()).toEqual({ rows: [], skippedLines: 0, problems: [] });
    });

    it('a day pruned between the listing and the read is skipped', () => {
      wait('i1', 'a.one', D1, D1 + 1000);
      wait('i2', 'b.two', D1 + DAY, D1 + DAY + 1000);
      const fs: WaiterFs = { ...defaultWaiterFs, readFile: (path) => { if (path.endsWith('2026-11-06.ndjson')) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return readFileSync(path, 'utf8'); } };
      const result = read({ fs });
      expect(result.rows.map((row) => row.id)).toEqual(['i2']);
      expect(result.problems).toEqual([]);
    });

    it('a day file that cannot be read is a problem naming it, not an exception', () => {
      wait('i1', 'a.one', D1, D1 + 1000);
      const fs: WaiterFs = { ...defaultWaiterFs, readFile: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
      const result = read({ fs });
      expect(result.rows).toEqual([]);
      expect(result.problems[0]).toContain('2026-11-06.ndjson');
      expect(result.problems[0]).toContain('EACCES');
    });

    it('files that are not day files are ignored', () => {
      wait('i1', 'a.one', D1, D1 + 1000);
      mkdirSync(waiterHistoryDir(configDir), { recursive: true });
      writeFileSync(join(waiterHistoryDir(configDir), 'notes.txt'), 'x');
      writeFileSync(join(waiterHistoryDir(configDir), '2026-13-99.ndjson'), '{"kind":"start"}');
      expect(read().rows.map((row) => row.id)).toEqual(['i1']);
    });
  });
});
