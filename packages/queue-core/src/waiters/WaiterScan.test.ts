import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toEnvelope } from './WaiterMatch.js';
import { WaiterScanCache, listLiveWaiters, MAX_WAITER_FILES, WAITER_SCAN_TIME_BOX_MS, type WaiterScanOptions } from './WaiterScan.js';
import { WAITER_RECORD_VERSION, WAITER_LIMITS, type WaiterRecord } from './WaiterRecord.js';
import { WAITER_TTL_MS, defaultWaiterFs, type WaiterFs } from './WaiterLiveness.js';
import { waitersDir } from './WaiterHistory.js';

const T0 = Date.parse('2026-11-08T10:00:00.000Z');

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'waiter-scan-'));
  mkdirSync(waitersDir(configDir), { recursive: true });
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function waiter(name: string, overrides: Partial<WaiterRecord> = {}): WaiterRecord {
  return { v: WAITER_RECORD_VERSION, id: `id-${name}`, name, events: ['onX'], whens: [], label: '', contact: { kind: 'none' }, pid: 100, cwd: '/p', since: '2026-11-08T09:00:00.000Z', startedAt: '2026-11-08T09:59:00.000Z', ...overrides };
}

function put(record: WaiterRecord, mtimeMs = T0, text?: string): string {
  const path = join(waitersDir(configDir), `waiter-${record.name}.json`);
  writeFileSync(path, text ?? JSON.stringify(record));
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return path;
}

// A frozen monotonic clock by default: the 100 ms time box of the scan must never decide a test (a loaded machine reads 201 files slowly); the time box tests pass their own clock
const options = (extra: Partial<WaiterScanOptions> = {}): WaiterScanOptions => ({ now: () => T0, isAlive: () => true, clock: () => 0, ...extra });

describe('listLiveWaiters', () => {
  it('lists the live waiters with their last heartbeat', () => {
    put(waiter('b.two'), T0 - 5000);
    put(waiter('a.one'));
    const scan = listLiveWaiters(configDir, options());
    expect(scan.waiters.map((w) => w.name)).toEqual(['a.one', 'b.two']);
    expect(scan.waiters[1]).toMatchObject({ id: 'id-b.two', lastSeenMs: T0 - 5000, pid: 100 });
    expect(scan.problems).toEqual([]);
    expect(scan.partial).toBe(false);
  });

  it('a missing folder is an empty list', () => {
    rmSync(waitersDir(configDir), { recursive: true });
    expect(listLiveWaiters(configDir, options())).toEqual({ waiters: [], problems: [], partial: false });
  });

  it('a process that is gone is not listed', () => {
    put(waiter('a.one', { pid: 7 }));
    put(waiter('b.two', { pid: 8 }));
    expect(listLiveWaiters(configDir, options({ isAlive: (pid) => pid === 8 })).waiters.map((w) => w.name)).toEqual(['b.two']);
  });

  it('a heartbeat older than the TTL is not listed, and its file is not even read', () => {
    put(waiter('old.one'), T0 - WAITER_TTL_MS - 1);
    put(waiter('edge.one'), T0 - WAITER_TTL_MS);
    const reads: string[] = [];
    const fs: WaiterFs = { ...defaultWaiterFs, readFile: (path) => { reads.push(path); return readFileSync(path, 'utf8'); } };
    const scan = listLiveWaiters(configDir, options({ fs }));
    expect(scan.waiters.map((w) => w.name)).toEqual(['edge.one']);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('edge.one');
  });

  it('never deletes anything, not even the files it ignores', () => {
    const stale = put(waiter('old.one'), T0 - WAITER_TTL_MS * 10);
    const bad = put(waiter('bad.one'), T0, 'garbage');
    listLiveWaiters(configDir, options());
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(bad)).toBe(true);
  });

  it('ignores what is not a waiter file: the lock, the journal folder, a temp file', () => {
    put(waiter('a.one'));
    writeFileSync(join(waitersDir(configDir), 'waiters.lock'), '1');
    writeFileSync(join(waitersDir(configDir), 'waiter-a.one.json.tmp'), '{}');
    mkdirSync(join(waitersDir(configDir), 'history'));
    const scan = listLiveWaiters(configDir, options());
    expect(scan.waiters.map((w) => w.name)).toEqual(['a.one']);
    expect(scan.problems).toEqual([]);
  });

  describe('a file that cannot be used is ignored, never counted, and reported with its path', () => {
    it.each([
      ['not JSON', 'garbage', /waiter-bad\.one\.json.*not valid JSON/],
      ['a name that is not the file name', JSON.stringify(waiter('other.name')), /holds the name 'other\.name'/],
      ['an unknown version', JSON.stringify({ ...waiter('bad.one'), v: 2 }), /format version 2/],
      ['an invalid field', JSON.stringify({ ...waiter('bad.one'), pid: 'x' }), /invalid pid/],
    ])('%s', (_label, text, expected) => {
      put(waiter('bad.one'), T0, text);
      put(waiter('good.one'));
      const scan = listLiveWaiters(configDir, options());
      expect(scan.waiters.map((w) => w.name)).toEqual(['good.one']);
      expect(scan.problems).toHaveLength(1);
      expect(scan.problems[0]).toContain(join(waitersDir(configDir), 'waiter-bad.one.json'));
      expect(scan.problems[0]).toMatch(expected);
    });

    it('an oversize file is not read', () => {
      const path = put(waiter('big.one'), T0, ' '.repeat(WAITER_LIMITS.maxFileBytes + 1));
      const reads: string[] = [];
      const fs: WaiterFs = { ...defaultWaiterFs, readFile: (p) => { reads.push(p); return readFileSync(p, 'utf8'); } };
      const scan = listLiveWaiters(configDir, options({ fs }));
      expect(reads).toEqual([]);
      expect(scan.problems[0]).toContain(path);
      expect(scan.problems[0]).toContain('over');
    });
  });

  describe('matching an event', () => {
    it('keeps the waiters that count for the envelope (same rule as the wait: shared match code)', () => {
      put(waiter('any.one', { events: ['onX'] }));
      put(waiter('other.one', { events: ['onY'] }));
      put(waiter('filtered.yes', { events: ['onX'], whens: ['payload.a=1'] }));
      put(waiter('filtered.no', { events: ['onX'], whens: ['payload.a=2'] }));
      put(waiter('pattern.one', { events: ['on.*'] }));
      const envelope = toEnvelope({ eventId: 'e', ts: new Date(T0).toISOString(), event: 'onX', payload: { a: 1 } });
      expect(listLiveWaiters(configDir, options({ matching: envelope })).waiters.map((w) => w.name)).toEqual(['any.one', 'filtered.yes']);
      const dotted = toEnvelope({ eventId: 'e', ts: new Date(T0).toISOString(), event: 'on.thing', payload: { a: 1 } });
      expect(listLiveWaiters(configDir, options({ matching: dotted })).waiters.map((w) => w.name)).toEqual(['pattern.one']);
    });

    it('a dead waiter is not counted even if it matches', () => {
      put(waiter('dead.one', { pid: 5 }));
      const envelope = toEnvelope({ eventId: 'e', ts: new Date(T0).toISOString(), event: 'onX', payload: {} });
      expect(listLiveWaiters(configDir, options({ matching: envelope, isAlive: () => false })).waiters).toEqual([]);
    });
  });

  describe('the cache', () => {
    function counting(): { fs: WaiterFs; reads: () => number } {
      let reads = 0;
      return { fs: { ...defaultWaiterFs, readFile: (path) => { reads++; return readFileSync(path, 'utf8'); } }, reads: () => reads };
    }

    it('parses an unchanged file once, however many scans', () => {
      put(waiter('a.one'));
      const { fs, reads } = counting();
      const cache = new WaiterScanCache();
      for (let i = 0; i < 5; i++) {
        listLiveWaiters(configDir, options({ fs, cache }));
      }
      expect(reads()).toBe(1);
    });

    it('a heartbeat does not invalidate the cache but is seen (the liveness uses the fresh modification time)', () => {
      const path = put(waiter('a.one'));
      const { fs, reads } = counting();
      const cache = new WaiterScanCache();
      listLiveWaiters(configDir, options({ fs, cache }));
      utimesSync(path, new Date(T0 + 1000), new Date(T0 + 1000));
      const scan = listLiveWaiters(configDir, options({ fs, cache, now: () => T0 + 1000 }));
      expect(reads()).toBe(1);
      expect(scan.waiters[0]!.lastSeenMs).toBe(T0 + 1000);
    });

    it('a replaced file (another size or identity) is read again', () => {
      const path = put(waiter('a.one', { label: 'first' }));
      const { fs, reads } = counting();
      const cache = new WaiterScanCache();
      listLiveWaiters(configDir, options({ fs, cache }));
      rmSync(path);
      put(waiter('a.one', { label: 'second one, longer' }));
      const scan = listLiveWaiters(configDir, options({ fs, cache }));
      expect(reads()).toBe(2);
      expect(scan.waiters[0]!.label).toBe('second one, longer');
    });

    // The three things that tell one version of a file from another, each changed alone through the stat seam (a real file system may reuse an inode)
    it.each([
      ['inode', { ino: 999 }],
      ['creation time', { birthtimeMs: 12345 }],
      ['size', { size: 5 }],
    ])('a file whose %s changed alone is read again', (_what, change) => {
      put(waiter('a.one'));
      const { fs: counted, reads } = counting();
      const cache = new WaiterScanCache();
      const state: { change: Record<string, number> } = { change: {} };
      const fs: WaiterFs = { ...counted, stat: (path) => ({ ...defaultWaiterFs.stat(path), ...state.change }) };
      listLiveWaiters(configDir, options({ fs, cache }));
      listLiveWaiters(configDir, options({ fs, cache }));
      expect(reads()).toBe(1);
      state.change = change;
      listLiveWaiters(configDir, options({ fs, cache }));
      expect(reads()).toBe(2);
    });

    it('a file rewritten in place with other content is read again', () => {
      const path = put(waiter('a.one', { label: 'first' }));
      const { fs, reads } = counting();
      const cache = new WaiterScanCache();
      listLiveWaiters(configDir, options({ fs, cache }));
      writeFileSync(path, JSON.stringify(waiter('a.one', { label: 'second one, longer' })));
      utimesSync(path, new Date(T0), new Date(T0));
      expect(listLiveWaiters(configDir, options({ fs, cache })).waiters[0]!.label).toBe('second one, longer');
      expect(reads()).toBe(2);
    });

    it('forgets the files that are gone', () => {
      const path = put(waiter('a.one'));
      const cache = new WaiterScanCache();
      listLiveWaiters(configDir, options({ cache }));
      expect(cache.size).toBe(1);
      rmSync(path);
      listLiveWaiters(configDir, options({ cache }));
      expect(cache.size).toBe(0);
    });

    it('a file that was unusable is not read again until it changes, and is reported every time', () => {
      put(waiter('bad.one'), T0, 'garbage');
      const { fs, reads } = counting();
      const cache = new WaiterScanCache();
      const first = listLiveWaiters(configDir, options({ fs, cache }));
      const second = listLiveWaiters(configDir, options({ fs, cache }));
      expect(reads()).toBe(1);
      expect(first.problems).toEqual(second.problems);
      expect(second.problems).toHaveLength(1);
    });
  });

  describe('bounds', () => {
    it('looks at 200 files at most and says how many there were', () => {
      for (let i = 0; i < MAX_WAITER_FILES + 1; i++) {
        put(waiter(`w.${String(i).padStart(3, '0')}`));
      }
      const scan = listLiveWaiters(configDir, options());
      expect(scan.waiters).toHaveLength(MAX_WAITER_FILES);
      expect(scan.partial).toBe(true);
      expect(scan.problems).toHaveLength(1);
      expect(scan.problems[0]).toContain('201');
      expect(scan.problems[0]).toContain(String(MAX_WAITER_FILES));
      expect(scan.problems[0]).toContain(waitersDir(configDir));
    });

    it('exactly 200 files is complete', () => {
      for (let i = 0; i < MAX_WAITER_FILES; i++) {
        put(waiter(`w.${String(i).padStart(3, '0')}`));
      }
      const scan = listLiveWaiters(configDir, options());
      expect(scan.waiters).toHaveLength(MAX_WAITER_FILES);
      expect(scan.partial).toBe(false);
      expect(scan.problems).toEqual([]);
    });

    it('stops at the time box with what it has, and says it (a partial count, never a failed push)', () => {
      for (let i = 0; i < 10; i++) {
        put(waiter(`w.${i}`));
      }
      // each reading of the clock costs 60 ms: the 100 ms box is over after the second file
      let ticks = 0;
      const scan = listLiveWaiters(configDir, options({ clock: () => ticks++ * (WAITER_SCAN_TIME_BOX_MS * 0.6) }));
      expect(scan.partial).toBe(true);
      expect(scan.waiters.length).toBeGreaterThan(0);
      expect(scan.waiters.length).toBeLessThan(10);
      expect(scan.problems.join(' ')).toContain(`${WAITER_SCAN_TIME_BOX_MS} ms`);
      expect(scan.problems.join(' ')).toContain(String(scan.waiters.length));
    });

    it('a box that is not exceeded is complete', () => {
      put(waiter('a.one'));
      const scan = listLiveWaiters(configDir, options({ clock: () => 0 }));
      expect(scan.partial).toBe(false);
    });
  });

  it('a file that vanishes between the listing and the stat is skipped', () => {
    put(waiter('a.one'));
    put(waiter('b.two'));
    const fs: WaiterFs = { ...defaultWaiterFs, stat: (path) => { if (path.includes('a.one')) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return defaultWaiterFs.stat(path); } };
    const scan = listLiveWaiters(configDir, options({ fs }));
    expect(scan.waiters.map((w) => w.name)).toEqual(['b.two']);
    expect(scan.problems).toEqual([]);
  });

  it('a stat or read error other than "gone" is a problem naming the file, not an exception', () => {
    put(waiter('a.one'));
    const fs: WaiterFs = { ...defaultWaiterFs, readFile: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
    const scan = listLiveWaiters(configDir, options({ fs }));
    expect(scan.waiters).toEqual([]);
    expect(scan.problems[0]).toContain('waiter-a.one.json');
    expect(scan.problems[0]).toContain('EACCES');
  });

  it('a folder that cannot be listed is a problem, not an exception', () => {
    const fs: WaiterFs = { ...defaultWaiterFs, readdir: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
    const scan = listLiveWaiters(configDir, options({ fs }));
    expect(scan.waiters).toEqual([]);
    expect(scan.problems[0]).toContain(waitersDir(configDir));
    expect(scan.problems[0]).toContain('EACCES');
    expect(readdirSync(waitersDir(configDir))).toEqual([]);
  });

  it('a folder that cannot be listed is flagged `unreadable` (a caller that must not show an empty list for it throws); a missing folder and a readable one are not', () => {
    const fs: WaiterFs = { ...defaultWaiterFs, readdir: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
    expect(listLiveWaiters(configDir, options({ fs })).unreadable).toEqual(expect.stringContaining('EACCES'));
    expect(listLiveWaiters(configDir, options()).unreadable).toBeUndefined();
    rmSync(waitersDir(configDir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(listLiveWaiters(configDir, options()).unreadable).toBeUndefined();
  });
});
