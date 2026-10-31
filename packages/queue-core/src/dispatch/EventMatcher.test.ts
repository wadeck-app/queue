import { describe, it, expect } from 'vitest';
import { EventMatcher, isEventPattern, eventPatternProblem, doubleStarProblem } from './EventMatcher.js';

describe('isEventPattern', () => {
  it('is true when a segment is exactly * or >', () => {
    for (const s of ['*', '>', 'dep.*', 'dep.>', '*.published', 'a.*.c']) {
      expect(isEventPattern(s), s).toBe(true);
    }
  });

  it('is false for a concrete name, and for a wildcard that is only part of a segment', () => {
    for (const s of ['dep.published', 'on.github.workflow_run', 'foo*', 'a.b>', '**', 'dep.**', '']) {
      expect(isEventPattern(s), s).toBe(false);
    }
  });
});

describe('eventPatternProblem', () => {
  it('accepts concrete names and well-formed patterns', () => {
    for (const s of ['dep.published', 'dep.*', 'dep.>', '>', '*', '*.published', 'a.*.c', 'a.*.>']) {
      expect(eventPatternProblem(s), s).toBeNull();
    }
  });

  it('rejects a wildcard mixed with other characters', () => {
    expect(eventPatternProblem('foo*')).toContain('whole segment');
    expect(eventPatternProblem('dep.a>')).toContain('whole segment');
    expect(eventPatternProblem('dep.***')).toContain('whole segment');
  });

  it('rejects an empty segment', () => {
    expect(eventPatternProblem('dep..*')).toContain('empty segment');
    expect(eventPatternProblem('.*')).toContain('empty segment');
    expect(eventPatternProblem('dep.*.')).toContain('empty segment');
  });

  it('rejects > that is not the last segment', () => {
    expect(eventPatternProblem('dep.>.x')).toContain('must be the last');
  });

  it('rejects a ** segment and says to use >', () => {
    expect(eventPatternProblem('**')).toBe('"**": "**" is not a wildcard, use ">" (the rest of the segments) instead: ">".');
    expect(eventPatternProblem('dep.**')).toContain('instead: "dep.>"');
    expect(eventPatternProblem('**.x')).toContain('instead: ">.x"');
  });
});

describe('EventMatcher', () => {
  it('exact match: ticket.created matches ticket.created', () => {
    expect(EventMatcher.matches('ticket.created', 'ticket.created')).toBe(true);
  });

  it('exact match: ticket.created does not match ticket.updated', () => {
    expect(EventMatcher.matches('ticket.created', 'ticket.updated')).toBe(false);
  });

  it('single wildcard * matches one segment', () => {
    expect(EventMatcher.matches('ticket.*', 'ticket.created')).toBe(true);
    expect(EventMatcher.matches('ticket.*', 'ticket.updated')).toBe(true);
  });

  it('single wildcard * does NOT match multiple segments', () => {
    expect(EventMatcher.matches('ticket.*', 'ticket.sub.event')).toBe(false);
  });

  it('** is not a wildcard: it is a literal segment, refused loudly elsewhere', () => {
    expect(EventMatcher.matches('ticket.**', 'ticket.created')).toBe(false);
    expect(EventMatcher.matches('ticket.**', 'ticket.a.b.c')).toBe(false);
    expect(EventMatcher.matches('**', 'anything.here')).toBe(false);
  });

  it('> wildcard matches any depth', () => {
    expect(EventMatcher.matches('ticket.>', 'ticket.created')).toBe(true);
    expect(EventMatcher.matches('ticket.>', 'ticket.sub.event')).toBe(true);
  });

  it('dep.> and dep.* need at least one segment after dep', () => {
    expect(EventMatcher.matches('dep.>', 'dep')).toBe(false);
    expect(EventMatcher.matches('dep.*', 'dep')).toBe(false);
  });

  it('*.published matches one leading segment only (docs/wait.md table)', () => {
    expect(EventMatcher.matches('*.published', 'dep.published')).toBe(true);
    expect(EventMatcher.matches('*.published', 'published')).toBe(false);
    expect(EventMatcher.matches('*.published', 'a.b.published')).toBe(false);
  });

  it('standalone > matches everything', () => {
    expect(EventMatcher.matches('>', 'foo.bar.baz')).toBe(true);
  });
});

describe('doubleStarProblem', () => {
  it('is null without a ** segment, and a ** inside a longer segment is not one', () => {
    for (const s of ['dep.>', 'dep.*', 'dep.published', 'a**', '***']) {
      expect(doubleStarProblem(s), s).toBeNull();
    }
  });

  it('names the pattern and suggests > in place of every ** segment', () => {
    expect(doubleStarProblem('a.**.b.**')).toBe('"a.**.b.**": "**" is not a wildcard, use ">" (the rest of the segments) instead: "a.>.b.>".');
  });
});
