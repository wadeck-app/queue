import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSourceDeclaration, type RegisterEventsRequest, type RegisterEventsResponse } from '@wadeck-app/queue-core';
import { eventsCommand, EVENTS_EXIT, EVENTS_HELP, type EventsDeps, type RegisterResult } from './eventsCli.js';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-events-cli-'));
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

interface Run { code: number; out: string; err: string; sent: RegisterEventsRequest[] }

async function run(args: string[], options: { files?: Record<string, string>; registerResult?: RegisterResult } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const sent: RegisterEventsRequest[] = [];
  const deps: EventsDeps = {
    configDir,
    io: { stdout: { write: (s) => { out.push(s); } }, stderr: { write: (s) => { err.push(s); } } },
    now: () => NOW,
    readFile: (path) => {
      const content = options.files?.[path];
      if (content === undefined) {
        throw new Error(`ENOENT: no such file ${path}`);
      }
      return content;
    },
    register: async (request) => {
      sent.push(request);
      return options.registerResult ?? { kind: 'response', response: { status: 'registered', source: request.source, count: request.events.length } };
    },
    protocolVersion: '9.8.7',
  };
  const code = await eventsCommand(args, deps);
  return { code, out: out.join(''), err: err.join(''), sent };
}

function seed(): void {
  declare('orchestrator', [
    { name: 'job.completed', description: 'A job finished.', terminal: true, outcome: 'success', correlationKey: ['payload.jobId'], schema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] }, example: { jobId: 'j1' } },
    { name: 'job.started', description: 'A job began.' },
  ]);
  declare('flow', [{ name: 'flow.step.failed', description: 'A step failed.' }]);
  pushes([['job.completed', NOW - 10 * MINUTE], ['job.completed', NOW - 5 * MINUTE], ['mystery.event', NOW - MINUTE]]);
}

describe('queue events (general)', () => {
  it('without a subcommand prints the help and fails as a usage error', async () => {
    const result = await run([]);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    expect(result.out).toContain('queue events list');
  });

  it('--help prints the help and succeeds', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(EVENTS_EXIT.OK);
    expect(result.out).toBe(EVENTS_HELP);
  });

  it('an unknown subcommand is a usage error that names the valid ones', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    expect(result.err).toContain('list, show, register');
  });
});

describe('queue events list', () => {
  it('prints a table with the name, source, count of the last 24 hours, last seen, and a marker on undeclared events', async () => {
    seed();
    const result = await run(['list']);
    expect(result.code).toBe(EVENTS_EXIT.OK);
    const completed = result.out.split('\n').find((line) => line.startsWith('job.completed'))!;
    expect(completed).toContain('orchestrator');
    expect(completed).toMatch(/\s2\s/);
    expect(completed).toContain('5m ago');
    expect(completed).not.toContain('undeclared');
    const mystery = result.out.split('\n').find((line) => line.startsWith('mystery.event'))!;
    expect(mystery).toContain('(undeclared)');
    expect(result.out).toMatch(/^NAME\s+SOURCE\s+24H\s+LAST SEEN/m);
  });

  it('says "not seen in 7 days" for a declared event with no recent push', async () => {
    seed();
    const result = await run(['list']);
    const started = result.out.split('\n').find((line) => line.startsWith('job.started'))!;
    expect(started).toContain('not in 7d');
  });

  it('--json prints { events, total, sources, problems } without any schema', async () => {
    seed();
    const result = await run(['list', '--json']);
    const parsed = JSON.parse(result.out) as { events: Array<Record<string, unknown>>; total: number; sources: unknown[]; problems: unknown[] };
    expect(Object.keys(parsed).sort()).toEqual(['events', 'problems', 'sources', 'total']);
    expect(parsed.total).toBe(4);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.events.find((event) => event['name'] === 'job.completed')).toMatchObject({ source: 'orchestrator', declared: true, terminal: true, count24h: 2, hasSchema: true });
    expect(JSON.stringify(parsed)).not.toContain('"properties"');
  });

  it('--source, --prefix, --match, --declared-only and --terminal narrow the list', async () => {
    seed();
    const names = async (...args: string[]): Promise<string[]> => (JSON.parse((await run(['list', '--json', ...args])).out) as { events: Array<{ name: string }> }).events.map((event) => event.name);
    expect(await names('--source', 'flow')).toEqual(['flow.step.failed']);
    expect(await names('--prefix', 'job.')).toEqual(['job.completed', 'job.started']);
    expect(await names('--match', 'flow.>')).toEqual(['flow.step.failed']);
    expect(await names('--declared-only')).not.toContain('mystery.event');
    expect(await names('--terminal')).toEqual(['job.completed']);
  });

  it('--match refuses a ** segment (not a wildcard) with exit 4 and points to >', async () => {
    seed();
    const result = await run(['list', '--match', 'flow.**']);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    expect(result.err).toContain('--match "flow.**": "**" is not a wildcard, use ">"');
    expect(result.err).toContain('instead: "flow.>"');
    expect(result.out).toBe('');
  });

  it('prints each unreadable catalog file as a warning on stderr and still exits 0', async () => {
    seed();
    writeFileSync(join(configDir, 'events', 'broken.json'), '{ not json');
    const result = await run(['list']);
    expect(result.code).toBe(EVENTS_EXIT.OK);
    expect(result.err).toContain('[warn] events/broken.json');
    expect(result.err).toContain('not valid JSON');
    expect(JSON.parse((await run(['list', '--json'])).out)).toMatchObject({ problems: [{ file: 'broken.json' }] });
  });

  it('with nothing declared and nothing seen, explains how a program declares its events', async () => {
    const result = await run(['list']);
    expect(result.code).toBe(EVENTS_EXIT.OK);
    expect(result.out).toContain('No events');
    expect(result.out).toContain('queue events register');
  });

  it('a filter flag without a value is a usage error', async () => {
    const result = await run(['list', '--source']);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    expect(result.err).toContain('--source needs a value');
  });

  it('warns about an unknown flag instead of ignoring it silently', async () => {
    seed();
    const result = await run(['list', '--sourse', 'flow']);
    expect(result.err).toContain('--sourse');
  });
});

describe('queue events show', () => {
  it('prints the description, source, outcome, correlation key, schema, example, filterable paths and the wait example', async () => {
    seed();
    const result = await run(['show', 'job.completed']);
    expect(result.code).toBe(EVENTS_EXIT.OK);
    expect(result.out).toContain('job.completed');
    expect(result.out).toContain('A job finished.');
    expect(result.out).toContain('orchestrator');
    expect(result.out).toMatch(/terminal:\s+yes \(success\)/);
    expect(result.out).toContain('payload.jobId');
    expect(result.out).toContain('"type": "object"');
    expect(result.out).toContain('"jobId": "j1"');
    expect(result.out).toMatch(/payload\.jobId\s+string\s+required/);
    expect(result.out).toContain('queue wait job.completed --when "payload.jobId=<jobId>" --since 5m --json');
  });

  it('--json prints the EventDetail', async () => {
    seed();
    const result = await run(['show', 'job.completed', '--json']);
    const parsed = JSON.parse(result.out) as { entry: { name: string }; schema: unknown; example: unknown; filterable: unknown[]; waitExample: string };
    expect(parsed.entry.name).toBe('job.completed');
    expect(parsed.filterable).toEqual([{ path: 'payload.jobId', type: 'string', required: true }]);
    expect(parsed.waitExample).toContain('queue wait job.completed');
    expect(parsed.example).toEqual({ jobId: 'j1' });
  });

  it('an undeclared event seen in the history is shown, flagged as undeclared', async () => {
    seed();
    const result = await run(['show', 'mystery.event']);
    expect(result.code).toBe(EVENTS_EXIT.OK);
    expect(result.out).toContain('not declared by any program');
  });

  it('an unknown name exits 4 with the nearest names on stderr', async () => {
    seed();
    const result = await run(['show', 'job.complete']);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    expect(result.err).toContain('did you mean');
    expect(result.err).toContain('job.completed');
    expect(result.out).toBe('');
  });

  it('an unknown name with --json prints { found: false, suggestions } on stdout', async () => {
    seed();
    const result = await run(['show', 'job.complete', '--json']);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    const parsed = JSON.parse(result.out) as { found: boolean; suggestions: string[] };
    expect(parsed.found).toBe(false);
    expect(parsed.suggestions).toContain('job.completed');
  });

  it('an unknown name with nothing similar points to "queue events list"', async () => {
    seed();
    const result = await run(['show', 'zzzzzzzzzz']);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    expect(result.err).toContain('queue events list');
    expect(result.err).not.toContain('did you mean');
  });

  it('without a name is a usage error', async () => {
    const result = await run(['show']);
    expect(result.code).toBe(EVENTS_EXIT.USAGE);
    expect(result.err).toContain('queue events show <name>');
  });
});

describe('queue events register', () => {
  const file = 'events.json';
  const events = [{ name: 'a.b', description: 'd' }, { name: 'a.c', description: 'd' }];

  it('sends { protocol, source, events } read from { "events": [...] } and reports the count', async () => {
    const result = await run(['register', '--source', 'tool', '--file', file], { files: { [file]: JSON.stringify({ events }) } });
    expect(result.code).toBe(EVENTS_EXIT.OK);
    expect(result.sent).toEqual([{ protocol: '9.8.7', source: 'tool', events }]);
    expect(result.out).toBe('registered 2 events for tool\n');
  });

  it('accepts a bare array and says "1 event" in the singular', async () => {
    const result = await run(['register', '--source', 'tool', '--file', file], { files: { [file]: JSON.stringify([events[0]]) } });
    expect(result.sent[0]!.events).toEqual([events[0]]);
    expect(result.out).toBe('registered 1 event for tool\n');
  });

  it('prints each rejected problem as "path: message" and exits 1', async () => {
    const response: RegisterEventsResponse = { status: 'rejected', reason: 'invalid', problems: [{ path: 'events[0].name', message: 'name is required' }, { path: 'source', message: 'bad' }] };
    const result = await run(['register', '--source', 'tool', '--file', file], { files: { [file]: '[]' }, registerResult: { kind: 'response', response } });
    expect(result.code).toBe(EVENTS_EXIT.FAILED);
    expect(result.err).toContain('events[0].name: name is required');
    expect(result.err).toContain('source: bad');
    expect(result.out).toBe('');
  });

  it('a rejection without problems (protocol) prints the reason and the supported version', async () => {
    const response: RegisterEventsResponse = { status: 'rejected', reason: 'protocol too new', supported: '1.1.0' };
    const result = await run(['register', '--source', 'tool', '--file', file], { files: { [file]: '[]' }, registerResult: { kind: 'response', response } });
    expect(result.code).toBe(EVENTS_EXIT.FAILED);
    expect(result.err).toContain('protocol too new');
    expect(result.err).toContain('1.1.0');
  });

  it('an older daemon (unknown command) tells to update queue-cli and restart the daemon', async () => {
    const result = await run(['register', '--source', 'tool', '--file', file], { files: { [file]: '[]' }, registerResult: { kind: 'unsupported' } });
    expect(result.code).toBe(EVENTS_EXIT.FAILED);
    expect(result.err).toContain('queue cli update');
    expect(result.err).toContain('queue stop');
  });

  it('--json prints the outcome on stdout', async () => {
    const ok = await run(['register', '--source', 'tool', '--file', file, '--json'], { files: { [file]: JSON.stringify(events) } });
    expect(JSON.parse(ok.out)).toEqual({ registered: true, source: 'tool', count: 2 });
    const response: RegisterEventsResponse = { status: 'rejected', reason: 'invalid', problems: [{ path: 'source', message: 'bad' }] };
    const ko = await run(['register', '--source', 'tool', '--file', file, '--json'], { files: { [file]: '[]' }, registerResult: { kind: 'response', response } });
    expect(ko.code).toBe(EVENTS_EXIT.FAILED);
    expect(JSON.parse(ko.out)).toEqual({ registered: false, reason: 'invalid', problems: [{ path: 'source', message: 'bad' }] });
  });

  it('a missing --source or --file is a usage error and nothing is sent', async () => {
    const noSource = await run(['register', '--file', file], { files: { [file]: '[]' } });
    expect(noSource.code).toBe(EVENTS_EXIT.USAGE);
    expect(noSource.err).toContain('--source');
    const noFile = await run(['register', '--source', 'tool']);
    expect(noFile.code).toBe(EVENTS_EXIT.USAGE);
    expect(noFile.err).toContain('--file');
    expect(noSource.sent.length + noFile.sent.length).toBe(0);
  });

  it('an unreadable file or invalid JSON exits 1 with the cause and sends nothing', async () => {
    const missing = await run(['register', '--source', 'tool', '--file', 'nope.json']);
    expect(missing.code).toBe(EVENTS_EXIT.FAILED);
    expect(missing.err).toContain('nope.json');
    expect(missing.err).toContain('ENOENT');
    const invalid = await run(['register', '--source', 'tool', '--file', file], { files: { [file]: '{ nope' } });
    expect(invalid.code).toBe(EVENTS_EXIT.FAILED);
    expect(invalid.err).toContain('not valid JSON');
    const wrongShape = await run(['register', '--source', 'tool', '--file', file], { files: { [file]: '{"name":"x"}' } });
    expect(wrongShape.code).toBe(EVENTS_EXIT.FAILED);
    expect(wrongShape.err).toContain('"events"');
    expect(missing.sent.length + invalid.sent.length + wrongShape.sent.length).toBe(0);
  });
});
