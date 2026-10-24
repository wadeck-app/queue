import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSourceDeclaration, writeSourceDeclaration, readCatalog, MAX_EVENTS_PER_SOURCE } from './EventCatalog.js';

const valid = (overrides: Record<string, unknown> = {}) => ({
  source: 'orchestrator',
  events: [{ name: 'job.started', description: 'A job run began.' }],
  ...overrides,
});

function problemsOf(input: unknown): Array<{ path: string; message: string }> {
  const result = validateSourceDeclaration(input);
  if (result.ok) {
    throw new Error('expected the declaration to be rejected');
  }
  return result.problems;
}

describe('validateSourceDeclaration: what is accepted', () => {
  it('accepts a source with events that have a name and a description', () => {
    expect(validateSourceDeclaration(valid())).toEqual({ ok: true, declaration: { source: 'orchestrator', events: [{ name: 'job.started', description: 'A job run began.' }] } });
  });

  it('keeps the optional fields: schema, example, correlation key, terminal and outcome', () => {
    const event = {
      name: 'job.completed',
      description: 'A job run ended well. Fires once per run.',
      schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
      example: { jobId: 'nightly' },
      correlationKey: 'payload.jobId',
      terminal: true,
      outcome: 'success',
    };
    const result = validateSourceDeclaration(valid({ events: [event] }));
    expect(result).toEqual({ ok: true, declaration: { source: 'orchestrator', events: [{ ...event, correlationKey: ['payload.jobId'] }] } });
  });

  it('accepts a list of correlation keys', () => {
    const result = validateSourceDeclaration(valid({ events: [{ name: 'flow.step.started', description: 'd', correlationKey: ['payload.executionId', 'payload.stepId'] }] }));
    expect(result).toMatchObject({ ok: true, declaration: { events: [{ correlationKey: ['payload.executionId', 'payload.stepId'] }] } });
  });

  it('accepts an empty list of events: a source that declares nothing any more', () => {
    expect(validateSourceDeclaration(valid({ events: [] }))).toMatchObject({ ok: true });
  });

  it('ignores a field it does not know, so a newer SDK can add one without breaking an older daemon', () => {
    const result = validateSourceDeclaration(valid({ events: [{ name: 'a.b', description: 'd', futureField: 1 }], futureTopLevel: true }));
    expect(result).toEqual({ ok: true, declaration: { source: 'orchestrator', events: [{ name: 'a.b', description: 'd' }] } });
  });

  it('accepts the event names the products use', () => {
    for (const name of ['on.github.workflow_run', 'onTaskCreated', 'flow.step.started', 'job.timed_out', 'a-b.c_d']) {
      expect(validateSourceDeclaration(valid({ events: [{ name, description: 'd' }] })), name).toMatchObject({ ok: true });
    }
  });
});

describe('validateSourceDeclaration: what is refused, with the path of the problem', () => {
  it.each([
    ['not an object', 'text', [{ path: '', message: 'the declaration must be an object { source, events }' }]],
    ['a missing source', { events: [] }, [{ path: 'source', message: 'source is required' }]],
    ['an upper-case source', valid({ source: 'Orchestrator' }), [{ path: 'source', message: expect.stringContaining('lower case') }]],
    ['a source with a slash', valid({ source: 'a/b' }), [{ path: 'source', message: expect.stringContaining('lower case') }]],
    ['a source that is too long', valid({ source: 'a'.repeat(65) }), [{ path: 'source', message: expect.stringContaining('64') }]],
    ['events that are not a list', valid({ events: {} }), [{ path: 'events', message: 'events must be a list' }]],
  ])('%s', (_label, input, expected) => {
    expect(problemsOf(input)).toEqual(expected);
  });

  it.each([
    ['a missing name', { description: 'd' }, 'events[0].name', 'name is required'],
    ['a name with a space', { name: 'job started', description: 'd' }, 'events[0].name', 'dot-separated'],
    ['a name with an empty segment', { name: 'job..started', description: 'd' }, 'events[0].name', 'dot-separated'],
    ['a name that is too long', { name: 'a'.repeat(129), description: 'd' }, 'events[0].name', '128'],
    ['a missing description', { name: 'a.b' }, 'events[0].description', 'description is required'],
    ['an empty description', { name: 'a.b', description: '  ' }, 'events[0].description', 'description is required'],
    ['a description that is too long', { name: 'a.b', description: 'd'.repeat(501) }, 'events[0].description', '500'],
    ['a schema that is not an object', { name: 'a.b', description: 'd', schema: 'string' }, 'events[0].schema', 'JSON Schema object'],
    ['a schema that is too big', { name: 'a.b', description: 'd', schema: { x: 'y'.repeat(70_000) } }, 'events[0].schema', '64 KB'],
    ['an example that is too big', { name: 'a.b', description: 'd', example: 'y'.repeat(20_000) }, 'events[0].example', '16 KB'],
    ['a correlation key that is not a payload path', { name: 'a.b', description: 'd', correlationKey: 'jobId' }, 'events[0].correlationKey', 'payload.'],
    ['a terminal that is not a boolean', { name: 'a.b', description: 'd', terminal: 'yes' }, 'events[0].terminal', 'boolean'],
    ['an unknown outcome', { name: 'a.b', description: 'd', outcome: 'good' }, 'events[0].outcome', 'success, failure or info'],
  ])('%s', (_label, event, path, fragment) => {
    const problems = problemsOf(valid({ events: [event] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe(path);
    expect(problems[0]?.message).toContain(fragment);
  });

  it('refuses the same name declared twice in a source, at the second one', () => {
    const problems = problemsOf(valid({ events: [{ name: 'a.b', description: 'd' }, { name: 'a.b', description: 'd2' }] }));
    expect(problems).toEqual([{ path: 'events[1].name', message: expect.stringContaining('already declared') }]);
  });

  it(`refuses more than ${MAX_EVENTS_PER_SOURCE} events`, () => {
    const events = Array.from({ length: MAX_EVENTS_PER_SOURCE + 1 }, (_, i) => ({ name: `e.n${i}`, description: 'd' }));
    expect(problemsOf(valid({ events }))).toEqual([{ path: 'events', message: expect.stringContaining(String(MAX_EVENTS_PER_SOURCE)) }]);
  });

  it('reports every problem at once, so one round trip fixes them all', () => {
    const problems = problemsOf(valid({ events: [{ name: 'bad name', description: '' }, { name: 'ok.name', description: 'd', outcome: 'x' }] }));
    expect(problems.map((problem) => problem.path)).toEqual(['events[0].name', 'events[0].description', 'events[1].outcome']);
  });
});

describe('the store of the declarations', () => {
  let configDir: string;
  const declaration = (source: string, names: string[]) => ({ source, events: names.map((name) => ({ name, description: `${name} description` })) });

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'queue-event-catalog-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('is empty when nothing was declared', () => {
    expect(readCatalog(configDir)).toEqual({ sources: [], problems: [] });
  });

  it('stores one file per source and reads them back, sorted by source, with the time of the registration', () => {
    writeSourceDeclaration(configDir, declaration('task', ['onTaskCreated']), new Date('2026-10-24T10:00:00.000Z'));
    writeSourceDeclaration(configDir, declaration('flow', ['flow.step.started', 'flow.step.failed']), new Date('2026-10-24T11:00:00.000Z'));
    expect(readdirSync(join(configDir, 'events')).sort()).toEqual(['flow.json', 'task.json']);
    const catalog = readCatalog(configDir);
    expect(catalog.problems).toEqual([]);
    expect(catalog.sources.map((source) => [source.source, source.registeredAt, source.events.length])).toEqual([
      ['flow', '2026-10-24T11:00:00.000Z', 2],
      ['task', '2026-10-24T10:00:00.000Z', 1],
    ]);
  });

  it('a new registration replaces everything the same source declared before, and leaves the others alone', () => {
    writeSourceDeclaration(configDir, declaration('flow', ['flow.old']), new Date('2026-10-24T10:00:00.000Z'));
    writeSourceDeclaration(configDir, declaration('task', ['onTaskCreated']), new Date('2026-10-24T10:00:00.000Z'));
    writeSourceDeclaration(configDir, declaration('flow', ['flow.new']), new Date('2026-10-24T12:00:00.000Z'));
    const catalog = readCatalog(configDir);
    expect(catalog.sources.find((source) => source.source === 'flow')?.events.map((event) => event.name)).toEqual(['flow.new']);
    expect(catalog.sources.find((source) => source.source === 'task')?.events).toHaveLength(1);
  });

  it('leaves no temporary file behind', () => {
    writeSourceDeclaration(configDir, declaration('flow', ['a.b']), new Date());
    expect(readdirSync(join(configDir, 'events'))).toEqual(['flow.json']);
  });

  it('reports a file it cannot read and still returns the others, instead of hiding the problem', () => {
    writeSourceDeclaration(configDir, declaration('flow', ['a.b']), new Date());
    writeFileSync(join(configDir, 'events', 'broken.json'), '{ nope');
    writeFileSync(join(configDir, 'events', 'shape.json'), JSON.stringify({ source: 'shape' }));
    const catalog = readCatalog(configDir);
    expect(catalog.sources.map((source) => source.source)).toEqual(['flow']);
    expect(catalog.problems.map((problem) => problem.file).sort()).toEqual(['broken.json', 'shape.json']);
    expect(catalog.problems.find((problem) => problem.file === 'broken.json')?.message).toContain('not valid JSON');
  });

  it('ignores files that are not declarations', () => {
    mkdirSync(join(configDir, 'events'));
    writeFileSync(join(configDir, 'events', 'notes.txt'), 'hello');
    expect(readCatalog(configDir)).toEqual({ sources: [], problems: [] });
  });

  it('writes pretty JSON a person can read and diff', () => {
    writeSourceDeclaration(configDir, declaration('flow', ['a.b']), new Date('2026-10-24T10:00:00.000Z'));
    expect(readFileSync(join(configDir, 'events', 'flow.json'), 'utf8')).toContain('\n  "source": "flow"');
  });
});
