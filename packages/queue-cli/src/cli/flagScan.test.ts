import { describe, expect, it } from 'vitest';
import { readFlagValue, scanFlags } from './flagScan.js';

describe('readFlagValue', () => {
  it('is empty when the flag is absent', () => {
    expect(readFlagValue(['a', 'b'], '--timeout', 'a value')).toEqual({});
  });

  it('reads the value wherever the flag is', () => {
    expect(readFlagValue(['ev', '{}', '--timeout', '5s'], '--timeout', 'a value')).toEqual({ value: '5s' });
  });

  it.each([[['--timeout']], [['--timeout', '--json']], [['--timeout', '']]])('reports %j as a missing value, never a default', (args) => {
    expect(readFlagValue(args, '--timeout', 'a duration, e.g. --timeout 30s')).toEqual({ error: '--timeout needs a duration, e.g. --timeout 30s' });
  });
});

describe('scanFlags', () => {
  const spec = { values: ['--a', '--b'], repeatable: ['--b'], switches: ['--s'] };

  it('collects values, repeats and switches', () => {
    const scan = scanFlags(['--a', '1', '--b', '2', '--b', '3', '--s'], spec, 'cmd');
    expect(scan.issues).toEqual([]);
    expect(scan.values.get('--a')).toEqual(['1']);
    expect(scan.values.get('--b')).toEqual(['2', '3']);
    expect(scan.switches.has('--s')).toBe(true);
  });

  it('keeps up to the accepted number of positionals and reports the next ones', () => {
    const scan = scanFlags(['one', 'two', '--a', '1'], spec, 'cmd', [], 1);
    expect(scan.positionals).toEqual(['one']);
    expect(scan.issues).toHaveLength(1);
    expect(scan.issues[0]).toMatchObject({ kind: 'stray' });
  });

  it('does not report the word after an unknown option a second time', () => {
    const scan = scanFlags(['--zzz', 'value'], spec, 'cmd');
    expect(scan.issues).toHaveLength(1);
    expect(scan.issues[0]!.kind).toBe('unknown');
  });
});

describe('scanFlags: words that look like options', () => {
  const spec = { values: ['--a'], switches: ['--s'] };

  it('a negative number is a word, not an unknown option', () => {
    const scan = scanFlags(['-5', '-12.5'], spec, 'cmd', [], 2);
    expect(scan.issues).toEqual([]);
    expect(scan.positionals).toEqual(['-5', '-12.5']);
  });

  it('an empty value is the missing value, not a second stray-word issue', () => {
    const scan = scanFlags(['--a', ''], spec, 'cmd');
    expect(scan.issues.map((issue) => issue.kind)).toEqual(['missing-value']);
  });
});
