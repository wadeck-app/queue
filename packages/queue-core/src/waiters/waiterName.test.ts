import { describe, it, expect } from 'vitest';
import { waiterNameProblem, isValidWaiterName, waiterFileName, waiterNameOfFile, WAITER_NAME_FORMAT } from './waiterName.js';

describe('waiterNameProblem', () => {
  it.each(['w-agent-wake.ab12cd34', 'a.b', 'agent.ci-sha-1.2', 'x'.repeat(31) + '.' + 'y'.repeat(32)])('accepts %s', (name) => {
    expect(waiterNameProblem(name)).toBeUndefined();
    expect(isValidWaiterName(name)).toBe(true);
  });

  it.each([
    ['no dot', 'agent'],
    ['uppercase', 'Agent.x'],
    ['65 characters', 'x'.repeat(32) + '.' + 'y'.repeat(32)],
    ['empty', ''],
    ['forward slash', 'a/b.c'],
    ['backslash', 'a\b.c'],
    ['leading dot', '.a.b'],
    ['trailing dot', 'a.b.'],
    ['empty part', 'a..b'],
    ['space', 'a .b'],
    ['colon (a Windows device or stream)', 'con:.x'],
    ['parent folder', '../a.b'],
  ])('refuses %s', (_label, name) => {
    expect(waiterNameProblem(name)).toBeDefined();
    expect(isValidWaiterName(name)).toBe(false);
  });

  it('the message shows the expected shape, the limit and an example', () => {
    const problem = waiterNameProblem('Bad')!;
    expect(problem).toContain("'Bad'");
    expect(problem).toContain('<who>.<what>');
    expect(problem).toContain(WAITER_NAME_FORMAT);
    expect(problem).toContain('64');
    expect(problem).toContain('w-agent-wake.ab12cd34');
  });

  it('says what is wrong with a name that has no dot', () => {
    expect(waiterNameProblem('agent')).toContain('dot');
  });
});

describe('waiterFileName', () => {
  it('prefixes waiter- so a name such as con.x is never a Windows device name', () => {
    expect(waiterFileName('con.x')).toBe('waiter-con.x.json');
  });

  it('refuses an invalid name instead of building a path from it', () => {
    expect(() => waiterFileName('../x.y')).toThrow(/<who>\.<what>/);
  });

  it('waiterNameOfFile is its inverse and ignores other files', () => {
    expect(waiterNameOfFile('waiter-a.b.json')).toBe('a.b');
    expect(waiterNameOfFile('a.b.json')).toBeUndefined();
    expect(waiterNameOfFile('waiter-a.b.json.tmp')).toBeUndefined();
    expect(waiterNameOfFile('waiter-.json')).toBeUndefined();
  });
});
