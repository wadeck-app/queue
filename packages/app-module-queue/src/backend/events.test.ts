import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSourceDeclaration } from '@wadeck-app/queue-core';

const mockPushEvent = vi.hoisted(() => vi.fn());
vi.mock('./push.js', () => ({ pushEvent: mockPushEvent }));

import { getEvents, getEventPage, pushTestEvent, validateEventPayload, excerptOf } from './events.js';
import { InvalidPayloadError, InvalidQueryError, TestPayloadNotFoundError } from './errors.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  mockPushEvent.mockReset();
  configDir = mkdtempSync(join(tmpdir(), 'app-module-events-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function declare(source: string, events: Array<Record<string, unknown>>): void {
  writeSourceDeclaration(configDir, { source, events: events as never }, new Date('2026-10-24T09:00:00.000Z'));
}

function pushes(events: Array<[string, number]>): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const lines = events.map(([event, atMs], i) => JSON.stringify({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId: `e${i}`, event, matchedCount: 0, totalCount: 0 }));
  writeFileSync(join(configDir, 'history', '2026-10-24.ndjson'), lines.join('\n') + '\n');
}

const names = (query: Record<string, string | string[]>): string[] => getEvents(configDir, query, NOW).events.map((row) => row.name);

function fixture(): void {
  declare('orchestrator', [
    { name: 'job.started', description: 'A job run began.', example: { jobId: 'nightly' } },
    { name: 'job.completed', description: 'A job run ended well.', terminal: true, outcome: 'success', correlationKey: 'payload.jobId' },
  ]);
  declare('flow', [{ name: 'flow.step.failed', description: 'A step FAILED for good.' }]);
  pushes([['job.started', NOW - 5 * MINUTE], ['mystery.event', NOW - MINUTE]]);
}

describe('getEvents', () => {
  it('answers events, total, sources and problems, undeclared names last', () => {
    fixture();
    const response = getEvents(configDir, {}, NOW);
    expect(response.events.map((row) => row.name)).toEqual(['flow.step.failed', 'job.completed', 'job.started', 'mystery.event']);
    expect(response.total).toBe(4);
    expect(response.sources.map((source) => [source.source, source.eventCount])).toEqual([['flow', 1], ['orchestrator', 2]]);
    expect(response.problems).toEqual([]);
  });

  it('keeps the raw ISO last-seen time and the 24 h count for the table', () => {
    fixture();
    const started = getEvents(configDir, {}, NOW).events.find((row) => row.name === 'job.started');
    expect(started).toMatchObject({ count24h: 1, lastSeenAt: new Date(NOW - 5 * MINUTE).toISOString() });
  });

  it('gives the last seen time as ISO to the minute, UTC, and a dash for an event not seen in the last 7 days', () => {
    fixture();
    declare('task', [{ name: 'onTaskDeleted', description: 'Never seen.' }]);
    const rows = getEvents(configDir, {}, NOW).events;
    expect(rows.find((row) => row.name === 'job.started')?.lastSeenText).toBe('2026-10-24T11:55Z');
    expect(rows.find((row) => row.name === 'onTaskDeleted')?.lastSeenText).toBe('-');
  });

  it('gives a one-line excerpt of the description for the table, and keeps the whole description for the expanded row', () => {
    declare('flow', [{ name: 'flow.a', description: 'A step began. Fires again on each retry.\n\nDoes NOT fire for a skipped step.' }]);
    const [row] = getEvents(configDir, {}, NOW).events;
    expect(row?.descriptionExcerpt).toBe('A step began.');
    expect(row?.description).toBe('A step began. Fires again on each retry.\n\nDoes NOT fire for a skipped step.');
  });

  it('marks each row declared or undeclared', () => {
    fixture();
    const rows = getEvents(configDir, {}, NOW).events;
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ['flow.step.failed', 'declared'],
      ['job.completed', 'declared'],
      ['job.started', 'declared'],
      ['mystery.event', 'undeclared'],
    ]);
  });

  it('carries the detail of the expanded row as pretty JSON, without the description (the page shows it above, as Markdown): source, last seen, terminal, outcome, correlationKey, schema, example, filterable, waitExample', () => {
    declare('orchestrator', [{ name: 'job.completed', description: 'Ended.', terminal: true, outcome: 'success', correlationKey: 'payload.jobId', schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] }, example: { jobId: 'nightly' } }]);
    const [row] = getEvents(configDir, {}, NOW).events;
    expect(row?.detailsText).toContain('\n');
    expect(JSON.parse(row!.detailsText)).toEqual({
      source: 'orchestrator',
      lastSeenAt: null,
      terminal: true,
      outcome: 'success',
      correlationKey: ['payload.jobId'],
      schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      example: { jobId: 'nightly' },
      filterable: [{ path: 'payload.jobId', type: 'string', required: true }],
      waitExample: 'queue wait job.completed --when "payload.jobId=<jobId>" --since 5m --json',
    });
  });

  it('the detail of an undeclared name says so instead of inventing a description', () => {
    pushes([['mystery.event', NOW - MINUTE]]);
    const [row] = getEvents(configDir, {}, NOW).events;
    expect(row?.status).toBe('undeclared');
    expect(JSON.parse(row!.detailsText)).toMatchObject({ source: null, filterable: [], waitExample: 'queue wait mystery.event --since 5m --json' });
  });

  it('canPushTest is true only for a declared event that has an example', () => {
    fixture();
    expect(getEvents(configDir, {}, NOW).events.map((row) => [row.name, row.canPushTest])).toEqual([
      ['flow.step.failed', false],
      ['job.completed', false],
      ['job.started', true],
      ['mystery.event', false],
    ]);
  });

  it('filters by source', () => {
    fixture();
    expect(names({ source: 'flow' })).toEqual(['flow.step.failed']);
  });

  it('filters by prefix and by subscribers.yml pattern', () => {
    fixture();
    expect(names({ prefix: 'job.' })).toEqual(['job.completed', 'job.started']);
    expect(names({ match: 'flow.>' })).toEqual(['flow.step.failed']);
  });

  it('filters declaredOnly and terminal, and a total that follows the filters', () => {
    fixture();
    expect(names({ declaredOnly: 'true' })).not.toContain('mystery.event');
    expect(names({ declaredOnly: 'false' })).toContain('mystery.event');
    expect(names({ terminal: 'true' })).toEqual(['job.completed']);
    expect(getEvents(configDir, { terminal: 'true' }, NOW).total).toBe(1);
  });

  it('filters by status', () => {
    fixture();
    expect(names({ status: 'undeclared' })).toEqual(['mystery.event']);
    expect(names({ status: 'declared' })).toEqual(['flow.step.failed', 'job.completed', 'job.started']);
  });

  it('searches q in the name and in the description, case-insensitively', () => {
    fixture();
    expect(names({ q: 'JOB.start' })).toEqual(['job.started']);
    expect(names({ q: 'failed for good' })).toEqual(['flow.step.failed']);
  });

  it('treats empty parameters as absent (the page sends them empty when a filter is cleared)', () => {
    fixture();
    expect(names({ q: '', source: '', status: '', prefix: '', match: '', declaredOnly: '', terminal: '' })).toHaveLength(4);
  });

  it('offers the declared sources as select options, whatever the filters', () => {
    fixture();
    expect(getEvents(configDir, { source: 'flow' }, NOW).sourceOptions).toEqual([
      { value: 'flow', label: 'flow' },
      { value: 'orchestrator', label: 'orchestrator' },
    ]);
  });

  it('reports an unreadable declaration file with its name, as data and as one line for the badge', () => {
    fixture();
    writeFileSync(join(configDir, 'events', 'broken.json'), '{ not json');
    const response = getEvents(configDir, {}, NOW);
    expect(response.problems).toHaveLength(1);
    expect(response.problems[0]?.file).toBe('broken.json');
    expect(response.problemsText).toContain('broken.json');
    expect(response.problemsText).toContain('not valid JSON');
    expect(response.events).toHaveLength(4);
  });

  it('has an empty problemsText when every file is readable', () => {
    fixture();
    expect(getEvents(configDir, {}, NOW).problemsText).toBe('');
  });

  it('answers an empty catalog without error', () => {
    expect(getEvents(configDir, {}, NOW)).toMatchObject({ events: [], total: 0, sources: [], sourceOptions: [], problems: [], problemsText: '' });
  });

  it.each([
    [{ declaredOnly: 'yes' }, /declaredOnly must be true or false, got: "yes"/],
    [{ terminal: '1' }, /terminal must be true or false, got: "1"/],
    [{ status: 'nope' }, /status must be declared or undeclared, got: "nope"/],
    [{ q: ['a', 'b'] }, /q must be given once, got 2 values/],
    [{ source: ['a', 'b'] }, /source must be given once/],
  ])('rejects %j with an actionable InvalidQueryError', (query, message) => {
    expect(() => getEvents(configDir, query, NOW)).toThrowError(InvalidQueryError);
    expect(() => getEvents(configDir, query, NOW)).toThrowError(message);
  });
});

describe('pushTestEvent', () => {
  it('pushes the declared example of the event through the daemon push', async () => {
    fixture();
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    const response = await pushTestEvent(configDir, 'job.started');
    expect(mockPushEvent).toHaveBeenCalledWith(configDir, 'job.started', { jobId: 'nightly' });
    expect(response).toEqual({ status: 'queued', eventId: 'e1' });
  });

  it('refuses a declared event without example, naming the fix, and pushes nothing', async () => {
    fixture();
    await expect(pushTestEvent(configDir, 'job.completed')).rejects.toThrowError(TestPayloadNotFoundError);
    await expect(pushTestEvent(configDir, 'job.completed')).rejects.toThrowError(/job\.completed declares no example.*add an "example"/);
    expect(mockPushEvent).not.toHaveBeenCalled();
  });

  it('refuses an undeclared name, with the nearest declared names', async () => {
    fixture();
    await expect(pushTestEvent(configDir, 'job.startd')).rejects.toThrowError(/job\.startd is not declared by any program.*job\.started/);
    expect(mockPushEvent).not.toHaveBeenCalled();
  });

  it('refuses an observed but undeclared name: it has no example either', async () => {
    fixture();
    await expect(pushTestEvent(configDir, 'mystery.event')).rejects.toThrowError(TestPayloadNotFoundError);
    expect(mockPushEvent).not.toHaveBeenCalled();
  });
});

describe('excerptOf (the one line of a description that fits a table cell)', () => {
  it('is the first sentence', () => {
    expect(excerptOf('A job run began. It fires once per run.')).toBe('A job run began.');
  });

  it('is the first line when the first line has no sentence end', () => {
    expect(excerptOf('A job run began\nand more')).toBe('A job run began');
  });

  it('keeps a whole short description as it is', () => {
    expect(excerptOf('Short.')).toBe('Short.');
  });

  it('cuts a long sentence at 110 characters with three dots', () => {
    const excerpt = excerptOf('word '.repeat(60).trim());
    expect(excerpt.length).toBeLessThanOrEqual(111);
    expect(excerpt.endsWith('...')).toBe(true);
  });

  it('does not cut at a dot inside a name or a number: event names and versions have dots', () => {
    expect(excerptOf('Fires for on.github.push events of version 1.2. Then more.')).toBe('Fires for on.github.push events of version 1.2.');
  });

  it('drops the Markdown marks that mean nothing in a plain cell', () => {
    expect(excerptOf('**Bold** and `code` and a [link](https://x.y). More.')).toBe('Bold and code and a link.');
    expect(excerptOf('# Title\nbody')).toBe('Title');
  });

  it('is empty for an empty or missing description', () => {
    expect(excerptOf('')).toBe('');
    expect(excerptOf(undefined)).toBe('');
  });
});

describe('getEventPage', () => {
  it('answers the parts of one event separately: description, flags, schema, example, filterable paths and the wait command', () => {
    declare('orchestrator', [
      {
        name: 'job.completed',
        description: 'A job run ended well. See `job.failed` otherwise.',
        terminal: true,
        outcome: 'success',
        correlationKey: 'payload.jobId',
        schema: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, attempts: { type: 'number' } } },
        example: { jobId: 'nightly', attempts: 1 },
      },
    ]);
    pushes([['job.completed', NOW - 5 * MINUTE]]);
    const page = getEventPage(configDir, 'job.completed', NOW);
    expect(page).toMatchObject({
      found: true,
      name: 'job.completed',
      source: 'orchestrator',
      status: 'declared',
      description: 'A job run ended well. See `job.failed` otherwise.',
      count24h: 1,
      lastSeenText: '2026-10-24T11:55Z',
      lastSeenAt: new Date(NOW - 5 * MINUTE).toISOString(),
      terminalText: 'terminal, outcome success',
      correlationKeyText: 'payload.jobId',
      sourceBadge: 'source: orchestrator',
      sourceHref: '/modules/queue/events?source=orchestrator',
      countBadge: '1 pushed in 24 h',
      lastSeenBadge: 'last seen 2026-10-24T11:55Z',
      correlationBadge: 'key: payload.jobId',
      hasSchema: true,
      hasExample: true,
      canPushTest: true,
    });
    expect(JSON.parse(page.schemaText)).toMatchObject({ type: 'object' });
    expect(JSON.parse(page.exampleText)).toEqual({ jobId: 'nightly', attempts: 1 });
    expect(page.filterable.map((field) => [field.path, field.type, field.requiredText])).toEqual([
      ['payload.jobId', 'string', 'required'],
      ['payload.attempts', 'number', 'optional'],
    ]);
    expect(page.waitExample).toContain('queue wait job.completed');
    expect(page.waitText).toBe(`\`\`\`\n${page.waitExample}\n\`\`\``);
    expect(page.historyHref).toBe('/modules/queue/history?event=job.completed');
  });

  it('is not an excerpt-of-the-list match: an event whose description only mentions the name is another event', () => {
    declare('flow', [
      { name: 'flow.execution.completed', description: 'Done.' },
      { name: 'flow.execution.failed', description: 'Failed for good; flow.execution.completed may fire later.' },
    ]);
    expect(getEventPage(configDir, 'flow.execution.completed', NOW).description).toBe('Done.');
  });

  it('describes a name seen in the history and declared by nobody as undeclared, without example or schema, and cannot push a test', () => {
    pushes([['mystery.event', NOW - MINUTE]]);
    expect(getEventPage(configDir, 'mystery.event', NOW)).toMatchObject({ found: true, status: 'undeclared', hasSchema: false, hasExample: false, canPushTest: false, count24h: 1 });
  });

  it('says nothing about being terminal when the declaration does not say, and "not terminal" only when it says false', () => {
    declare('task', [{ name: 'onTaskCreated', description: 'd' }, { name: 'onTaskTick', description: 'd', terminal: false }]);
    expect(getEventPage(configDir, 'onTaskCreated', NOW).terminalText).toBe('');
    expect(getEventPage(configDir, 'onTaskTick', NOW).terminalText).toBe('not terminal');
  });

  it('has no source badge for a name only seen in the history, and no key badge without a correlation key', () => {
    pushes([['mystery.event', NOW - MINUTE]]);
    expect(getEventPage(configDir, 'mystery.event', NOW)).toMatchObject({ sourceBadge: '', sourceHref: '', correlationBadge: '' });
  });

  it('declared without example: no test push, and the page says how to add one', () => {
    declare('flow', [{ name: 'flow.step.failed', description: 'A step failed.' }]);
    const page = getEventPage(configDir, 'flow.step.failed', NOW);
    expect(page.canPushTest).toBe(false);
    expect(page.exampleHint).toContain('example');
  });

  it('answers found: false with the closest names for an unknown name, instead of an error page', () => {
    declare('flow', [{ name: 'flow.step.failed', description: 'A step failed.' }]);
    const page = getEventPage(configDir, 'flow.step.faild', NOW);
    expect(page.found).toBe(false);
    expect(page.message).toContain("'flow.step.faild'");
    expect(page.message).toContain('flow.step.failed');
  });

  it('answers found: false with a hint when no name is given', () => {
    expect(getEventPage(configDir, '', NOW)).toMatchObject({ found: false, message: expect.stringContaining('?name=') });
  });
});

describe('validateEventPayload (the edited example, checked against the declared schema)', () => {
  const schema = { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' }, attempts: { type: 'number' } } };

  beforeEach(() => {
    declare('orchestrator', [{ name: 'job.completed', description: 'd', schema, example: { jobId: 'nightly' } }, { name: 'job.nolschema', description: 'd' }]);
  });

  it('accepts a payload that matches the schema', () => {
    const result = validateEventPayload(configDir, 'job.completed', JSON.stringify({ jobId: 'a', attempts: 2 }));
    expect(result).toMatchObject({ valid: true, errors: [] });
    expect(result.message).toContain('matches the schema');
  });

  it('lists every problem with the path of the field, not only the first', () => {
    const result = validateEventPayload(configDir, 'job.completed', JSON.stringify({ attempts: 'two' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["payload: must have required property 'jobId'", 'payload.attempts: must be number']);
    expect(result.message).toContain('2 problems');
  });

  it('refuses text that is not JSON, with the parser message, and does not look at the schema', () => {
    const result = validateEventPayload(configDir, 'job.completed', '{ "jobId": ');
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not valid JSON');
  });

  it('says the schema is missing, instead of pretending to validate, when the event declares none', () => {
    const result = validateEventPayload(configDir, 'job.nolschema', '{}');
    expect(result).toMatchObject({ valid: true, errors: [] });
    expect(result.message).toContain('declares no schema');
  });

  it('refuses a name nobody declares, with the closest names', () => {
    expect(() => validateEventPayload(configDir, 'job.completd', '{}')).toThrowError(TestPayloadNotFoundError);
    expect(() => validateEventPayload(configDir, 'job.completd', '{}')).toThrowError(/job\.completed/);
  });
});

describe('pushTestEvent with an edited payload', () => {
  const schema = { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } };

  beforeEach(() => {
    declare('orchestrator', [{ name: 'job.completed', description: 'd', schema, example: { jobId: 'nightly' } }]);
  });

  it('pushes the edited payload instead of the declared example', async () => {
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    await pushTestEvent(configDir, 'job.completed', JSON.stringify({ jobId: 'mine' }));
    expect(mockPushEvent).toHaveBeenCalledWith(configDir, 'job.completed', { jobId: 'mine' });
  });

  it('refuses a payload that does not match the schema, naming the problems, and pushes nothing (the page is not trusted)', async () => {
    await expect(pushTestEvent(configDir, 'job.completed', JSON.stringify({ jobId: 3 }))).rejects.toThrowError(InvalidPayloadError);
    await expect(pushTestEvent(configDir, 'job.completed', JSON.stringify({ jobId: 3 }))).rejects.toThrowError(/payload.jobId: must be string/);
    expect(mockPushEvent).not.toHaveBeenCalled();
  });

  it('refuses text that is not JSON and pushes nothing', async () => {
    await expect(pushTestEvent(configDir, 'job.completed', 'nope')).rejects.toThrowError(InvalidPayloadError);
    expect(mockPushEvent).not.toHaveBeenCalled();
  });
});
