import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DLQ_EVENT_DECLARATIONS, writeSourceDeclaration } from '@wadeck-app/queue-core';

const mockPushEvent = vi.hoisted(() => vi.fn());
vi.mock('./push.js', () => ({ pushEvent: mockPushEvent }));

import { getEvents, getEventPage, pushTestEvent, reservedPushProblem } from './events.js';
import { ReservedEventError } from './errors.js';

// The queue. namespace is the daemon's own: the events page must not offer a test push of queue.dlq.* (the daemon would refuse it), and says why.

let configDir: string;

beforeEach(() => {
  mockPushEvent.mockReset();
  configDir = mkdtempSync(join(tmpdir(), 'app-module-events-reserved-'));
  // exactly what the daemon declares at start, examples included
  writeSourceDeclaration(configDir, { source: 'queue', events: DLQ_EVENT_DECLARATIONS });
  writeSourceDeclaration(configDir, { source: 'mine', events: [{ name: 'job.started', description: 'A job.', example: { jobId: 'x' } }] });
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('events of the reserved queue. namespace on the events page', () => {
  it('the declared events carry an example (documentation) yet are not pushable as a test: canPushTest is false for them and true for an ordinary event', () => {
    expect(DLQ_EVENT_DECLARATIONS.every((declaration) => declaration.example !== undefined)).toBe(true);
    const rows = getEvents(configDir, {}).events;
    expect(rows.find((row) => row.name === 'queue.dlq.added')).toMatchObject({ declared: true, canPushTest: false });
    expect(rows.find((row) => row.name === 'queue.dlq.removed')).toMatchObject({ declared: true, canPushTest: false });
    expect(rows.find((row) => row.name === 'job.started')).toMatchObject({ canPushTest: true });
  });

  it('the page of the event shows the example to read, no push, and a hint that names the event and says what to do instead', () => {
    const page = getEventPage(configDir, 'queue.dlq.added');
    expect(page).toMatchObject({ found: true, hasExample: true, canPushTest: false });
    expect(page.exampleText).toContain('"reason": "retries-exhausted"');
    expect(page.exampleHint).toContain('queue.dlq.added is emitted by the queue daemon itself');
    expect(page.exampleHint).toContain("'queue.' namespace is reserved");
    expect(page.exampleHint).toContain('let a delivery fail');
    // an ordinary event keeps its push and has no hint
    expect(getEventPage(configDir, 'job.started')).toMatchObject({ canPushTest: true, exampleHint: '' });
  });

  it('the hint also covers a queue.* name nobody declared', () => {
    expect(getEventPage(configDir, 'queue.other', Date.now())).toMatchObject({ found: false });
    expect(reservedPushProblem('queue.other')).toContain('queue.other is emitted by the queue daemon itself');
    expect(reservedPushProblem('queuex.other')).toBeUndefined();
    expect(reservedPushProblem('job.started')).toBeUndefined();
  });

  it('a test push of a reserved event is refused before the daemon is contacted, with or without an edited payload', async () => {
    await expect(pushTestEvent(configDir, 'queue.dlq.added')).rejects.toThrowError(ReservedEventError);
    await expect(pushTestEvent(configDir, 'queue.dlq.removed', JSON.stringify({ entryId: 'x' }))).rejects.toThrowError(/queue\.dlq\.removed is emitted by the queue daemon itself/);
    // even a name nobody declared: the namespace decides
    await expect(pushTestEvent(configDir, 'queue.anything')).rejects.toThrowError(ReservedEventError);
    expect(mockPushEvent).not.toHaveBeenCalled();
  });

  it('an ordinary event is still pushed', async () => {
    mockPushEvent.mockResolvedValue({ status: 'queued' });
    expect(await pushTestEvent(configDir, 'job.started')).toEqual({ status: 'queued' });
    expect(mockPushEvent).toHaveBeenCalledTimes(1);
  });
});
