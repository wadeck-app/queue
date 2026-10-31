import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, removeProject } from '@wadeck-app/project-sdk';
import { getRelatedForProject, statusOf, RELATED_ITEMS_LIMIT } from './related.js';
import { InvalidQueryError, UnknownProjectError } from './errors.js';

let configDir: string;
let registryDir: string;
let foldersDir: string;
// Fixed clock: every subtitle is derived from it
const NOW = new Date('2026-10-31T12:00:00.000Z');

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-related-'));
  registryDir = mkdtempSync(join(tmpdir(), 'app-module-related-registry-'));
  foldersDir = mkdtempSync(join(tmpdir(), 'app-module-related-folders-'));
  mkdirSync(join(foldersDir, 'app'));
  mkdirSync(join(foldersDir, 'other'));
});

afterEach(() => {
  for (const dir of [configDir, registryDir, foldersDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

type Rec = Record<string, unknown>;

function writeHistory(day: string, records: Rec[]): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  writeFileSync(join(configDir, 'history', `${day}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const trigger = (eventId: string, ts: string, extra: Rec = {}): Rec => ({ type: 'trigger', ts, eventId, event: 'onPush', matchedCount: 1, totalCount: 1, ...extra });
const outcome = (eventId: string, ts: string, extra: Rec = {}): Rec => ({ type: 'outcome', ts, eventId, event: 'onPush', subscriberId: 'sub-a', status: 'success', ...extra });

function writeWal(entries: Array<{ id: string; status: string; projectId?: string }>): void {
  const lines = entries.map((e) => JSON.stringify({
    id: e.id, timestamp: '2026-10-31T11:00:00.000Z', event: 'onPush', payload: {}, meta: e.projectId === undefined ? {} : { projectId: e.projectId }, subscriberId: 'sub-a', status: e.status, attempts: 1,
  }));
  writeFileSync(join(configDir, 'wal.ndjson'), lines.join('\n') + '\n');
}

function writeDlq(entries: Array<{ id: string; projectId?: string }>): void {
  const lines = entries.map((e) => JSON.stringify({
    id: e.id, event: 'onPush', payload: {}, meta: e.projectId === undefined ? {} : { projectId: e.projectId }, subscriberId: 'sub-a', attempts: 3, lastError: 'x', movedAt: '2026-10-31T11:30:00.000Z',
  }));
  writeFileSync(join(configDir, 'dlq.ndjson'), lines.join('\n') + '\n');
}

async function registerApp(): Promise<string> {
  return (await addProject(registryDir, { name: 'app', path: join(foldersDir, 'app') })).id;
}

describe('getRelatedForProject: the contract with the project module', () => {
  it('answers count 0, no item and the history link for a project the queue never saw', async () => {
    const id = await registerApp();
    expect(getRelatedForProject(configDir, registryDir, id, NOW)).toEqual({ title: 'Queue', count: 0, items: [], moreUrl: `/modules/queue/history?project=${id}` });
  });

  it('counts the in-flight WAL entries (pending and failed) and the DLQ entries of the project, not the delivered ones nor another project\'s', async () => {
    const id = await registerApp();
    const other = (await addProject(registryDir, { name: 'other', path: join(foldersDir, 'other') })).id;
    writeWal([
      { id: 'w1', status: 'pending', projectId: id },
      { id: 'w2', status: 'failed', projectId: id },
      { id: 'w3', status: 'acked', projectId: id },
      { id: 'w4', status: 'pending', projectId: other },
      { id: 'w5', status: 'pending' },
    ]);
    writeDlq([{ id: 'd1', projectId: id }, { id: 'd2', projectId: other }, { id: 'd3' }]);
    const related = getRelatedForProject(configDir, registryDir, id, NOW);
    expect(related.count).toBe(3);
    // The DLQ link comes first and says what the count is made of
    expect(related.items).toEqual([
      { label: '1 in the dead-letter queue', url: `/modules/queue/dlq?project=${id}`, subtitle: 'count = 2 in flight + 1 given up' },
    ]);
  });

  it('has no DLQ item when the dead-letter queue holds nothing of the project', async () => {
    const id = await registerApp();
    writeWal([{ id: 'w1', status: 'pending', projectId: id }]);
    const related = getRelatedForProject(configDir, registryDir, id, NOW);
    expect(related.count).toBe(1);
    expect(related.items).toEqual([]);
  });

  it('lists the 10 newest history entries first, each linking the history page of the project and event', async () => {
    const id = await registerApp();
    const records: Rec[] = [];
    for (let i = 0; i < 12; i++) {
      const ts = `2026-10-31T10:${String(i).padStart(2, '0')}:00.000Z`;
      records.push(trigger(`e${i}`, ts, { projectId: id, event: `onEvent${i}` }), outcome(`e${i}`, ts, { event: `onEvent${i}`, projectId: id }));
    }
    writeHistory('2026-10-31', records);
    const { items } = getRelatedForProject(configDir, registryDir, id, NOW);
    expect(items).toHaveLength(RELATED_ITEMS_LIMIT);
    expect(items.map((item) => item.label)).toEqual(Array.from({ length: 10 }, (_, i) => `onEvent${11 - i} success`));
    expect(items[0]).toEqual({
      label: 'onEvent11 success',
      url: `/modules/queue/history?project=${id}&event=onEvent11`,
      subtitle: '1 h ago - sub-a',
    });
    expect(items.every((item) => item.url.startsWith('/modules/'))).toBe(true);
  });

  it('breaks a timestamp tie by event id, so the same files always give the same card', async () => {
    const id = await registerApp();
    const ts = '2026-10-31T11:59:30.000Z';
    writeHistory('2026-10-31', [
      trigger('a1', ts, { projectId: id, event: 'onA' }), outcome('a1', ts, { event: 'onA', projectId: id }),
      trigger('b2', ts, { projectId: id, event: 'onB' }), outcome('b2', ts, { event: 'onB', projectId: id }),
    ]);
    const labels = getRelatedForProject(configDir, registryDir, id, NOW).items.map((item) => item.label);
    expect(labels).toEqual(['onB success', 'onA success']);
  });

  it('matches an entry through the project of a subscriber outcome and ignores the entries of other projects', async () => {
    const id = await registerApp();
    const other = (await addProject(registryDir, { name: 'other', path: join(foldersDir, 'other') })).id;
    const ts = '2026-10-31T11:00:00.000Z';
    writeHistory('2026-10-31', [
      // pushed from another project, dispatched under this one (to-children)
      trigger('child', ts, { projectId: other, event: 'onChild' }), outcome('child', ts, { event: 'onChild', projectId: id, emitterProjectId: other }),
      trigger('foreign', ts, { projectId: other, event: 'onForeign' }), outcome('foreign', ts, { event: 'onForeign', projectId: other }),
    ]);
    expect(getRelatedForProject(configDir, registryDir, id, NOW).items.map((item) => item.label)).toEqual(['onChild success']);
  });

  it('files a to-children dispatch under the descendant only, and a to-parents one under the emitter only', async () => {
    const emitter = await registerApp();
    const descendant = (await addProject(registryDir, { name: 'other', path: join(foldersDir, 'other') })).id;
    const ts = '2026-10-31T11:00:00.000Z';
    writeHistory('2026-10-31', [
      // to-children: pushed in the emitter, the subscriber of the descendant ran under the descendant; the emitter's own subscriber too
      trigger('down', ts, { projectId: emitter, event: 'onDown', matchedCount: 1 }),
      outcome('down', ts, { event: 'onDown', projectId: descendant, emitterProjectId: emitter, subscriberId: `${descendant}/child-sub` }),
      // to-parents: the subscriber of an ancestor ran, filed under the emitter
      trigger('up', ts, { projectId: emitter, event: 'onUp', matchedCount: 1 }),
      outcome('up', ts, { event: 'onUp', projectId: emitter, subscriberId: `${emitter}/parent-sub` }),
    ]);
    expect(getRelatedForProject(configDir, registryDir, descendant, NOW).items.map((item) => item.label)).toEqual(['onDown success']);
    expect(getRelatedForProject(configDir, registryDir, emitter, NOW).items.map((item) => item.label).sort()).toEqual(['onDown success', 'onUp success']);
  });

  it('answers 200-shaped data for a virtual project (no folder)', async () => {
    const virtual = (await addProject(registryDir, { name: 'ghost' })).id;
    writeHistory('2026-10-31', [trigger('e1', '2026-10-31T11:00:00.000Z', { projectId: virtual }), outcome('e1', '2026-10-31T11:00:00.000Z', { projectId: virtual })]);
    expect(getRelatedForProject(configDir, registryDir, virtual, NOW).items).toHaveLength(1);
    const empty = (await addProject(registryDir, { name: 'ghost2' })).id;
    expect(getRelatedForProject(configDir, registryDir, empty, NOW)).toMatchObject({ count: 0, items: [] });
  });

  it('answers with the data of a soft-deleted project', async () => {
    const id = await registerApp();
    writeWal([{ id: 'w1', status: 'pending', projectId: id }]);
    await removeProject(registryDir, id);
    expect(getRelatedForProject(configDir, registryDir, id, NOW)).toMatchObject({ count: 1 });
  });

  it('throws UnknownProjectError naming the id for an id in no registry', async () => {
    await registerApp();
    expect(() => getRelatedForProject(configDir, registryDir, 'deadbeef', NOW)).toThrow(UnknownProjectError);
    expect(() => getRelatedForProject(configDir, registryDir, 'deadbeef', NOW)).toThrow(/No project with id deadbeef/);
  });

  it('throws UnknownProjectError for every id when there is no registry yet', () => {
    expect(() => getRelatedForProject(configDir, join(registryDir, 'never-created'), 'deadbeef', NOW)).toThrow(UnknownProjectError);
  });

  it.each(['', 'DEADBEEF', 'deadbee', 'deadbeef0', 'not-hex!', '../x'])('throws InvalidQueryError with the /dlq wording for the malformed id %j', (bad) => {
    expect(() => getRelatedForProject(configDir, registryDir, bad, NOW)).toThrow(InvalidQueryError);
    expect(() => getRelatedForProject(configDir, registryDir, bad, NOW)).toThrow(/project must be the id of a registered project \(8 hexadecimal characters, project list shows them\)/);
  });

  it('throws on a corrupt registry instead of answering as if the project did not exist', () => {
    writeFileSync(join(registryDir, 'registry.json'), '{ not json');
    expect(() => getRelatedForProject(configDir, registryDir, 'deadbeef', NOW)).toThrow();
    expect(() => getRelatedForProject(configDir, registryDir, 'deadbeef', NOW)).not.toThrow(UnknownProjectError);
  });
});

describe('subtitles', () => {
  it('names at most two subscribers then +N, and ignores the ones of other projects when the project has its own', async () => {
    const id = await registerApp();
    const ts = '2026-10-31T11:55:00.000Z';
    writeHistory('2026-10-31', [
      trigger('e1', ts, { projectId: id, matchedCount: 4 }),
      outcome('e1', ts, { projectId: id, subscriberId: 's1' }),
      outcome('e1', ts, { projectId: id, subscriberId: 's2' }),
      outcome('e1', ts, { projectId: id, subscriberId: 's3' }),
      outcome('e1', ts, { projectId: 'deadbeef', subscriberId: 'foreign' }),
    ]);
    expect(getRelatedForProject(configDir, registryDir, id, NOW).items[0]?.subtitle).toBe('5 min ago - s1, s2 +1');
  });

  it('shows just the time when no subscriber ran, and the UTC date after two days', async () => {
    const id = await registerApp();
    writeHistory('2026-10-20', [trigger('old', '2026-10-20T08:00:00.000Z', { projectId: id, matchedCount: 0 })]);
    writeHistory('2026-10-31', [trigger('new', '2026-10-31T11:59:50.000Z', { projectId: id, matchedCount: 0 })]);
    const subtitles = getRelatedForProject(configDir, registryDir, id, NOW).items.map((item) => item.subtitle);
    expect(subtitles).toEqual(['just now', '2026-10-20']);
  });
});

describe('statusOf (worst wins)', () => {
  const entry = (matchedCount: number, statuses: string[], orphan = false) => ({
    ts: NOW.toISOString(), eventId: 'e', event: 'onPush', orphan, matchedCount: orphan ? undefined : matchedCount,
    subscribers: statuses.map((status, i) => ({ subscriberId: `s${i}`, status })),
  }) as unknown as Parameters<typeof statusOf>[0];

  it('ranks dlq over failed over pending over success over filtered', () => {
    expect(statusOf(entry(3, ['success', 'failed', 'dlq']))).toBe('dlq');
    expect(statusOf(entry(2, ['success', 'failed']))).toBe('failed');
    expect(statusOf(entry(2, ['success']))).toBe('pending');
    expect(statusOf(entry(1, ['success', 'filtered']))).toBe('success');
    expect(statusOf(entry(0, ['filtered']))).toBe('filtered');
    expect(statusOf(entry(0, []))).toBe('no subscriber');
  });

  it('says orphan for an entry with no trigger, whatever its outcomes (a retry is not merged into the original)', () => {
    expect(statusOf(entry(0, ['success'], true))).toBe('orphan');
  });

  it('does not count a filtered outcome as a reported dispatch', () => {
    expect(statusOf(entry(1, ['filtered']))).toBe('pending');
  });
});

describe('orphans, ties with the history page and large histories', () => {
  it('lists a retry (an entry with outcomes under the project and no trigger) as its own orphan row', async () => {
    const id = await registerApp();
    writeHistory('2026-10-31', [outcome('wal-id', '2026-10-31T11:00:00.000Z', { projectId: id, event: 'onRetry' })]);
    expect(getRelatedForProject(configDir, registryDir, id, NOW).items.map((item) => item.label)).toEqual(['onRetry orphan']);
  });

  it('reads a history of several thousand entries well inside the 2 s budget of the project page', async () => {
    const id = await registerApp();
    const records: Rec[] = [];
    for (let i = 0; i < 6000; i++) {
      const ts = new Date(NOW.getTime() - i * 1000).toISOString();
      records.push(trigger(`e${i}`, ts, { projectId: i % 2 === 0 ? id : 'deadbeef', payload: { text: 'x'.repeat(500) } }), outcome(`e${i}`, ts, { projectId: i % 2 === 0 ? id : 'deadbeef' }));
    }
    writeHistory('2026-10-31', records);
    const started = Date.now();
    const related = getRelatedForProject(configDir, registryDir, id, NOW);
    const elapsed = Date.now() - started;
    expect(related.items).toHaveLength(RELATED_ITEMS_LIMIT);
    expect(elapsed).toBeLessThan(2000);
  });
});
