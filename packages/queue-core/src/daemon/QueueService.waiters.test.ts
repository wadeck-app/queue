import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService, type QueueServiceOptions } from './QueueService.js';
import { HistoryReader } from '../storage/HistoryReader.js';
import { Wal } from '../storage/Wal.js';
import { waitFor } from '../waitFor.testUtil.js';
import { MAX_WAITER_FILES, type WaiterScan } from '../waiters/WaiterScan.js';
import { WAITER_RECORD_VERSION, type WaiterRecord } from '../waiters/WaiterRecord.js';
import { waiterHistoryDir, waitersDir } from '../waiters/WaiterHistory.js';
import { deriveWakeAddress, parseWake } from '../waiters/WaiterWake.js';
import type { WakeSender } from '../waiters/WaiterNotifier.js';

// Push protocol 1.7.0: the `queued` and `dispatched` answers say who was waiting for the event (`queue wait`), counted from the waiter files after the history write of the push.
let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-waiters-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-waiters-project-'));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function waiter(name: string, overrides: Partial<WaiterRecord> = {}): WaiterRecord {
  return { v: WAITER_RECORD_VERSION, id: `id-${name}`, name, events: ['onThing'], whens: [], label: '', contact: { kind: 'none' }, pid: 4242, cwd: '/p', since: new Date().toISOString(), startedAt: new Date().toISOString(), ...overrides };
}

function put(record: WaiterRecord, ageMs = 0): string {
  mkdirSync(waitersDir(configDir), { recursive: true });
  const path = join(waitersDir(configDir), `waiter-${record.name}.json`);
  writeFileSync(path, JSON.stringify(record));
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

function service(options: QueueServiceOptions = {}): ReturnType<typeof createQueueService> {
  return createQueueService(configDir, { waiters: { isAlive: () => true }, ...options });
}

const push = (svc: ReturnType<typeof createQueueService>, body: Record<string, unknown> = {}) => svc.commands.push({ event: 'onThing', cwd: projectDir, payload: { a: 1 }, ...body } as never);

describe('the push answer says who waits', () => {
  it('no subscriber and one matching waiter: waiterCount 1 and its name', async () => {
    put(waiter('a.b'));
    const answer = await push(service());
    expect(answer).toMatchObject({ status: 'queued', subscriberCount: 0, waiterCount: 1, waiters: ['a.b'] });
  });

  it('nobody waits: waiterCount 0 and an empty list (the daemon looked, and found nobody)', async () => {
    const answer = await push(service());
    expect(answer).toMatchObject({ status: 'queued', subscriberCount: 0, waiterCount: 0, waiters: [] });
  });

  it('a waiter for another event does not count', async () => {
    put(waiter('a.b', { events: ['onOther'] }));
    expect(await push(service())).toMatchObject({ waiterCount: 0, waiters: [] });
  });

  it('a pattern counts when it matches the name', async () => {
    put(waiter('a.b', { events: ['on.>'] }));
    put(waiter('c.d', { events: ['onThing.*'] }));
    const answer = await push(service(), { event: 'onThing.done' });
    expect(answer.waiters).toEqual(['c.d']);
  });

  it('the filters are evaluated on the envelope the history holds: payload, working directory, project name', async () => {
    put(waiter('payload.yes', { whens: ['payload.a=1'] }));
    put(waiter('payload.no', { whens: ['payload.a=2'] }));
    put(waiter('cwd.yes', { whens: [`meta.cwd=${projectDir}`] }));
    put(waiter('cwd.no', { whens: ['meta.cwd=/elsewhere'] }));
    const answer = await push(service());
    expect(answer.waiters).toEqual(['cwd.yes', 'payload.yes']);
    expect(answer.waiterCount).toBe(2);
  });

  it('a waiter whose process is gone, or silent for more than a minute, does not count', async () => {
    put(waiter('dead.one', { pid: 1 }));
    put(waiter('silent.one'), 61_000);
    put(waiter('live.one', { pid: 2 }));
    const answer = await push(service({ waiters: { isAlive: (pid) => pid !== 1 } }));
    expect(answer.waiters).toEqual(['live.one']);
  });

  it('subscriberCount keeps its meaning: waiters are not subscribers', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), 'subscribers:\n  onThing:\n    - type: cli\n      name: s1\n      command: echo x\n    - type: cli\n      name: s2\n      command: echo x\n');
    put(waiter('a.b'));
    const answer = await push(service());
    expect(answer.subscriberCount).toBe(2);
    expect(answer.waiterCount).toBe(1);
    // the two deliveries end before the folder is removed
    await waitFor('the deliveries are acknowledged', () => new Wal(join(configDir, 'wal.ndjson')).pendingCount() === 0);
  });

  it('a before* event answers dispatched with the waiters too', async () => {
    put(waiter('a.b', { events: ['beforeThing'] }));
    const answer = await push(service(), { event: 'beforeThing' });
    expect(answer.status).toBe('dispatched');
    expect(answer).toMatchObject({ waiterCount: 1, waiters: ['a.b'] });
  });

  it('names are capped at 20, the count is the real number', async () => {
    for (let i = 0; i < 25; i++) {
      put(waiter(`w.n${String(i).padStart(2, '0')}`));
    }
    const answer = await push(service());
    expect(answer.waiterCount).toBe(25);
    expect(answer.waiters).toHaveLength(20);
    expect(answer.waiters![0]).toBe('w.n00');
  });

  it('an answer that is not queued or dispatched carries no waiter field', async () => {
    put(waiter('a.b'));
    writeFileSync(join(configDir, 'subscribers.yml'), 'subscribers: [: not yaml');
    const aborted = await push(service());
    expect(aborted.status).toBe('aborted');
    expect(aborted).not.toHaveProperty('waiterCount');
    const rejected = await push(service(), { event: 'queue.custom' });
    expect(rejected.status).toBe('rejected');
    expect(rejected).not.toHaveProperty('waiters');
  });
});

describe('order and failure', () => {
  it('the waiters are counted after the trigger is in the history (a waiter reads the history)', async () => {
    let seenInHistory: number | undefined;
    const scan = (): WaiterScan => {
      seenInHistory = new HistoryReader(join(configDir, 'history')).read({ event: 'onThing' }).length;
      return { waiters: [], problems: [], partial: false };
    };
    await push(service({ waiters: { scan } }));
    expect(seenInHistory).toBe(1);
  });

  it('when the history record could not be written, no waiter is claimed: a waiter cannot see that event', async () => {
    put(waiter('a.b'));
    // a file where the history folder should be
    writeFileSync(join(configDir, 'history'), 'not a folder');
    const scan = vi.fn(() => ({ waiters: [], problems: [], partial: false }) as WaiterScan);
    const answer = await push(service({ waiters: { scan } }));
    expect(answer.status).toBe('queued');
    expect(answer).not.toHaveProperty('waiterCount');
    expect(answer).not.toHaveProperty('waiters');
    expect(scan).not.toHaveBeenCalled();
  });

  it('a scan that throws never fails the push, adds no field, and is said once per cause', async () => {
    const svc = service({ waiters: { scan: () => { throw new Error('scan exploded'); } } });
    const said = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    const first = await push(svc);
    const second = await push(svc);
    expect(first.status).toBe('queued');
    expect(second.status).toBe('queued');
    expect(first).not.toHaveProperty('waiterCount');
    const lines = said.mock.calls.map(([entry]) => entry.message).filter((message) => message.includes('scan exploded'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(waitersDir(configDir));
    expect(lines[0]).toContain('waiterCount');
  });

  it('a file that cannot be used is said once, with its path, and the push counts the others', async () => {
    const bad = put(waiter('bad.one'));
    writeFileSync(bad, 'garbage');
    put(waiter('good.one'));
    const svc = service();
    const said = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    const first = await push(svc);
    await push(svc);
    expect(first.waiters).toEqual(['good.one']);
    const lines = said.mock.calls.map(([entry]) => entry.message).filter((message) => message.includes(bad));
    expect(lines).toHaveLength(1);
  });

  it('a folder over the cap is said, and the count is the partial one', async () => {
    for (let i = 0; i < MAX_WAITER_FILES + 1; i++) {
      put(waiter(`w.${String(i).padStart(3, '0')}`));
    }
    const svc = service();
    const said = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    const answer = await push(svc);
    expect(answer.waiterCount).toBe(MAX_WAITER_FILES);
    expect(said.mock.calls.map(([entry]) => entry.message).some((message) => message.includes(String(MAX_WAITER_FILES + 1)))).toBe(true);
  });

  it('never deletes a waiter file while serving a push, not even a stale or unreadable one', async () => {
    const stale = put(waiter('stale.one'), 10 * 60_000);
    const bad = put(waiter('bad.one'));
    writeFileSync(bad, 'garbage');
    await push(service());
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(bad)).toBe(true);
  });

  it('the scan is not run for a push that was refused before anything was recorded', async () => {
    const scan = vi.fn(() => ({ waiters: [], problems: [], partial: false }) as WaiterScan);
    const answer = await push(service({ waiters: { scan } }), { payload: undefined });
    expect(answer.status).toBe('rejected');
    expect(scan).not.toHaveBeenCalled();
  });
});

describe('daemon start', () => {
  it('sweeps the waits that are over and records them as lost; a live wait stays', () => {
    const dead = put(waiter('dead.one', { pid: 1 }));
    const live = put(waiter('live.one', { pid: 2 }));
    const svc = service({ waiters: { isAlive: (pid) => pid === 2 } });
    svc.onStart();
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(readdirSync(waiterHistoryDir(configDir))).toHaveLength(1);
  });

  it('says what it swept', () => {
    put(waiter('dead.one', { pid: 1 }));
    const svc = service({ waiters: { isAlive: () => false } });
    const said = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    svc.onStart();
    expect(said.mock.calls.map(([entry]) => entry.message).some((message) => message.includes('dead.one') && message.includes('over'))).toBe(true);
  });

  it('a sweep that fails never stops the start, and is said', () => {
    // a file where the waiters folder should be: the sweep cannot lock
    writeFileSync(waitersDir(configDir), 'not a folder');
    const svc = service();
    const said = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    expect(() => svc.onStart()).not.toThrow();
    expect(said.mock.calls.map(([entry]) => entry.message).some((message) => message.includes(waitersDir(configDir)))).toBe(true);
  });
});

describe('the wake: a hint to each matching wait that listens, after the history write', () => {
  const pipeOf = (name: string): WaiterRecord['contact'] => {
    const address = deriveWakeAddress(configDir, name);
    if (address.kind !== 'pipe') throw new Error('no wake address on this machine for the test');
    return { kind: 'pipe', path: address.path };
  };
  const serviceWithSend = (send: WakeSender, extra: QueueServiceOptions = {}) => service({ waiters: { isAlive: () => true, wake: { send } }, ...extra });

  it('wakes the matching wait that has a pipe, with the event name and id and nothing else, on the address derived from its name', async () => {
    put(waiter('a.one', { contact: pipeOf('a.one') }));
    const sent: Array<{ path: string; line: string }> = [];
    const answer = await push(serviceWithSend(async (path, line) => { sent.push({ path, line }); }));
    expect(sent).toHaveLength(1);
    expect((pipeOf('a.one') as { path: string }).path).toBe(sent[0]!.path);
    expect(parseWake(sent[0]!.line.trimEnd())).toEqual({ event: 'onThing', eventId: answer.eventId });
    expect(sent[0]!.line).not.toContain('payload');
  });

  it('does not wake a wait for another event, a wait whose filters do not hold, or one that only polls', async () => {
    put(waiter('other.event', { events: ['onOther'], contact: pipeOf('other.event') }));
    put(waiter('other.payload', { whens: ['payload.a=2'], contact: pipeOf('other.payload') }));
    put(waiter('polling.only'));
    const sent: string[] = [];
    await push(serviceWithSend(async (path) => { sent.push(path); }));
    expect(sent).toEqual([]);
  });

  it('the wake is sent after the trigger is in the history (the wait reads the history when it is woken)', async () => {
    put(waiter('a.one', { contact: pipeOf('a.one') }));
    let seen: number | undefined;
    await push(serviceWithSend(async () => { seen = new HistoryReader(join(configDir, 'history')).read({ event: 'onThing' }).length; }));
    expect(seen).toBe(1);
  });

  it('the answer does not wait for the wake: a wait whose pipe never answers does not delay it', async () => {
    put(waiter('a.one', { contact: pipeOf('a.one') }));
    let started = 0;
    const answer = await push(serviceWithSend(() => { started++; return new Promise<void>(() => undefined); }));
    expect(answer).toMatchObject({ status: 'queued', waiterCount: 1 });
    expect(started).toBe(1);
  });

  it('a pipe that is dead never fails the push, and the cause is said once however many pushes', async () => {
    put(waiter('a.one', { contact: pipeOf('a.one') }));
    const svc = serviceWithSend(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
    const said = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    const first = await push(svc);
    const second = await push(svc);
    expect(first).toMatchObject({ status: 'queued', waiterCount: 1 });
    expect(second).toMatchObject({ status: 'queued', waiterCount: 1 });
    await waitFor('the failure is reported', () => said.mock.calls.some(([entry]) => entry.message.includes('ECONNREFUSED')));
    await waitFor('the second push settled', () => said.mock.calls.length >= 1);
    const lines = said.mock.calls.map(([entry]) => entry.message).filter((message) => message.includes('ECONNREFUSED'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('a.one');
  });

  it('never connects to the address a record claims when it is not the derived one: the wait is counted, not woken, and the refusal is said once', async () => {
    put(waiter('a.one', { contact: { kind: 'pipe', path: '/tmp/forged.sock' } }));
    const sent: string[] = [];
    const svc = serviceWithSend(async (path) => { sent.push(path); });
    const said = vi.spyOn(svc.eventLogger, 'logDiagnostic');
    const answer = await push(svc);
    await push(svc);
    expect(answer).toMatchObject({ waiterCount: 1, waiters: ['a.one'] });
    expect(sent).toEqual([]);
    const lines = said.mock.calls.map(([entry]) => entry.message).filter((message) => message.includes('/tmp/forged.sock'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('a.one');
  });

  it('a wake that cannot even be started (the sender throws at once) never fails the push', async () => {
    put(waiter('a.one', { contact: pipeOf('a.one') }));
    const answer = await push(serviceWithSend(() => { throw new Error('boom'); }));
    expect(answer).toMatchObject({ status: 'queued', waiterCount: 1 });
  });

  it('nobody is woken when the history record could not be written (the wait could not see the event)', async () => {
    put(waiter('a.one', { contact: pipeOf('a.one') }));
    writeFileSync(join(configDir, 'history'), 'not a folder');
    const sent: string[] = [];
    await push(serviceWithSend(async (path) => { sent.push(path); }));
    expect(sent).toEqual([]);
  });

  it('a before* event wakes too', async () => {
    put(waiter('a.one', { events: ['beforeThing'], contact: pipeOf('a.one') }));
    const sent: string[] = [];
    await push(serviceWithSend(async (path) => { sent.push(path); }), { event: 'beforeThing' });
    expect(sent).toHaveLength(1);
  });
});
