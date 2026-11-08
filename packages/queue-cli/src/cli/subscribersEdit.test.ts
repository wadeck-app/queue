import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { appendEventBlock, eventEntries, findRewriteLoss, loadSubsDoc, saveSubsDoc, setEventEntries, type SubsDoc } from './subscribersEdit.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-subs-edit-'));
  file = join(dir, 'subscribers.yml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NL = '\n';
const lines = (...parts: string[]): string => parts.join(NL) + NL;

/** The fixture of the review: a comment, an unknown key, an event written in the object form. */
const FIXTURE = lines(
  '# Subscribers of my machine',
  'subscribers:',
  '  # notifies me',
  '  deploy.done:',
  '    - type: cli',
  '      name: notify',
  '      command: echo done   # inline comment',
  '      notes: keep me',
  '      timout: 5s',
  '  build.>:',
  '    cwd: sub',
  '    env: { A: "1" }',
  '    commands:',
  '      - type: http',
  '        name: hook',
  '        url: http://example.test/hook',
);

function load(): SubsDoc {
  const loaded = loadSubsDoc(file);
  if ('error' in loaded) {
    throw new Error(loaded.error);
  }
  return loaded.doc;
}

describe('loadSubsDoc', () => {
  it('a missing file is an empty document that does not exist yet', () => {
    const doc = load();
    expect(doc.exists).toBe(false);
    expect(doc.raw).toEqual({ subscribers: {} });
  });

  it('keeps the unknown keys of a subscriber and reports them with a suggestion', () => {
    writeFileSync(file, FIXTURE);
    const doc = load();
    expect(eventEntries(doc, 'deploy.done')[0]).toMatchObject({ notes: 'keep me', timout: '5s' });
    expect(doc.unknownKeys.map((f) => f.key).sort()).toEqual(['notes', 'timout']);
    expect(doc.unknownKeys.find((f) => f.key === 'timout')!.suggestion).toBe('timeout');
  });

  it('names the file when the YAML is broken, and when the content is invalid', () => {
    writeFileSync(file, 'subscribers: [\n');
    expect(loadSubsDoc(file)).toMatchObject({ error: expect.stringContaining(file) });
    writeFileSync(file, 'subscribers:\n  a:\n    - name: x\n');
    const invalid = loadSubsDoc(file);
    expect(invalid).toMatchObject({ error: expect.stringContaining('Invalid subscribers.yml') });
  });

  it('a file with comments only is an empty document (the comments are still there to protect)', () => {
    writeFileSync(file, '# nothing yet\n');
    const doc = load();
    expect(doc.exists).toBe(true);
    expect(doc.raw).toEqual({ subscribers: {} });
  });
});

describe('eventEntries / setEventEntries - both forms of an event', () => {
  it('reads the array form and the object form the same way', () => {
    writeFileSync(file, FIXTURE);
    const doc = load();
    expect(eventEntries(doc, 'deploy.done')).toHaveLength(1);
    expect(eventEntries(doc, 'build.>')).toHaveLength(1);
    expect(eventEntries(doc, 'absent')).toEqual([]);
  });

  it('writes back in the form the file used, keeping the event cwd and env', () => {
    writeFileSync(file, FIXTURE);
    const doc = load();
    setEventEntries(doc, 'build.>', [...eventEntries(doc, 'build.>'), { type: 'cli', name: 'second', command: 'echo 2' }]);
    expect(doc.raw.subscribers['build.>']).toMatchObject({ cwd: 'sub', env: { A: '1' }, commands: [{ name: 'hook' }, { name: 'second' }] });
    setEventEntries(doc, 'deploy.done', [...eventEntries(doc, 'deploy.done')]);
    expect(Array.isArray(doc.raw.subscribers['deploy.done'])).toBe(true);
  });

  it('removing the last entry removes the event, except an object form that still has a cwd or env', () => {
    writeFileSync(file, FIXTURE);
    const doc = load();
    setEventEntries(doc, 'deploy.done', []);
    expect('deploy.done' in doc.raw.subscribers).toBe(false);
    setEventEntries(doc, 'build.>', []);
    expect(doc.raw.subscribers['build.>']).toEqual({ cwd: 'sub', env: { A: '1' }, commands: [] });
  });

  it('a new event is written as a plain array', () => {
    const doc = load();
    setEventEntries(doc, 'fresh', [{ type: 'cli', name: 'a', command: 'echo' }]);
    expect(doc.raw.subscribers['fresh']).toEqual([{ type: 'cli', name: 'a', command: 'echo' }]);
  });
});

describe('findRewriteLoss - what a rewrite would silently destroy', () => {
  it.each([
    ['# a comment at the top\nsubscribers: {}\n', 1],
    ['subscribers:\n  # inside\n  a: []\n', 2],
    ['subscribers: {}   # trailing\n', 1],
    ['subscribers:\n  a:\n    - type: cli\n      command: echo "a #b"\n', 4],
  ])('finds the comment in %j (line %i)', (text, line) => {
    expect(findRewriteLoss(text)).toMatchObject({ line });
  });

  it.each([
    'subscribers:\n  a:\n    - type: http\n      url: "http://x/#frag"\n',
    'subscribers:\n  a:\n    - type: http\n      url: http://x/#frag\n',
    "subscribers:\n  a:\n    - type: cli\n      command: 'echo #1'\n",
    'subscribers:\n  "dep.>": []\n',
    'subscribers:\n  a:\n    - type: cli\n      command: echo *.txt\n',
  ])('finds nothing in %j', (text) => {
    expect(findRewriteLoss(text)).toBeUndefined();
  });

  it('finds anchors and aliases, which a rewrite would expand', () => {
    expect(findRewriteLoss('subscribers:\n  a:\n    - &base\n      type: cli\n')).toMatchObject({ line: 3 });
    expect(findRewriteLoss('x:\n  - *base\n')).toMatchObject({ line: 2 });
  });
});

describe('appendEventBlock - the text-level append that keeps the file as it is', () => {
  const entry = { type: 'cli', name: 'fresh', command: 'echo new' };
  const expectedFor = (text: string, event: string): unknown => {
    const raw = (yamlLoad(text) ?? {}) as { subscribers?: Record<string, unknown> };
    return { ...raw, subscribers: { ...(raw.subscribers ?? {}), [event]: [entry] } };
  };

  it('adds the block at the end of the subscribers mapping and leaves every original byte in place', () => {
    const result = appendEventBlock(FIXTURE, 'fresh.event', entry, expectedFor(FIXTURE, 'fresh.event'));
    expect(result).toBeDefined();
    expect(result!.startsWith(FIXTURE)).toBe(true);
    expect(yamlLoad(result!)).toEqual(expectedFor(FIXTURE, 'fresh.event'));
  });

  it('puts the block before the next top-level key and keeps the comments around it', () => {
    const text = lines('# header', 'subscribers:', '  a:', '    - type: cli', '      name: x', '      command: echo', '', '# the folder', 'cwd: .');
    const result = appendEventBlock(text, 'b', entry, expectedFor(text, 'b'))!;
    expect(result.indexOf('  b:')).toBeGreaterThan(result.indexOf('echo'));
    expect(result.indexOf('  b:')).toBeLessThan(result.indexOf('# the folder'));
    expect(result).toContain('# header');
    expect(result.endsWith(`# the folder${NL}cwd: .${NL}`)).toBe(true);
    expect(yamlLoad(result)).toEqual(expectedFor(text, 'b'));
  });

  it('follows the indentation and the line endings of the file', () => {
    const text = ['subscribers:', '    a:', '        - type: cli', '          name: x', '          command: echo', ''].join('\r\n');
    const result = appendEventBlock(text, 'b', entry, expectedFor(text, 'b'))!;
    expect(result.startsWith(text)).toBe(true);
    expect(result).toContain('\r\n    b:\r\n');
    expect(result).not.toMatch(/[^\r]\n/);
    expect(yamlLoad(result)).toEqual(expectedFor(text, 'b'));
  });

  it('adds the final newline a file without one was missing', () => {
    const text = 'subscribers:\n  a:\n    - type: cli\n      name: x\n      command: echo';
    const result = appendEventBlock(text, 'b', entry, expectedFor(text, 'b'))!;
    expect(result.startsWith(text + NL)).toBe(true);
    expect(result.endsWith(NL)).toBe(true);
  });

  it('quotes an event key that needs it', () => {
    const text = 'subscribers:\n  a: []\n';
    const result = appendEventBlock(text, 'dep.>', entry, expectedFor(text, 'dep.>'))!;
    expect(yamlLoad(result)).toEqual(expectedFor(text, 'dep.>'));
  });

  it('adds a subscribers mapping to a file that only has comments', () => {
    const text = '# nothing yet\n';
    const result = appendEventBlock(text, 'b', entry, expectedFor(text, 'b'))!;
    expect(result.startsWith(text)).toBe(true);
    expect(yamlLoad(result)).toEqual({ subscribers: { b: [entry] } });
  });

  it.each([
    ['a flow-style mapping', 'subscribers: {}\n'],
    ['an event that is already there', 'subscribers:\n  b:\n    - type: cli\n      name: x\n      command: echo\n'],
  ])('answers undefined for %s, so the caller falls back to a rewrite', (_label, text) => {
    expect(appendEventBlock(text, 'b', entry, expectedFor(text, 'b'))).toBeUndefined();
  });

  it('answers undefined when the result would not read back as expected', () => {
    const text = 'subscribers:\n  a: []\n';
    expect(appendEventBlock(text, 'b', entry, { subscribers: { a: [], b: [{ ...entry, name: 'other' }] } })).toBeUndefined();
  });
});

describe('saveSubsDoc', () => {
  const add = (doc: SubsDoc, event: string, entry: { type: 'cli'; name: string; command: string }, rewrite = false) => {
    setEventEntries(doc, event, [...eventEntries(doc, event), entry]);
    return saveSubsDoc(doc, { command: 'add', rewrite, appended: { event, entry } });
  };

  it('creates the file when there is none', () => {
    const doc = load();
    expect(add(doc, 'a', { type: 'cli', name: 'x', command: 'echo' })).toEqual({ ok: true, mode: 'create' });
    expect(yamlLoad(readFileSync(file, 'utf-8'))).toEqual({ subscribers: { a: [{ type: 'cli', name: 'x', command: 'echo' }] } });
  });

  it('add of a new event appends as text: comments, unknown keys and the object form survive, byte for byte', () => {
    writeFileSync(file, FIXTURE);
    const result = add(load(), 'fresh.event', { type: 'cli', name: 'fresh', command: 'echo new' });
    expect(result).toEqual({ ok: true, mode: 'append' });
    const after = readFileSync(file, 'utf-8');
    expect(after.startsWith(FIXTURE)).toBe(true);
    expect(after).toContain('# Subscribers of my machine');
    expect(after).toContain('notes: keep me');
  });

  it('add to an existing event of a file with comments is refused, with the line, both ways out and no write', () => {
    writeFileSync(file, FIXTURE);
    const result = add(load(), 'deploy.done', { type: 'cli', name: 'second', command: 'echo 2' });
    expect(result).toMatchObject({ error: expect.stringContaining('--rewrite') });
    const message = (result as { error: string }).error;
    expect(message).toContain(file);
    expect(message).toContain('line 1');
    expect(message).toContain('by hand');
    expect(message).toContain('comments');
    expect(readFileSync(file, 'utf-8')).toBe(FIXTURE);
  });

  it('with --rewrite the add goes through; unknown keys and the object form are kept, the comments are gone', () => {
    writeFileSync(file, FIXTURE);
    const result = add(load(), 'deploy.done', { type: 'cli', name: 'second', command: 'echo 2' }, true);
    expect(result).toMatchObject({ ok: true, mode: 'rewrite', lost: expect.stringContaining('comment') });
    const after = yamlLoad(readFileSync(file, 'utf-8')) as { subscribers: Record<string, any> };
    expect(after.subscribers['deploy.done']).toHaveLength(2);
    expect(after.subscribers['deploy.done'][0]).toMatchObject({ notes: 'keep me', timout: '5s' });
    expect(after.subscribers['build.>']).toMatchObject({ cwd: 'sub', env: { A: '1' }, commands: [{ name: 'hook' }] });
    expect(readFileSync(file, 'utf-8')).not.toContain('#');
  });

  it('a file without comments is rewritten without ceremony, and nothing but the data changes', () => {
    writeFileSync(file, lines('subscribers:', '  a:', '    - type: cli', '      name: x', '      command: echo', '      notes: n', '  o:', '    cwd: sub', '    commands:', '      - type: cli', '        name: y', '        command: echo'));
    const doc = load();
    setEventEntries(doc, 'a', [{ ...eventEntries(doc, 'a')[0]!, retries: 3 }]);
    expect(saveSubsDoc(doc, { command: 'edit', rewrite: false })).toEqual({ ok: true, mode: 'rewrite' });
    const after = yamlLoad(readFileSync(file, 'utf-8')) as { subscribers: Record<string, any> };
    expect(after.subscribers['a'][0]).toMatchObject({ retries: 3, notes: 'n' });
    expect(after.subscribers['o']).toMatchObject({ cwd: 'sub', commands: [{ name: 'y' }] });
  });

  it('edit and remove of a file with comments are refused too, and say what to do', () => {
    writeFileSync(file, FIXTURE);
    const doc = load();
    setEventEntries(doc, 'deploy.done', []);
    const result = saveSubsDoc(doc, { command: 'remove', rewrite: false });
    expect(result).toMatchObject({ error: expect.stringContaining("'queue sub remove'") });
    expect(readFileSync(file, 'utf-8')).toBe(FIXTURE);
  });

  it('refuses to write an invalid document and leaves the file alone', () => {
    writeFileSync(file, 'subscribers:\n  a: []\n');
    const doc = load();
    setEventEntries(doc, 'a', [{ type: 'cli', name: 'x', command: 'echo', retries: -1 } as never]);
    expect(saveSubsDoc(doc, { command: 'edit', rewrite: false })).toMatchObject({ error: expect.stringContaining('Invalid subscriber config') });
    expect(readFileSync(file, 'utf-8')).toBe('subscribers:\n  a: []\n');
  });

  it('leaves no temporary file behind', () => {
    const doc = load();
    add(doc, 'a', { type: 'cli', name: 'x', command: 'echo' });
    expect(readdirSync(dir)).toEqual(['subscribers.yml']);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
