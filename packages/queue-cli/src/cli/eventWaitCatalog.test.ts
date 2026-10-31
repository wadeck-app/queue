import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSourceDeclaration } from '@wadeck-app/queue-core';
import { checkDeclaration, lastSeenAtOf, lastSeenEventOf, patternMatchesKnownEvent, patternWarning, refuseUndeclared, undeclaredWarning } from './eventWaitCatalog.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-wait-catalog-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function declare(source: string, names: string[]): void {
  writeSourceDeclaration(configDir, { source, events: names.map((name) => ({ name, description: 'd' })) }, new Date('2026-10-24T09:00:00.000Z'));
}

function pushes(events: Array<[string, number]>): void {
  mkdirSync(join(configDir, 'history'), { recursive: true });
  const lines = events.map(([event, atMs], i) => JSON.stringify({ ts: new Date(atMs).toISOString(), type: 'trigger', eventId: `e${i}`, event, matchedCount: 0, totalCount: 0 }));
  writeFileSync(join(configDir, 'history', '2026-10-24.ndjson'), lines.join('\n') + '\n');
}

describe('checkDeclaration', () => {
  it('a declared name is declared, with no suggestions', () => {
    declare('orchestrator', ['job.completed']);
    expect(checkDeclaration(configDir, 'job.completed', NOW)).toEqual({ declared: true, suggestions: [], catalogEmpty: false });
  });

  it('a typo is undeclared and suggests the nearest declared names', () => {
    declare('orchestrator', ['job.completed', 'job.started']);
    const check = checkDeclaration(configDir, 'job.complete', NOW);
    expect(check.declared).toBe(false);
    expect(check.catalogEmpty).toBe(false);
    expect(check.suggestions).toContain('job.completed');
  });

  it('a name only seen in the history is undeclared (and never suggested to itself)', () => {
    declare('orchestrator', ['job.completed']);
    pushes([['mystery.event', NOW - 1000]]);
    const check = checkDeclaration(configDir, 'mystery.event', NOW);
    expect(check.declared).toBe(false);
    expect(check.suggestions).not.toContain('mystery.event');
  });

  it('with no source declared the catalog is empty and nothing is suggested', () => {
    pushes([['mystery.event', NOW - 1000]]);
    expect(checkDeclaration(configDir, 'mystery.event', NOW)).toEqual({ declared: false, suggestions: [], catalogEmpty: true });
  });
});

describe('lastSeenAtOf', () => {
  it('is the time of the last push of that name in the last 7 days', () => {
    pushes([['job.completed', NOW - 60_000], ['job.completed', NOW - 10_000]]);
    expect(lastSeenAtOf(configDir, 'job.completed', NOW)).toBe(new Date(NOW - 10_000).toISOString());
  });

  it('is null for a name that was not pushed in the last 7 days', () => {
    pushes([['job.completed', NOW - 60_000]]);
    expect(lastSeenAtOf(configDir, 'job.complete', NOW)).toBeNull();
  });
});

describe('lastSeenAtOf / lastSeenEventOf with a pattern', () => {
  it('is the latest push among the matching names (the list is not sorted by time)', () => {
    pushes([['dep.a', NOW - 10_000], ['dep.b', NOW - 60_000], ['dep.a.b', NOW - 1000], ['other', NOW - 500]]);
    expect(lastSeenAtOf(configDir, 'dep.*', NOW)).toBe(new Date(NOW - 10_000).toISOString());
    expect(lastSeenEventOf(configDir, 'dep.*', NOW)).toBe('dep.a');
    expect(lastSeenEventOf(configDir, 'dep.>', NOW)).toBe('dep.a.b');
  });

  it('is null when no name matches', () => {
    pushes([['other', NOW - 1000]]);
    expect(lastSeenAtOf(configDir, 'dep.*', NOW)).toBeNull();
    expect(lastSeenEventOf(configDir, 'dep.*', NOW)).toBeNull();
  });
});

describe('patternMatchesKnownEvent / patternWarning', () => {
  it('a declared name that was never pushed counts as known', () => {
    declare('orchestrator', ['dep.published.api']);
    expect(patternMatchesKnownEvent(configDir, 'dep.published.*', NOW)).toEqual({ known: true, catalogEmpty: false });
  });

  it('a name only seen in the history counts as known', () => {
    declare('orchestrator', ['job.completed']);
    pushes([['dep.published.web', NOW - 1000]]);
    expect(patternMatchesKnownEvent(configDir, 'dep.>', NOW).known).toBe(true);
  });

  it('no match is unknown, and the catalog is not empty', () => {
    declare('orchestrator', ['job.completed']);
    expect(patternMatchesKnownEvent(configDir, 'dep.*', NOW)).toEqual({ known: false, catalogEmpty: false });
  });

  it('no source and no history is an empty catalog', () => {
    expect(patternMatchesKnownEvent(configDir, 'dep.*', NOW)).toEqual({ known: false, catalogEmpty: true });
  });

  it('the warning is a [warn] naming the pattern, the empty catalog gives a softer [info]', () => {
    expect(patternWarning('dep.*', { known: false, catalogEmpty: false })).toMatch(/^\[warn\] no known event matches "dep\.\*"/);
    expect(patternWarning('dep.*', { known: false, catalogEmpty: true })).toMatch(/^\[info\] /);
  });
});

describe('undeclaredWarning', () => {
  it('names the event and the suggestions', () => {
    expect(undeclaredWarning('job.complete', { declared: false, suggestions: ['job.completed', 'job.started'], catalogEmpty: false }))
      .toBe('[warn] "job.complete" is not declared by any program; did you mean: job.completed, job.started');
  });

  it('without suggestions, says nothing similar is declared and points to the list', () => {
    const line = undeclaredWarning('zzz', { declared: false, suggestions: [], catalogEmpty: false });
    expect(line).toContain('"zzz" is not declared by any program');
    expect(line).toContain('queue events list');
    expect(line).not.toContain('did you mean');
  });

  it('with an empty catalog, one line saying no program declared its events yet', () => {
    const line = undeclaredWarning('zzz', { declared: false, suggestions: [], catalogEmpty: true });
    expect(line).toBe('[warn] No program declared its events yet, so "zzz" cannot be checked (see "queue events --help").');
  });
});

describe('refuseUndeclared (--strict)', () => {
  function refuse(json: boolean, check: Parameters<typeof undeclaredWarning>[1]): { code: number; out: string; err: string } {
    const out: string[] = [];
    const err: string[] = [];
    const code = refuseUndeclared('job.complete', check, json, { stdout: { write: (s) => { out.push(s); } }, stderr: { write: (s) => { err.push(s); } } });
    return { code, out: out.join(''), err: err.join('') };
  }

  it('exits 4 at once with the suggestions on stderr', () => {
    const result = refuse(false, { declared: false, suggestions: ['job.completed'], catalogEmpty: false });
    expect(result.code).toBe(4);
    expect(result.err).toContain('did you mean: job.completed');
    expect(result.err).toContain('--strict');
    expect(result.out).toBe('');
  });

  it('with --json also prints { matched: false, declared: false, suggestions } on stdout', () => {
    const result = refuse(true, { declared: false, suggestions: ['job.completed'], catalogEmpty: false });
    expect(JSON.parse(result.out)).toEqual({ matched: false, declared: false, suggestions: ['job.completed'], event: 'job.complete' });
  });

  it('with an empty catalog it still refuses, and says why', () => {
    const result = refuse(false, { declared: false, suggestions: [], catalogEmpty: true });
    expect(result.code).toBe(4);
    expect(result.err).toContain('No program declared its events yet');
  });
});
