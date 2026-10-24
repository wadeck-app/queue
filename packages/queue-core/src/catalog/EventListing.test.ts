import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSourceDeclaration } from './EventCatalog.js';
import { listEvents, listEventDetails, getEventDetail, nearestEventNames } from './EventListing.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-event-listing-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function pushes(date: string, events: Array<[string, number]>): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const lines = events.map(([event, atMs], i) => JSON.stringify({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId: `e${i}`, event, matchedCount: 0, totalCount: 0 }));
  writeFileSync(join(configDir, 'history', `${date}.ndjson`), lines.join('\n') + '\n');
}

function declare(source: string, events: Array<Record<string, unknown>>): void {
  writeSourceDeclaration(configDir, { source, events: events as never }, new Date('2026-10-24T09:00:00.000Z'));
}

describe('listEvents: the declared events and what really happened', () => {
  it('lists the declared events with their description, source and activity of the last 24 hours', () => {
    declare('orchestrator', [{ name: 'job.started', description: 'A run began.' }]);
    pushes('2026-10-24', [['job.started', NOW - 10 * MINUTE], ['job.started', NOW - 5 * MINUTE]]);
    const listing = listEvents(configDir, { nowMs: NOW });
    expect(listing.total).toBe(1);
    expect(listing.events[0]).toMatchObject({
      name: 'job.started',
      source: 'orchestrator',
      declared: true,
      description: 'A run began.',
      count24h: 2,
      lastSeenAt: new Date(NOW - 5 * MINUTE).toISOString(),
    });
  });

  it('lists the events seen in the history that nobody declared, marked undeclared, not hidden', () => {
    declare('orchestrator', [{ name: 'job.started', description: 'd' }]);
    pushes('2026-10-24', [['mystery.event', NOW - MINUTE]]);
    const mystery = listEvents(configDir, { nowMs: NOW }).events.find((event) => event.name === 'mystery.event');
    expect(mystery).toMatchObject({ declared: false, source: null, count24h: 1 });
    expect(mystery?.description).toBeUndefined();
  });

  it('a declared event that was never pushed has no last-seen time and a zero count', () => {
    declare('flow', [{ name: 'flow.step.failed', description: 'd' }]);
    expect(listEvents(configDir, { nowMs: NOW }).events[0]).toMatchObject({ count24h: 0, lastSeenAt: null });
  });

  it('keeps an event seen only a few days ago (outside the 24 h count) with its last-seen time', () => {
    pushes('2026-10-21', [['old.event', NOW - 3 * 24 * HOUR]]);
    const old = listEvents(configDir, { nowMs: NOW }).events.find((event) => event.name === 'old.event');
    expect(old).toMatchObject({ count24h: 0, lastSeenAt: new Date(NOW - 3 * 24 * HOUR).toISOString(), declared: false });
  });

  it('does not list an undeclared event that was last seen before the observation window (7 days)', () => {
    pushes('2026-10-10', [['ancient.event', NOW - 14 * 24 * HOUR]]);
    expect(listEvents(configDir, { nowMs: NOW }).events).toEqual([]);
  });

  it('carries what an agent needs to wait: terminal, outcome, correlation key, and whether a schema exists', () => {
    declare('orchestrator', [
      { name: 'job.completed', description: 'd', terminal: true, outcome: 'success', correlationKey: ['payload.jobId'], schema: { type: 'object' } },
      { name: 'job.started', description: 'd' },
    ]);
    const [completed, started] = listEvents(configDir, { nowMs: NOW }).events;
    expect(completed).toMatchObject({ name: 'job.completed', terminal: true, outcome: 'success', correlationKey: ['payload.jobId'], hasSchema: true });
    expect(started).toMatchObject({ name: 'job.started', hasSchema: false });
    expect(JSON.stringify(completed)).not.toContain('"schema"');
  });

  it('sorts by source then name, undeclared last', () => {
    declare('task', [{ name: 'onTaskCreated', description: 'd' }]);
    declare('flow', [{ name: 'flow.b', description: 'd' }, { name: 'flow.a', description: 'd' }]);
    pushes('2026-10-24', [['zzz.unknown', NOW - MINUTE]]);
    expect(listEvents(configDir, { nowMs: NOW }).events.map((event) => event.name)).toEqual(['flow.a', 'flow.b', 'onTaskCreated', 'zzz.unknown']);
  });

  it('lists the sources with when they registered and how many events they declare, and the unreadable files', () => {
    declare('flow', [{ name: 'flow.a', description: 'd' }]);
    mkdirSync(join(configDir, 'events'), { recursive: true });
    writeFileSync(join(configDir, 'events', 'broken.json'), '{ nope');
    const listing = listEvents(configDir, { nowMs: NOW });
    expect(listing.sources).toEqual([{ source: 'flow', registeredAt: '2026-10-24T09:00:00.000Z', eventCount: 1 }]);
    expect(listing.problems.map((problem) => problem.file)).toEqual(['broken.json']);
  });
});

describe('listEvents: the filters', () => {
  beforeEach(() => {
    declare('orchestrator', [
      { name: 'job.started', description: 'd' },
      { name: 'job.completed', description: 'd', terminal: true, outcome: 'success' },
      { name: 'job.failed', description: 'd', terminal: true, outcome: 'failure' },
    ]);
    declare('flow', [{ name: 'flow.step.started', description: 'd' }, { name: 'flow.step.failed', description: 'd', terminal: false }]);
    pushes('2026-10-24', [['undeclared.thing', NOW - MINUTE]]);
  });

  const names = (options: Parameters<typeof listEvents>[1]): string[] => listEvents(configDir, { nowMs: NOW, ...options }).events.map((event) => event.name);

  it('by source', () => {
    expect(names({ source: 'flow' })).toEqual(['flow.step.failed', 'flow.step.started']);
  });

  it('by name prefix', () => {
    expect(names({ prefix: 'job.' })).toEqual(['job.completed', 'job.failed', 'job.started']);
  });

  it('by subscribers.yml pattern: * is one segment, > is the rest', () => {
    expect(names({ match: 'job.*' })).toEqual(['job.completed', 'job.failed', 'job.started']);
    expect(names({ match: 'flow.>' })).toEqual(['flow.step.failed', 'flow.step.started']);
    expect(names({ match: 'flow.*' })).toEqual([]);
  });

  it('declared only, which drops the undeclared names', () => {
    expect(names({ declaredOnly: true })).not.toContain('undeclared.thing');
    expect(names({})).toContain('undeclared.thing');
  });

  it('terminal only: the events that end the thing they are about', () => {
    expect(names({ terminal: true })).toEqual(['job.completed', 'job.failed']);
  });

  it('combines the filters', () => {
    expect(names({ source: 'orchestrator', terminal: true, prefix: 'job.c' })).toEqual(['job.completed']);
  });

  it('the total is the number of events after the filters', () => {
    expect(listEvents(configDir, { nowMs: NOW, source: 'flow' }).total).toBe(2);
  });
});

describe('getEventDetail: what an agent needs to wait for the event', () => {
  const schema = {
    type: 'object',
    properties: { jobId: { type: 'string' }, durationMs: { type: 'number' }, run: { type: 'object', properties: { attempt: { type: 'integer' } } } },
    required: ['jobId'],
  };

  beforeEach(() => {
    declare('orchestrator', [{ name: 'job.completed', description: 'A run ended well.', schema, example: { jobId: 'nightly' }, correlationKey: ['payload.jobId'], terminal: true, outcome: 'success' }]);
  });

  it('returns the declaration with its schema and example', () => {
    const detail = getEventDetail(configDir, 'job.completed', NOW);
    expect(detail?.entry).toMatchObject({ name: 'job.completed', source: 'orchestrator', declared: true });
    expect(detail?.schema).toEqual(schema);
    expect(detail?.example).toEqual({ jobId: 'nightly' });
  });

  it('flattens the schema into the payload paths --when can filter on, with their type and whether they are required', () => {
    expect(getEventDetail(configDir, 'job.completed', NOW)?.filterable).toEqual([
      { path: 'payload.jobId', type: 'string', required: true },
      { path: 'payload.durationMs', type: 'number', required: false },
      { path: 'payload.run.attempt', type: 'integer', required: false },
    ]);
  });

  it('builds a ready wait command from the correlation key', () => {
    expect(getEventDetail(configDir, 'job.completed', NOW)?.waitExample).toBe('queue wait job.completed --when "payload.jobId=<jobId>" --since 5m --json');
  });

  it('builds a plain wait command when the event has no correlation key', () => {
    declare('flow', [{ name: 'flow.ping', description: 'd' }]);
    expect(getEventDetail(configDir, 'flow.ping', NOW)?.waitExample).toBe('queue wait flow.ping --since 5m --json');
  });

  it('describes an undeclared but seen event with what is known and no schema', () => {
    pushes('2026-10-24', [['seen.only', NOW - MINUTE]]);
    const detail = getEventDetail(configDir, 'seen.only', NOW);
    expect(detail?.entry).toMatchObject({ declared: false, count24h: 1 });
    expect(detail?.filterable).toEqual([]);
    expect(detail?.waitExample).toBe('queue wait seen.only --since 5m --json');
  });

  it('is undefined for a name nobody declared and nobody pushed', () => {
    expect(getEventDetail(configDir, 'nothing.here', NOW)).toBeUndefined();
  });
});

describe('nearestEventNames: "did you mean"', () => {
  const known = ['job.started', 'job.completed', 'job.failed', 'flow.step.started', 'onTaskCreated'];

  it('finds a name with a typo', () => {
    expect(nearestEventNames('job.complete', known)).toEqual(['job.completed']);
  });

  it('finds names that share the beginning, closest first', () => {
    expect(nearestEventNames('job.', known).slice(0, 3).sort()).toEqual(['job.completed', 'job.failed', 'job.started']);
  });

  it('finds a name written with the wrong case', () => {
    expect(nearestEventNames('ontaskcreated', known)).toEqual(['onTaskCreated']);
  });

  it('suggests at most three names', () => {
    expect(nearestEventNames('job', known).length).toBeLessThanOrEqual(3);
  });

  it('suggests nothing when nothing is close', () => {
    expect(nearestEventNames('completely.different.thing', known)).toEqual([]);
  });
});

describe('listEventDetails: the detail of every listed event in one pass over the history', () => {
  it('gives, for each event of the listing and in its order, the same detail getEventDetail gives', () => {
    declare('orchestrator', [{ name: 'job.completed', description: 'd', schema: { type: 'object', properties: { jobId: { type: 'string' } } }, correlationKey: 'payload.jobId', example: { jobId: 'x' } }]);
    declare('flow', [{ name: 'flow.ping', description: 'd' }]);
    pushes('2026-10-24', [['job.completed', NOW - MINUTE], ['undeclared.thing', NOW - MINUTE]]);

    const { listing, details } = listEventDetails(configDir, { nowMs: NOW });

    expect(listing.events.map((event) => event.name)).toEqual(['flow.ping', 'job.completed', 'undeclared.thing']);
    expect(details).toHaveLength(listing.events.length);
    listing.events.forEach((event, index) => {
      expect(details[index]).toEqual(getEventDetail(configDir, event.name, NOW));
    });
  });

  it('applies the filters of listEvents', () => {
    declare('flow', [{ name: 'flow.a', description: 'd' }, { name: 'flow.b', description: 'd' }]);
    const { listing, details } = listEventDetails(configDir, { nowMs: NOW, prefix: 'flow.a' });
    expect(listing.events.map((event) => event.name)).toEqual(['flow.a']);
    expect(details.map((detail) => detail.entry.name)).toEqual(['flow.a']);
  });

  it('is empty when nothing was declared or seen', () => {
    expect(listEventDetails(configDir, { nowMs: NOW })).toMatchObject({ listing: { total: 0 }, details: [] });
  });
});
