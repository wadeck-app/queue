import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WaiterHistoryLog, waiterHistoryDir, waitersDir, type WaiterEndRecord } from './WaiterHistory.js';
import { WaiterInputError, WaiterNameTakenError, WaiterRegistry, type WaiterRegistryDeps } from './WaiterRegistry.js';
import { parseWaiterRecord } from './WaiterRecord.js';
import { WAITER_TTL_MS } from './WaiterLiveness.js';

const T0 = Date.parse('2026-11-08T10:00:00.000Z');

let configDir: string;
let clock: { ms: number };
let alive: Set<number>;
let ids: number;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'waiter-registry-'));
  clock = { ms: T0 };
  alive = new Set([100, 200, 300]);
  ids = 0;
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A registry as seen from "process" `pid`; the clock, the pids that are alive and the ids are the test's. */
function registryFor(pid: number, extra: Partial<WaiterRegistryDeps> = {}): WaiterRegistry {
  return new WaiterRegistry(configDir, {
    pid,
    now: () => clock.ms,
    isAlive: (candidate) => alive.has(candidate),
    newId: () => `id-${++ids}`,
    sleep: (ms) => { clock.ms += ms; },
    onRetention: () => undefined,
    ...extra,
  });
}

const input = { name: 'w-agent-wake.ab12cd34', events: ['onTaskDone'], whens: ['payload.taskId=abc'], label: 'task abc', since: '2026-11-08T09:00:00.000Z', cwd: '/project' };
const fileOf = (name = input.name): string => join(waitersDir(configDir), `waiter-${name}.json`);

function historyLines(): Array<Record<string, unknown>> {
  const dir = waiterHistoryDir(configDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>));
}

function setMtime(path: string, ms: number): void {
  utimesSync(path, new Date(ms), new Date(ms));
}

describe('register', () => {
  it('creates waiter-<name>.json with the whole record', () => {
    const registration = registryFor(100).register(input);
    const parsed = parseWaiterRecord(readFileSync(fileOf(), 'utf8'), 'waiter-w-agent-wake.ab12cd34.json');
    expect(parsed).toEqual({
      ok: true,
      record: { v: 1, id: 'id-1', name: input.name, events: ['onTaskDone'], whens: ['payload.taskId=abc'], label: 'task abc', contact: { kind: 'none' }, pid: 100, cwd: '/project', since: input.since, startedAt: '2026-11-08T10:00:00.000Z' },
    });
    expect(registration).toMatchObject({ id: 'id-1', name: input.name, path: fileOf(), startedAt: '2026-11-08T10:00:00.000Z', pid: 100 });
    expect(registration.takeover).toBeUndefined();
  });

  it('writes the contact the wait gives (the pipe it listens on) into the file and the start record', () => {
    const contact = { kind: 'pipe' as const, path: '/c/waiters/wake-0123456789abcdef.sock' };
    registryFor(100).register({ ...input, contact });
    const parsed = parseWaiterRecord(readFileSync(fileOf(), 'utf8'), 'waiter-w-agent-wake.ab12cd34.json');
    expect(parsed.ok && parsed.record.contact).toEqual(contact);
    expect(historyLines()[0]).toMatchObject({ kind: 'start', contact });
  });

  it('writes the start record of the waits history, once', () => {
    registryFor(100).register(input);
    expect(historyLines()).toEqual([
      { kind: 'start', id: 'id-1', name: input.name, events: ['onTaskDone'], whens: ['payload.taskId=abc'], label: 'task abc', contact: { kind: 'none' }, pid: 100, cwd: '/project', since: input.since, startedAt: '2026-11-08T10:00:00.000Z' },
    ]);
  });

  it('leaves nothing but the record and the journal: no temp file, no lock', () => {
    registryFor(100).register(input);
    expect(readdirSync(waitersDir(configDir)).sort()).toEqual(['history', 'waiter-w-agent-wake.ab12cd34.json']);
  });

  it('refuses an invalid input with the reason, before touching a file', () => {
    expect(() => registryFor(100).register({ ...input, name: 'nodot' })).toThrow(WaiterInputError);
    expect(() => registryFor(100).register({ ...input, name: 'nodot' })).toThrow(/<who>\.<what>/);
    expect(existsSync(waitersDir(configDir))).toBe(false);
  });

  it('a name that is already used by a live wait is refused, naming the holder and what to do', () => {
    registryFor(100).register(input);
    clock.ms += 1000;
    let error: unknown;
    try {
      registryFor(200).register({ ...input, label: 'second' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WaiterNameTakenError);
    const taken = error as WaiterNameTakenError;
    expect(taken.holder).toMatchObject({ pid: 100, startedAt: '2026-11-08T10:00:00.000Z', label: 'task abc', events: ['onTaskDone'] });
    expect(taken.message).toContain("--name 'w-agent-wake.ab12cd34' is already used by a live wait (pid 100, since 2026-11-08T10:00:00.000Z, waiting for onTaskDone)");
    expect(taken.message).toContain('each concurrent wait needs its own name');
    expect(taken.message).toContain('stop pid 100');
    // the holder is untouched
    expect(JSON.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ id: 'id-1', pid: 100 });
  });

  it('a refused wait is in the history: a start and a refused end', () => {
    registryFor(100).register(input);
    clock.ms += 1000;
    expect(() => registryFor(200).register({ ...input, label: 'second' })).toThrow(WaiterNameTakenError);
    const lines = historyLines();
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ kind: 'start', id: 'id-2', label: 'second', pid: 200 });
    expect(lines[2]).toMatchObject({ kind: 'end', id: 'id-2', name: input.name, outcome: 'refused', durationMs: 0 });
  });

  it('a holder whose process is gone is taken over, and its wait is recorded as lost at its last heartbeat', () => {
    registryFor(100).register(input);
    setMtime(fileOf(), T0 + 20_000);
    alive.delete(100);
    clock.ms = T0 + 30_000;
    const registration = registryFor(200).register({ ...input, label: 'mine' });
    expect(registration.takeover).toMatchObject({ pid: 100, reason: 'process gone', startedAt: '2026-11-08T10:00:00.000Z' });
    expect(JSON.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ id: 'id-2', pid: 200, label: 'mine' });
    const lost = historyLines().find((line) => line['outcome'] === 'lost');
    expect(lost).toEqual({ kind: 'end', id: 'id-1', name: input.name, endedAt: '2026-11-08T10:00:20.000Z', durationMs: 20_000, outcome: 'lost' });
  });

  it('a holder whose heartbeat is older than the TTL is taken over even if its process is alive', () => {
    registryFor(100).register(input);
    clock.ms = T0 + WAITER_TTL_MS + 1;
    const registration = registryFor(200).register(input);
    expect(registration.takeover).toMatchObject({ pid: 100, reason: 'no heartbeat for 60 s' });
  });

  it('a heartbeat exactly at the TTL is still alive', () => {
    registryFor(100).register(input);
    clock.ms = T0 + WAITER_TTL_MS;
    expect(() => registryFor(200).register(input)).toThrow(WaiterNameTakenError);
  });

  it('an unreadable record in the way is replaced, and said', () => {
    mkdirSync(waitersDir(configDir), { recursive: true });
    writeFileSync(fileOf(), '{"v":1,');
    const registration = registryFor(100).register(input);
    expect(registration.takeover).toMatchObject({ reason: 'unreadable record' });
    expect(registration.takeover?.pid).toBeUndefined();
    expect(JSON.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ id: 'id-1' });
  });

  it('no lost record when the taken-over wait had already written its end', () => {
    const first = registryFor(100);
    const registration = first.register(input);
    new WaiterHistoryLog(waiterHistoryDir(configDir), { now: () => new Date(clock.ms) }).recordEnd({ kind: 'end', id: registration.id, name: input.name, endedAt: new Date(clock.ms).toISOString(), durationMs: 0, outcome: 'cancelled' });
    alive.delete(100);
    registryFor(200).register(input);
    expect(historyLines().filter((line) => line['outcome'] === 'lost')).toEqual([]);
  });

  it('the registration, the takeover and the journal write all happen while the lock is held', () => {
    const lockPath = join(waitersDir(configDir), 'waiters.lock');
    const seen: Array<string | null> = [];
    const history = new WaiterHistoryLog(waiterHistoryDir(configDir), { now: () => new Date(clock.ms) });
    const spy = {
      recordStart: (record: Parameters<WaiterHistoryLog['recordStart']>[0]) => { seen.push(existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null); history.recordStart(record); },
      recordEnd: (end: WaiterEndRecord) => { seen.push(existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null); history.recordEnd(end); },
      hasEnd: (id: string, startedAt: string) => { seen.push(existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null); return history.hasEnd(id, startedAt); },
    } as unknown as WaiterHistoryLog;
    registryFor(100, { history: spy }).register(input);
    alive.delete(100);
    const second = registryFor(200, { history: spy });
    const registration = second.register(input);
    second.deregister(registration, { outcome: 'timeout' });
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen.every((holder) => holder !== null)).toBe(true);
    expect(seen).toContain('100');
    expect(seen).toContain('200');
  });

  it('waits for the lock another process holds, then sees what that process wrote (exactly one of two simultaneous registrations wins)', () => {
    mkdirSync(waitersDir(configDir), { recursive: true });
    const lockPath = join(waitersDir(configDir), 'waiters.lock');
    writeFileSync(lockPath, '300');
    let rival: unknown;
    const loser = registryFor(200, {
      sleep: (ms) => {
        clock.ms += ms;
        if (existsSync(lockPath) && readFileSync(lockPath, 'utf8') === '300') {
          // the other process finishes: its lock goes away and the first registration happens while the second one waits
          rmSync(lockPath);
          rival = registryFor(100).register(input);
        }
      },
    });
    expect(() => loser.register({ ...input, label: 'second' })).toThrow(WaiterNameTakenError);
    expect(rival).toMatchObject({ id: 'id-2', pid: 100 });
    expect(JSON.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ pid: 100, label: 'task abc' });
  });

  it('a waiters folder that cannot be created says which path and why', () => {
    writeFileSync(waitersDir(configDir), 'a file where the folder should be');
    let message = '';
    try {
      registryFor(100).register(input);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(waitersDir(configDir));
    expect(message).toMatch(/not started|cannot register/i);
    expect(message).toContain('Fix:');
  });
});

describe('heartbeat', () => {
  it('touches the file: its modification time becomes now', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    clock.ms += 15_000;
    expect(registry.heartbeat(registration)).toEqual({ status: 'ok' });
    expect(statSync(fileOf()).mtimeMs).toBe(clock.ms);
  });

  it('a heartbeat every 15 s keeps a rival out; silence for more than 60 s does not', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    for (let i = 0; i < 5; i++) {
      clock.ms += 15_000;
      registry.heartbeat(registration);
    }
    expect(() => registryFor(200).register(input)).toThrow(WaiterNameTakenError);
    clock.ms += WAITER_TTL_MS + 1;
    expect(registryFor(200).register(input).takeover).toBeDefined();
  });

  it('when the file is gone it is written again with the same id, and the history gets no second start', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    rmSync(fileOf());
    const result = registry.heartbeat(registration);
    expect(result.status).toBe('reregistered');
    expect(JSON.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ id: registration.id, pid: 100, startedAt: registration.startedAt });
    expect(historyLines().filter((line) => line['kind'] === 'start')).toHaveLength(1);
  });

  it('when a rival took the name (a stall longer than the TTL), the wait is told it lost it and nothing is overwritten', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    clock.ms += WAITER_TTL_MS + 5000;
    registryFor(200).register({ ...input, label: 'rival' });
    const result = registry.heartbeat(registration);
    expect(result).toMatchObject({ status: 'lost' });
    expect(result.status === 'lost' && result.message).toContain(input.name);
    expect(result.status === 'lost' && result.message).toContain('pid 200');
    expect(JSON.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ pid: 200, label: 'rival' });
  });

  it('retries a failed touch, then reports it with the path instead of throwing', () => {
    let attempts = 0;
    const registry = registryFor(100, {
      fs: { utimes: () => { attempts++; throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); } },
    });
    const registration = registry.register(input);
    const result = registry.heartbeat(registration);
    expect(attempts).toBe(3);
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toContain(fileOf());
    expect(result.status === 'failed' && result.message).toContain('EPERM');
  });

  it('a touch that works on the second attempt is a success', () => {
    let attempts = 0;
    const registry = registryFor(100, {
      fs: { utimes: (path, atime, mtime) => { attempts++; if (attempts === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); utimesSync(path, atime, mtime); } },
    });
    const registration = registry.register(input);
    expect(registry.heartbeat(registration)).toEqual({ status: 'ok' });
    expect(attempts).toBe(2);
  });
});

describe('deregister', () => {
  it('deletes the file of its own registration', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    expect(registry.deregister(registration)).toBe(true);
    expect(existsSync(fileOf())).toBe(false);
  });

  it('deletes only its own: a file now owned by another registration stays (the pid may even be the same)', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    rmSync(fileOf());
    const successor = registryFor(100).register(input);
    expect(registry.deregister(registration)).toBe(false);
    expect(JSON.parse(readFileSync(fileOf(), 'utf8'))).toMatchObject({ id: successor.id });
  });

  it('a file that is already gone is not an error', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    rmSync(fileOf());
    expect(registry.deregister(registration)).toBe(false);
  });

  it('writes the end of the wait: outcome, duration, and the event for a match', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    clock.ms += 42_000;
    registry.deregister(registration, { outcome: 'matched', eventId: 'evt-9', event: 'onTaskDone' });
    expect(historyLines()[1]).toEqual({ kind: 'end', id: 'id-1', name: input.name, endedAt: '2026-11-08T10:00:42.000Z', durationMs: 42_000, outcome: 'matched', eventId: 'evt-9', event: 'onTaskDone' });
  });

  it('writes the end once, whatever the number of exit paths that call it', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    registry.deregister(registration, { outcome: 'timeout' });
    registry.deregister(registration, { outcome: 'cancelled' });
    const ends = historyLines().filter((line) => line['kind'] === 'end' && line['id'] === registration.id);
    expect(ends.map((line) => line['outcome'])).toEqual(['timeout']);
  });

  it('does not write a second end for a wait a rival took over and recorded as lost', () => {
    const registry = registryFor(100);
    const registration = registry.register(input);
    clock.ms += WAITER_TTL_MS + 1;
    registryFor(200).register(input);
    expect(registry.deregister(registration, { outcome: 'timeout' })).toBe(false);
    const ends = historyLines().filter((line) => line['kind'] === 'end' && line['id'] === registration.id);
    expect(ends.map((line) => line['outcome'])).toEqual(['lost']);
  });

  it('a journal that cannot be written is said and does not keep the file', () => {
    const said: string[] = [];
    const broken = { recordStart: () => undefined, hasEnd: () => false, recordEnd: () => { throw new Error('disk full'); } } as unknown as WaiterHistoryLog;
    const registry = registryFor(100, { history: broken, onDiagnostic: (message) => { said.push(message); } });
    const registration = registry.register(input);
    expect(registry.deregister(registration, { outcome: 'timeout' })).toBe(true);
    expect(existsSync(fileOf())).toBe(false);
    expect(said.join(' ')).toContain('disk full');
    expect(said.join(' ')).toContain(waiterHistoryDir(configDir));
  });
});

describe('sweepStale', () => {
  it('removes the waits that are over (process gone, heartbeat expired) and keeps the live ones', () => {
    registryFor(100).register({ ...input, name: 'live.one' });
    registryFor(200).register({ ...input, name: 'dead.process' });
    registryFor(300).register({ ...input, name: 'silent.one' });
    alive.delete(200);
    setMtime(fileOf('silent.one'), T0 - WAITER_TTL_MS - 1000);
    setMtime(fileOf('live.one'), T0);
    const report = registryFor(100).sweepStale();
    expect(report.removed.sort()).toEqual(['dead.process', 'silent.one']);
    expect(readdirSync(waitersDir(configDir)).filter((name) => name.endsWith('.json'))).toEqual(['waiter-live.one.json']);
    expect(report.problems).toEqual([]);
  });

  it('records each removed wait as lost at its last heartbeat, once', () => {
    registryFor(200).register({ ...input, name: 'dead.process' });
    setMtime(fileOf('dead.process'), T0 + 5000);
    alive.delete(200);
    clock.ms = T0 + 120_000;
    registryFor(100).sweepStale();
    registryFor(100).sweepStale();
    const lost = historyLines().filter((line) => line['outcome'] === 'lost');
    expect(lost).toEqual([{ kind: 'end', id: 'id-1', name: 'dead.process', endedAt: '2026-11-08T10:00:05.000Z', durationMs: 5000, outcome: 'lost' }]);
  });

  it('leaves an unreadable record where it is and reports it', () => {
    mkdirSync(waitersDir(configDir), { recursive: true });
    writeFileSync(fileOf('bad.one'), 'garbage');
    const report = registryFor(100).sweepStale();
    expect(report.removed).toEqual([]);
    expect(existsSync(fileOf('bad.one'))).toBe(true);
    expect(report.problems.join(' ')).toContain('waiter-bad.one.json');
  });

  it('a missing folder is an empty sweep', () => {
    expect(registryFor(100).sweepStale()).toEqual({ removed: [], problems: [] });
  });
});
