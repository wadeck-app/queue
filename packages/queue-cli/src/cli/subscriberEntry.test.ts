import { describe, it, expect } from 'vitest';
import { buildSubscriberEntry, parseSubFlags } from './subscriberEntry.js';

describe('parseSubFlags --name', () => {
  it('reads the name', () => {
    const { config, errors } = parseSubFlags(['--type', 'cli', '--command', 'echo hi', '--name', 'notify']);
    expect(errors).toEqual([]);
    expect(config.name).toBe('notify');
  });

  it.each(['Notify', 'has space', '-lead', 'a/b'])('refuses the name %j and gives the accepted format', (name) => {
    const { errors } = parseSubFlags(['--type', 'cli', '--command', 'echo hi', '--name', name]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('[a-z0-9][a-z0-9._-]*');
  });

  it('reports a --name without a value instead of ignoring it', () => {
    const { errors } = parseSubFlags(['--type', 'cli', '--command', 'echo hi', '--name']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--name');
  });
});

describe('buildSubscriberEntry', () => {
  it('writes the name next to the type', () => {
    expect(buildSubscriberEntry({ type: 'cli', command: 'echo hi', name: 'notify' })).toEqual({ type: 'cli', name: 'notify', command: 'echo hi' });
  });

  it('on edit, keeps the name, the cwd and the env of the entry it replaces when the flags do not say otherwise', () => {
    const previous = { type: 'cli' as const, command: 'old', name: 'notify', cwd: 'sub', env: { A: '1' } };
    expect(buildSubscriberEntry({ type: 'cli', command: 'new' }, previous)).toEqual({ type: 'cli', name: 'notify', command: 'new', cwd: 'sub', env: { A: '1' } });
  });

  it('on edit, a new --name replaces the previous one', () => {
    expect(buildSubscriberEntry({ type: 'cli', command: 'c', name: 'renamed' }, { type: 'cli', command: 'c', name: 'notify' }).name).toBe('renamed');
  });
});
