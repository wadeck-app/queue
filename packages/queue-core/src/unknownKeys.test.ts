import { describe, it, expect } from 'vitest';
import { load as yamlLoad } from 'js-yaml';
import { findUnknownKeys } from './unknownKeys.js';

const parse = (text: string): unknown => yamlLoad(text);

describe('findUnknownKeys', () => {
  it('finds nothing in a file with only known keys, in both event forms', () => {
    const raw = parse([
      'cwd: .',
      'subscribers:',
      '  a:',
      '    - type: cli',
      '      name: x',
      '      command: echo',
      '      timeout: 5s',
      '  b:',
      '    cwd: sub',
      '    env: { A: "1" }',
      '    commands:',
      '      - type: http',
      '        url: http://x',
    ].join('\n'));
    expect(findUnknownKeys(raw)).toEqual([]);
  });

  it('names the key, the event, the index and the subscriber, and suggests the near match', () => {
    const raw = parse('subscribers:\n  a:\n    - type: cli\n      name: x\n      command: echo\n      timout: 5s\n      notes: hello\n');
    const found = findUnknownKeys(raw);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ key: 'timout', event: 'a', index: 0, name: 'x', suggestion: 'timeout' });
    expect(found[0]!.message).toContain("unknown key 'timout'");
    expect(found[0]!.message).toContain("did you mean 'timeout'?");
    expect(found[1]).toMatchObject({ key: 'notes' });
    expect(found[1]!.suggestion).toBeUndefined();
    expect(found[1]!.message).not.toContain('did you mean');
  });

  it('looks inside the commands of an object-form event, and at the event object itself', () => {
    const raw = parse('subscribers:\n  b:\n    cwd: sub\n    comands: []\n    commands:\n      - type: cli\n        command: echo\n        retrys: 2\n');
    const keys = findUnknownKeys(raw).map((f) => f.key).sort();
    expect(keys).toEqual(['comands', 'retrys']);
    expect(findUnknownKeys(raw).find((f) => f.key === 'comands')!.suggestion).toBe('commands');
  });

  it('looks at the top-level keys', () => {
    const found = findUnknownKeys(parse('subscribers: {}\nsubscriber: {}\n'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ key: 'subscriber', suggestion: 'subscribers' });
  });

  it('returns nothing for something that is not a mapping instead of throwing (the schema reports it)', () => {
    expect(findUnknownKeys(undefined)).toEqual([]);
    expect(findUnknownKeys('x')).toEqual([]);
    expect(findUnknownKeys({ subscribers: { a: 5 } })).toEqual([]);
    expect(findUnknownKeys({ subscribers: { a: [null, 'x'] } })).toEqual([]);
  });
});
