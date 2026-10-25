import { describe, it, expect } from 'vitest';
import { buildSubscriberEntry, locateSubscriber, parseSubFlags, renameSubscriber, unnamedLine } from './subscriberEntry.js';

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

describe('locateSubscriber', () => {
  const subs = [
    { type: 'cli' as const, command: 'a', name: 'first' },
    { type: 'cli' as const, command: 'b' },
    { type: 'cli' as const, command: 'c', name: 'third' },
  ];

  it('finds a subscriber by index', () => {
    expect(locateSubscriber(subs, 'onFoo', ['--index', '1'])).toEqual({ index: 1 });
  });

  it('finds a subscriber by name, wherever it is in the list', () => {
    expect(locateSubscriber(subs, 'onFoo', ['--name', 'third'])).toEqual({ index: 2 });
  });

  it('lets the index win, so that edit --index N --name x renames', () => {
    expect(locateSubscriber(subs, 'onFoo', ['--index', '0', '--name', 'renamed'])).toEqual({ index: 0 });
  });

  it('names the subscribers that exist when the name is unknown', () => {
    const result = locateSubscriber(subs, 'onFoo', ['--name', 'nope']);
    expect(result).toMatchObject({ error: expect.stringContaining("'nope'") });
    expect((result as { error: string }).error).toContain('first, third');
  });

  it('asks for --index or --name when neither is given', () => {
    expect(locateSubscriber(subs, 'onFoo', [])).toMatchObject({ error: expect.stringContaining('--index <N> or --name <name>') });
  });

  it('refuses an invalid or out-of-range index with the count', () => {
    expect(locateSubscriber(subs, 'onFoo', ['--index', 'x'])).toMatchObject({ error: expect.stringContaining('non-negative integer') });
    expect(locateSubscriber(subs, 'onFoo', ['--index', '3'])).toMatchObject({ error: expect.stringContaining('found 3') });
  });
});

describe('renameSubscriber (queue sub edit with --name only)', () => {
  const subs = [
    { type: 'cli' as const, command: 'a', name: 'first', cwd: 'sub', env: { A: '1' }, retries: 2 },
    { type: 'http' as const, url: 'http://x' },
  ];

  it('is what edit does when --name is the only flag: it names the entry and keeps everything else', () => {
    const { config } = parseSubFlags(['--index', '1', '--name', 'hook']);
    const result = renameSubscriber(subs, 1, config);
    expect(result).toEqual({ subs: [subs[0], { type: 'http', url: 'http://x', name: 'hook' }] });
  });

  it('does not apply when other flags are given: then edit replaces the entry as before', () => {
    const { config } = parseSubFlags(['--index', '1', '--name', 'hook', '--type', 'http', '--url', 'http://y']);
    expect(renameSubscriber(subs, 1, config)).toBeUndefined();
  });

  it('does not apply without a name', () => {
    expect(renameSubscriber(subs, 1, {})).toBeUndefined();
  });

  it('refuses a name another subscriber of the event already has, naming it', () => {
    const { config } = parseSubFlags(['--index', '1', '--name', 'first']);
    const result = renameSubscriber(subs, 1, config);
    expect(result).toMatchObject({ error: expect.stringContaining("'first'") });
    expect((result as { error: string }).error).toContain('index 0');
  });
});

describe('unnamedLine', () => {
  it('warns about a subscriber without a name and gives the one command that names it', () => {
    expect(unnamedLine('onFoo', 2, 'global')).toBe(
      "[warn] subscriber onFoo[2] has no name: a name is required, so the daemon refuses to load this file. Fix: queue sub edit onFoo --index 2 --name <name>",
    );
  });

  it('adds the scope when it is the project one', () => {
    expect(unnamedLine('onFoo', 0, 'project')).toMatch(/--name <name> --scope project$/);
  });
});
