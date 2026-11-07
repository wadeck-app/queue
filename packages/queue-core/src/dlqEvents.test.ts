import { describe, expect, it } from 'vitest';
import {
  buildDlqAddedEvent, buildDlqRemovedEvent, isDlqEventExcluded, runBounded, DLQ_EVENT_DECLARATIONS, DLQ_ADDED_EVENT, DLQ_REMOVED_EVENT, MAX_DLQ_EVENT_ERROR_CHARS,
  type DlqAddedReason,
} from './dlqEvents.js';
import { validateSourceDeclaration } from './catalog/EventCatalog.js';
import type { DlqEntry } from './storage/DlqStore.js';

function entry(overrides: Partial<DlqEntry> = {}, meta: Partial<DlqEntry['meta']> = {}): DlqEntry {
  return {
    id: 'wal-1',
    event: 'onTask.failed',
    payload: { taskId: 'T-42', secretField: 'S3CRET', nested: { deep: 'DEEPVALUE' } },
    meta: { cwd: '/work/app', projectId: 'proj-1', eventId: 'evt-1', ...meta },
    subscriberId: 'proj-1/notify',
    attempts: 3,
    lastError: 'exit code 2',
    movedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildDlqAddedEvent', () => {
  it('carries the facts and a reference to the base event', () => {
    const built = buildDlqAddedEvent(entry(), { reason: 'retries-exhausted', exitCode: 2, target: 'node run.js' });
    expect(built.event).toBe('queue.dlq.added');
    expect(built.payload).toEqual({
      entryId: 'wal-1',
      eventId: 'evt-1',
      event: 'onTask.failed',
      subscriberId: 'proj-1/notify',
      projectId: 'proj-1',
      reason: 'retries-exhausted',
      error: 'exit code 2',
      attempts: 3,
      exitCode: 2,
      target: 'node run.js',
      original: { $eventRef: 'evt-1' },
    });
  });

  it.each<DlqAddedReason>(['retries-exhausted', 'permanent-failure', 'invalid-configuration', 'given-up'])('passes the reason %s through', (reason) => {
    expect(buildDlqAddedEvent(entry(), { reason }).payload['reason']).toBe(reason);
  });

  it('leaves out the optional facts that are unknown (projectId, exitCode, target)', () => {
    const built = buildDlqAddedEvent(entry({}, { projectId: undefined }), { reason: 'permanent-failure' });
    expect(built.payload).not.toHaveProperty('projectId');
    expect(built.payload).not.toHaveProperty('exitCode');
    expect(built.payload).not.toHaveProperty('target');
  });

  it('keeps an exit code of 0 (a command can fail by other means than its exit code, 0 is still a fact)', () => {
    expect(buildDlqAddedEvent(entry(), { reason: 'retries-exhausted', exitCode: 0 }).payload['exitCode']).toBe(0);
  });

  it('caps the error at the limit, marks the cut, and keeps a shorter or equal error as it is', () => {
    const exact = 'e'.repeat(MAX_DLQ_EVENT_ERROR_CHARS);
    expect(buildDlqAddedEvent(entry({ lastError: exact }), { reason: 'retries-exhausted' }).payload['error']).toBe(exact);
    const capped = buildDlqAddedEvent(entry({ lastError: 'e'.repeat(5000) }), { reason: 'retries-exhausted' }).payload['error'] as string;
    expect(capped).toHaveLength(MAX_DLQ_EVENT_ERROR_CHARS);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('a legacy entry without meta.eventId has no eventId and a null reference (never a guessed id)', () => {
    const built = buildDlqAddedEvent(entry({}, { eventId: undefined }), { reason: 'retries-exhausted' });
    expect(built.payload).not.toHaveProperty('eventId');
    expect(built.payload['original']).toEqual({ $eventRef: null });
    expect(JSON.stringify(built.payload)).not.toContain('wal-1"}');
  });
});

describe('buildDlqRemovedEvent', () => {
  it.each(['replayed', 'cleared', 'evicted'] as const)('builds the facts for %s, without the failure details', (reason) => {
    const built = buildDlqRemovedEvent(entry(), reason);
    expect(built.event).toBe('queue.dlq.removed');
    expect(built.payload).toEqual({
      entryId: 'wal-1',
      eventId: 'evt-1',
      event: 'onTask.failed',
      subscriberId: 'proj-1/notify',
      projectId: 'proj-1',
      reason,
      original: { $eventRef: 'evt-1' },
    });
  });

  it('a legacy entry has a null reference and no eventId', () => {
    const built = buildDlqRemovedEvent(entry({}, { eventId: undefined }), 'cleared');
    expect(built.payload).not.toHaveProperty('eventId');
    expect(built.payload['original']).toEqual({ $eventRef: null });
  });
});

describe('no copy of the base payload, ever', () => {
  it.each([
    ['added', () => buildDlqAddedEvent(entry(), { reason: 'retries-exhausted', exitCode: 1, target: 'x' })],
    ['removed', () => buildDlqRemovedEvent(entry(), 'cleared')],
  ])('no key or value of the base payload appears anywhere in the %s event', (_name, build) => {
    const text = JSON.stringify(build().payload);
    for (const fragment of ['taskId', 'T-42', 'secretField', 'S3CRET', 'nested', 'deep', 'DEEPVALUE']) {
      expect(text, fragment).not.toContain(fragment);
    }
  });
});

describe('isDlqEventExcluded', () => {
  it('excludes a base event in the queue. namespace and nothing else', () => {
    expect(isDlqEventExcluded({ event: 'queue.dlq.added' })).toBe(true);
    expect(isDlqEventExcluded({ event: 'queue.anything' })).toBe(true);
    expect(isDlqEventExcluded({ event: 'onTask.failed' })).toBe(false);
    expect(isDlqEventExcluded({ event: 'myapp.queue.done' })).toBe(false);
    expect(isDlqEventExcluded({ event: 'queue' })).toBe(false);
  });
});

describe('DLQ_EVENT_DECLARATIONS', () => {
  it('is a valid catalog declaration of both events under the source queue', () => {
    const checked = validateSourceDeclaration({ source: 'queue', events: DLQ_EVENT_DECLARATIONS });
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    expect(DLQ_EVENT_DECLARATIONS.map((declared) => declared.name)).toEqual([DLQ_ADDED_EVENT, DLQ_REMOVED_EVENT]);
  });

  it('documents the reference convention, the daemon origin and the absence of a payload copy', () => {
    for (const declared of DLQ_EVENT_DECLARATIONS) {
      expect(declared.description).toContain('Emitted by the daemon, always');
      expect(declared.description).toContain('$eventRef');
      expect(JSON.stringify(declared.schema)).toContain('$eventRef');
    }
  });
});

describe('runBounded', () => {
  it('runs every item, never more than the limit at the same time', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runBounded(Array.from({ length: 35 }, (_, i) => i), 10, async (item) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      running--;
      done.push(item);
    });
    expect(done).toHaveLength(35);
    expect(new Set(done).size).toBe(35);
    expect(peak).toBe(10);
  });

  it('an empty list resolves at once', async () => {
    await runBounded([], 10, () => Promise.reject(new Error('never called')));
  });
});
