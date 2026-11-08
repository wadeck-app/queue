/** Test helper: the WAL and DLQ entries the tests write, built in one place so that a new field of an entry is added once. */
import type { WalEntry } from './storage/Wal.js';
import type { DlqEntry } from './storage/DlqStore.js';

/** A pending WAL entry of a plain event; every field can be replaced through `overrides`. */
export function walEntry(id: string, overrides: Partial<WalEntry> = {}): WalEntry {
  return { id, timestamp: new Date().toISOString(), event: 'onX', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 's', status: 'pending', attempts: 0, ...overrides };
}

/** A dead-letter row of a plain event; every field can be replaced through `overrides`. */
export function dlqEntry(id: string, overrides: Partial<DlqEntry> = {}): DlqEntry {
  return { id, event: 'onX', payload: {}, meta: { cwd: '/tmp' }, subscriberId: 's', attempts: 1, lastError: 'boom', movedAt: new Date().toISOString(), ...overrides };
}

/** The project a daemon test seeds entries for: its folder and the id it was registered under. */
export interface SeedProject {
  cwd: string;
  projectId: string;
}

/** A pending WAL entry as an earlier run of the daemon left it, for a project: a fixed time, a payload that holds a secret, the event id `evt-<id>`. */
export function seededWalEntry(project: SeedProject, id: string, overrides: Partial<WalEntry> = {}, meta: Partial<WalEntry['meta']> = {}): WalEntry {
  return walEntry(id, {
    timestamp: '2026-11-07T10:00:00.000Z',
    event: 'onSeed',
    payload: { secret: `payload-of-${id}` },
    meta: { cwd: project.cwd, projectId: project.projectId, eventId: `evt-${id}`, ...meta },
    subscriberId: `${project.projectId}/old`,
    ...overrides,
  });
}

/** A dead-letter row as an earlier run of the daemon left it, for a project (same conventions as {@link seededWalEntry}). */
export function seededDlqEntry(project: SeedProject, id: string, overrides: Partial<DlqEntry> = {}, meta: Partial<DlqEntry['meta']> = {}): DlqEntry {
  return dlqEntry(id, {
    event: 'onSeed',
    payload: { secret: `payload-of-${id}` },
    meta: { cwd: project.cwd, projectId: project.projectId, eventId: `evt-${id}`, ...meta },
    subscriberId: `${project.projectId}/old`,
    lastError: 'seeded',
    movedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  });
}
