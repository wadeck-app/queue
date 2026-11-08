import { describe, it, expect } from 'vitest';
import { entryProblems, mergeSubscriberEntry, parseScopeFlag, parseSubFlags } from './subscriberEntry.js';

// R4b items 2 and 4: every value-taking flag, strict numbers, method list, unknown flags, edit merging over the entry, --unset.

const SUB_VALUE_FLAGS = ['--name', '--type', '--action', '--set', '--command', '--url', '--method', '--header', '--timeout', '--retries', '--backoff', '--when', '--unset', '--index', '--scope'];

describe('parseSubFlags - a value-taking flag without its value is an error, never a default', () => {
  it.each(SUB_VALUE_FLAGS)('%s at the end of the arguments', (flag) => {
    const { errors } = parseSubFlags([flag]);
    expect(errors.some((e) => e.startsWith(`${flag} needs `)), `${flag}: ${JSON.stringify(errors)}`).toBe(true);
  });

  it.each(SUB_VALUE_FLAGS)('%s followed by another flag', (flag) => {
    const { errors } = parseSubFlags([flag, '--rewrite']);
    expect(errors.some((e) => e.startsWith(`${flag} needs `)), `${flag}: ${JSON.stringify(errors)}`).toBe(true);
  });

  it('keeps the examples the first three flags always gave', () => {
    expect(parseSubFlags(['--name']).errors).toContain('--name needs a value, e.g. --name notify');
    expect(parseSubFlags(['--action']).errors).toContain('--action needs the name of the action, e.g. --action emit');
    expect(parseSubFlags(['--set']).errors).toContain('--set needs a key=value, e.g. --set to=project:my-app');
  });
});

describe('parseSubFlags - numbers and enumerations are strict', () => {
  it.each(['5abc', '-1', '1.5', '1e2', '+5', '0x10', ' 5', '99999999999999999999'])('refuses --retries %j', (value) => {
    const { errors, config } = parseSubFlags(['--retries', value]);
    expect(errors.join(' ')).toContain('--retries');
    expect(config.retries).toBeUndefined();
  });

  it.each([['0', 0], ['5', 5], ['12', 12]])('accepts --retries %s', (value, expected) => {
    const { errors, config } = parseSubFlags(['--retries', value]);
    expect(errors).toEqual([]);
    expect(config.retries).toBe(expected);
  });

  it.each(['30', 's', '5x', '1.5s', '-5s', '5 s'])('refuses --timeout %j and shows the format', (value) => {
    const { errors } = parseSubFlags(['--timeout', value]);
    expect(errors.join(' ')).toContain('30s, 5m, 1h');
  });

  it.each([['POST', 'POST'], ['put', 'PUT'], ['Patch', 'PATCH'], ['delete', 'DELETE']])('accepts --method %s and writes %s', (value, expected) => {
    const { errors, config } = parseSubFlags(['--method', value]);
    expect(errors).toEqual([]);
    expect(config.method).toBe(expected);
  });

  it.each(['FETCH', 'po st', 'GET', 'HEAD'])('refuses --method %s and lists the accepted verbs', (value) => {
    const { errors } = parseSubFlags(['--method', value]);
    expect(errors.join(' ')).toContain('POST, PUT, PATCH, DELETE');
  });

  it('explains why GET is not accepted (the event travels as a JSON body)', () => {
    expect(parseSubFlags(['--method', 'GET']).errors.join(' ')).toContain('JSON body');
  });

  it('refuses a --backoff outside the two strategies, and an empty --when', () => {
    expect(parseSubFlags(['--backoff', 'fast']).errors.join(' ')).toContain('exponential or linear');
    expect(parseSubFlags(['--when', '']).errors.join(' ')).toContain('--when');
  });

  it('refuses an --index that is not a plain non-negative integer', () => {
    for (const value of ['1x', '-1', '1.5', '1e1', '']) {
      expect(parseSubFlags(['--index', value]).errors.join(' '), value).toContain('--index');
    }
    expect(parseSubFlags(['--index', '3']).errors).toEqual([]);
  });
});

describe('parseSubFlags - unknown flags, stray words and repeated flags', () => {
  it('refuses a typo and suggests the flag it is close to', () => {
    const { errors } = parseSubFlags(['--retry', '3']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("unknown option '--retry'");
    expect(errors[0]).toContain("did you mean '--retries'?");
  });

  it('refuses an unknown flag with no near match, without a suggestion', () => {
    const { errors } = parseSubFlags(['--zzzzzzzz']);
    expect(errors[0]).toContain("unknown option '--zzzzzzzz'");
    expect(errors[0]).not.toContain('did you mean');
  });

  it('does not take the value of a known flag for a stray word', () => {
    expect(parseSubFlags(['--timeout', '5s', '--command', 'echo hi']).errors).toEqual([]);
  });

  it('refuses a stray word and says to quote a command with spaces', () => {
    const { errors } = parseSubFlags(['--command', 'echo', 'hi']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unexpected argument 'hi'");
    expect(errors[0]).toContain('quote');
  });

  it('refuses a single-value flag given twice instead of keeping the first silently', () => {
    const { errors } = parseSubFlags(['--timeout', '5s', '--timeout', '6s']);
    expect(errors.join(' ')).toContain('--timeout is given twice');
  });

  it('still allows --header, --set and --unset to repeat', () => {
    expect(parseSubFlags(['--header', 'a:1', '--header', 'b:2', '--set', 'x=1', '--set', 'y=2', '--unset', 'when', '--unset', 'cwd']).errors).toEqual([]);
  });

  it('knows which flags each sub-command takes', () => {
    expect(parseSubFlags(['--index', '1'], 'add').errors.join(' ')).toContain("'--index' does not apply to 'queue sub add'");
    expect(parseSubFlags(['--type', 'cli'], 'remove').errors.join(' ')).toContain("'--type' does not apply to 'queue sub remove'");
    expect(parseSubFlags(['--unset', 'timeout'], 'add').errors.join(' ')).toContain("'--unset' does not apply to 'queue sub add'");
    expect(parseSubFlags(['--index', '1', '--scope', 'project', '--rewrite'], 'remove').errors).toEqual([]);
    expect(parseSubFlags(['--index', '1', '--unset', 'timeout', '--timeout', '5s'], 'edit').errors).toEqual([]);
  });

  it('reads --rewrite', () => {
    expect(parseSubFlags(['--rewrite']).rewrite).toBe(true);
    expect(parseSubFlags([]).rewrite).toBe(false);
  });
});

describe('--set uses own keys only (a key named like an Object.prototype member works)', () => {
  it.each(['toString', 'hasOwnProperty', 'valueOf'])('--set %s=x is stored', (key) => {
    const { errors, config } = parseSubFlags(['--set', `${key}=x`]);
    expect(errors).toEqual([]);
    expect(Object.hasOwn(config.with!, key)).toBe(true);
    expect(config.with![key]).toBe('x');
  });

  it('nests under a key named like a prototype member', () => {
    const { errors, config } = parseSubFlags(['--set', 'toString.a=1', '--set', 'toString.b=2']);
    expect(errors).toEqual([]);
    expect(JSON.parse(JSON.stringify(config.with))).toEqual({ toString: { a: '1', b: '2' } });
  });

  it('still refuses the same key twice', () => {
    expect(parseSubFlags(['--set', 'toString=1', '--set', 'toString=2']).errors.join(' ')).toContain('set twice');
  });
});

describe('parseScopeFlag', () => {
  it('is global when absent, and says it was not given', () => {
    expect(parseScopeFlag(['list'])).toEqual({ scope: 'global', given: false });
  });

  it('reads global and project', () => {
    expect(parseScopeFlag(['--scope', 'project'])).toEqual({ scope: 'project', given: true });
    expect(parseScopeFlag(['list', '--scope', 'global'])).toEqual({ scope: 'global', given: true });
  });

  it.each([[['--scope']], [['--scope', '--json']]])('refuses a missing value %j instead of falling back to global', (args) => {
    expect(parseScopeFlag(args)).toEqual({ error: '--scope needs a value, e.g. --scope project (global or project)' });
  });

  it('refuses another value', () => {
    expect(parseScopeFlag(['--scope', 'user'])).toEqual({ error: '--scope must be global or project, got: user' });
  });
});

describe('mergeSubscriberEntry - edit keeps what the flags do not say', () => {
  const http = { type: 'http' as const, name: 'hook', url: 'http://x', method: 'PUT', headers: { A: '1', B: '2' }, timeout: '10s', retries: 7, backoff: 'linear' as const, when: 'payload.a=1', notes: 'keep me' };
  const merge = (previous: Record<string, unknown>, flags: string[]) => {
    const parsed = parseSubFlags(flags, 'edit');
    expect(parsed.errors).toEqual([]);
    return mergeSubscriberEntry(previous as never, { config: parsed.config, unset: parsed.unset, given: parsed.given });
  };

  it('--timeout alone changes the timeout and nothing else, whatever the type', () => {
    expect(merge(http, ['--timeout', '5s'])).toMatchObject({ entry: { ...http, timeout: '5s' } });
  });

  it('keeps retries, backoff, when and keys the CLI does not know when only the command changes', () => {
    const cli = { type: 'cli' as const, name: 'n', command: 'old', retries: 2, backoff: 'linear' as const, when: 'payload.a=1', timeout: '9s', extra: 1 };
    expect(merge(cli, ['--command', 'new'])).toMatchObject({ entry: { ...cli, command: 'new' } });
  });

  it('--header merges per header name', () => {
    expect(merge(http, ['--header', 'B:9', '--header', 'C:3'])).toMatchObject({ entry: { headers: { A: '1', B: '9', C: '3' } } });
  });

  it('--set merges into with per key, nested keys included', () => {
    const action = { type: 'action' as const, name: 'a', action: 'emit', with: { event: 'x.y', payload: { keep: 'k', text: 'old' } }, retries: 3 };
    expect(merge(action, ['--set', 'payload.text=new', '--set', 'extra=1'])).toMatchObject({ entry: { ...action, with: { event: 'x.y', payload: { keep: 'k', text: 'new' }, extra: '1' } } });
  });

  it('--set over a plain value replaces it, and a plain value over an object replaces it', () => {
    const action = { type: 'action' as const, name: 'a', action: 'emit', with: { payload: 'plain', other: { deep: 1 } } };
    expect(merge(action, ['--set', 'payload.text=t', '--set', 'other=flat'])).toMatchObject({ entry: { with: { payload: { text: 't' }, other: 'flat' } } });
  });

  it('takes type, action and with from the entry when the flags omit them', () => {
    const action = { type: 'action' as const, name: 'a', action: 'emit', with: { event: 'x.y' } };
    expect(merge(action, ['--when', 'payload.k=1'])).toMatchObject({ entry: { ...action, when: 'payload.k=1' } });
  });

  it('does not mutate the entry it was given', () => {
    const before = JSON.stringify(http);
    merge(http, ['--timeout', '1s', '--header', 'Z:1', '--unset', 'when']);
    expect(JSON.stringify(http)).toBe(before);
  });
});

describe('mergeSubscriberEntry - --unset', () => {
  const entry = { type: 'http' as const, name: 'hook', url: 'http://x', method: 'PUT', headers: { A: '1', B: '2' }, timeout: '10s', retries: 7, backoff: 'linear' as const, when: 'w' };
  const merge = (previous: Record<string, unknown>, flags: string[]) => {
    const parsed = parseSubFlags(flags, 'edit');
    expect(parsed.errors).toEqual([]);
    return mergeSubscriberEntry(previous as never, { config: parsed.config, unset: parsed.unset, given: parsed.given });
  };

  it.each(['timeout', 'retries', 'backoff', 'when', 'method', 'headers'])('removes %s', (field) => {
    const result = merge(entry, ['--unset', field]);
    expect('entry' in result).toBe(true);
    if ('entry' in result) {
      expect(Object.hasOwn(result.entry, field)).toBe(false);
      expect(result.entry.url).toBe('http://x');
    }
  });

  it('is repeatable, and removes one header only with headers.<name>', () => {
    const result = merge(entry, ['--unset', 'headers.A', '--unset', 'when']);
    expect(result).toMatchObject({ entry: { headers: { B: '2' }, timeout: '10s' } });
    expect('entry' in result && Object.hasOwn(result.entry, 'when')).toBe(false);
  });

  it('removing the last header removes the empty headers block', () => {
    const result = merge({ ...entry, headers: { A: '1' } }, ['--unset', 'headers.A']);
    expect('entry' in result && Object.hasOwn(result.entry, 'headers')).toBe(false);
  });

  it('removes one key of with, nested keys included', () => {
    const action = { type: 'action' as const, name: 'a', action: 'emit', with: { event: 'x', payload: { a: 1, b: 2 } } };
    expect(merge(action, ['--unset', 'with.payload.a'])).toMatchObject({ entry: { with: { event: 'x', payload: { b: 2 } } } });
  });

  it('says it when there was nothing to remove', () => {
    expect(merge(entry, ['--unset', 'cwd'])).toMatchObject({ notes: [expect.stringContaining("--unset cwd: the subscriber has no 'cwd'")] });
  });

  it('refuses to set and unset the same field in one command', () => {
    expect(merge(entry, ['--timeout', '5s', '--unset', 'timeout'])).toMatchObject({ errors: [expect.stringContaining('contradict')] });
  });

  it('removing a field the type needs is caught by the requirement check', () => {
    const result = merge(entry, ['--unset', 'url']);
    expect('entry' in result).toBe(true);
    expect('entry' in result && entryProblems(result.entry, {}).join(' ')).toContain('--url is required for type: http');
  });
});

describe('parseSubFlags --unset validation', () => {
  it.each(['timeout', 'retries', 'backoff', 'when', 'method', 'headers', 'headers.X-Token', 'cwd', 'env', 'env.PATH', 'with', 'with.payload.text', 'command', 'url', 'action'])('accepts --unset %s', (field) => {
    const parsed = parseSubFlags(['--unset', field], 'edit');
    expect(parsed.errors).toEqual([]);
    expect(parsed.unset).toEqual([field]);
  });

  it('refuses an unknown field, listing the valid ones and the near match', () => {
    const { errors } = parseSubFlags(['--unset', 'timout'], 'edit');
    expect(errors[0]).toContain("--unset 'timout' is not a field that can be removed");
    expect(errors[0]).toContain("did you mean 'timeout'?");
    expect(errors[0]).toContain('headers.<name>');
  });

  it.each(['name', 'type'])('refuses --unset %s: every subscriber has one', (field) => {
    expect(parseSubFlags(['--unset', field], 'edit').errors[0]).toContain(`'${field}' cannot be removed`);
  });

  it.each(['timeout.x', 'headers.', 'with..a', 'with.__proto__'])('refuses the malformed path %s', (field) => {
    expect(parseSubFlags(['--unset', field], 'edit').errors.length).toBeGreaterThan(0);
  });
});

describe('mergeSubscriberEntry - changing --type', () => {
  const merge = (previous: Record<string, unknown>, flags: string[]) => {
    const parsed = parseSubFlags(flags, 'edit');
    expect(parsed.errors).toEqual([]);
    return mergeSubscriberEntry(previous as never, { config: parsed.config, unset: parsed.unset, given: parsed.given });
  };

  it('cli to http clears the command and lists what was cleared; the shared fields stay', () => {
    const cli = { type: 'cli' as const, name: 'n', command: 'echo', cwd: 'sub', env: { A: '1' }, timeout: '9s' };
    expect(merge(cli, ['--type', 'http', '--url', 'http://x'])).toEqual({ entry: { type: 'http', name: 'n', url: 'http://x', cwd: 'sub', env: { A: '1' }, timeout: '9s' }, cleared: ['command'], notes: [] });
  });

  it('http to cli clears url, method and headers', () => {
    const http = { type: 'http' as const, name: 'n', url: 'http://x', method: 'PUT', headers: { A: '1' }, retries: 1 };
    expect(merge(http, ['--type', 'cli', '--command', 'echo'])).toEqual({ entry: { type: 'cli', name: 'n', command: 'echo', retries: 1 }, cleared: ['url', 'method', 'headers'], notes: [] });
  });

  it('cli to action clears command, cwd and env', () => {
    const cli = { type: 'cli' as const, name: 'n', command: 'echo', cwd: 'sub', env: { A: '1' } };
    expect(merge(cli, ['--type', 'action', '--action', 'emit', '--set', 'event=a.b'])).toMatchObject({ entry: { type: 'action', name: 'n', action: 'emit', with: { event: 'a.b' } }, cleared: ['command', 'cwd', 'env'] });
  });

  it('action to cli clears action and with', () => {
    const action = { type: 'action' as const, name: 'n', action: 'emit', with: { event: 'a.b' } };
    expect(merge(action, ['--type', 'cli', '--command', 'echo'])).toMatchObject({ entry: { type: 'cli', name: 'n', command: 'echo' }, cleared: ['action', 'with'] });
  });

  it('without the companion the new type needs, the requirement check says what to add and what was cleared', () => {
    const cli = { type: 'cli' as const, name: 'n', command: 'echo' };
    const result = merge(cli, ['--type', 'http']);
    expect('entry' in result).toBe(true);
    if ('entry' in result) {
      const problems = entryProblems(result.entry, { from: 'cli', cleared: result.cleared });
      expect(problems.join(' ')).toContain('--url is required for type: http');
      expect(problems.join(' ')).toContain('command');
    }
  });

  it('re-giving the same type changes nothing and clears nothing', () => {
    const http = { type: 'http' as const, name: 'n', url: 'http://x' };
    expect(merge(http, ['--type', 'http', '--timeout', '3s'])).toEqual({ entry: { ...http, timeout: '3s' }, cleared: [], notes: [] });
  });

  it('refuses a flag of the wrong type when the type comes from the entry', () => {
    const action = { type: 'action' as const, name: 'n', action: 'emit', with: {} };
    expect(merge(action, ['--command', 'x'])).toMatchObject({ errors: [expect.stringContaining('--command does not apply to type action')] });
    const cli = { type: 'cli' as const, name: 'n', command: 'x' };
    expect(merge(cli, ['--set', 'a=b'])).toMatchObject({ errors: [expect.stringContaining('only apply to type action')] });
  });
});

describe('entryProblems', () => {
  it('asks for the companions of the type', () => {
    expect(entryProblems({ type: 'cli' }, {})).toEqual(['--command is required for type: cli']);
    expect(entryProblems({ type: 'http' }, {})).toEqual(['--url is required for type: http']);
    expect(entryProblems({ type: 'cli', command: '{{ program }} --flag' }, {}).join(' ')).toContain('--command:');
    expect(entryProblems({ type: 'cli', command: 'echo' }, {})).toEqual([]);
    expect(entryProblems({ type: 'action', action: 'emit' }, {})).toEqual([]);
  });
});
