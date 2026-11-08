import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { appendEventBlock, eventEntries, loadSubsDoc, saveSubsDoc, setEventEntries, type SubsDoc } from './subscribersEdit.js';

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

/** Values a dump of the parsed value normalizes (date -> ISO timestamp, hex -> decimal, octal-looking -> decimal, big integer -> rounded) and a comment after an apostrophe-led word. */
const TRICKY = lines(
  '# top comment',
  'subscribers:',
  '  deploy.done:   # why',
  '    - type: cli',
  '      name: notify',
  "      command: echo don't   # apostrophe then comment",
  '      since: 2024-01-01',
  '      mask: 0x1F',
  '      mode: 0755',
  '      big: 12345678901234567890',
  '    # about the second one',
  '    - type: action',
  '      name: wake',
  '      action: agent-wake',
  '      with:',
  '        day: 2024-01-01',
  '        flags: 0x1F',
  '  other.event:',
  '    - &base',
  '      type: cli',
  '      name: shared',
  '      command: echo shared',
);

describe('saveSubsDoc - edit and remove keep comments and the original text of every value', () => {
  const edit = (doc: SubsDoc, event: string, index: number, change: Record<string, unknown>) => {
    const entries = eventEntries(doc, event);
    setEventEntries(doc, event, entries.map((e, i) => (i === index ? ({ ...e, ...change } as typeof e) : e)));
    return saveSubsDoc(doc, { command: 'edit', rewrite: false });
  };

  it('edit changes only the changed value: comments, anchors and the text of unknown keys and of with: stay', () => {
    writeFileSync(file, TRICKY);
    expect(edit(load(), 'deploy.done', 0, { timeout: '9s' })).toMatchObject({ ok: true });
    const after = readFileSync(file, 'utf-8');
    // Only a new key is added; the comment after `key:` moves to the line below, the others and every value are untouched
    expect(after).toBe(TRICKY.replace('  deploy.done:   # why\n', '  deploy.done:\n    # why\n').replace("echo don't   # apostrophe", "echo don't # apostrophe").replace('      big: 12345678901234567890\n', '      big: 12345678901234567890\n      timeout: 9s\n'));
  });

  it('edit of a value keeps the comment of its line', () => {
    writeFileSync(file, TRICKY);
    expect(edit(load(), 'deploy.done', 0, { command: 'echo changed' })).toMatchObject({ ok: true });
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('since: 2024-01-01');
    expect(after).toContain('mask: 0x1F');
    expect(after).toContain('mode: 0755');
    expect(after).toContain('big: 12345678901234567890');
    expect(after).toContain('day: 2024-01-01');
    expect(after).toContain('flags: 0x1F');
    expect(after).toContain('# top comment');
    expect(after).toContain('# why');
    expect(after).toContain('# about the second one');
    expect(after).toContain('&base');
    expect(after).toContain('echo changed');
  });

  it('remove of one subscriber keeps every other comment and value', () => {
    writeFileSync(file, TRICKY);
    const doc = load();
    setEventEntries(doc, 'deploy.done', eventEntries(doc, 'deploy.done').filter((e) => e.name !== 'notify'));
    expect(saveSubsDoc(doc, { command: 'remove', rewrite: false })).toMatchObject({ ok: true });
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('# top comment');
    expect(after).toContain('# why');
    expect(after).toContain('flags: 0x1F');
    expect(after).toContain('day: 2024-01-01');
    expect(after).toContain('&base');
    expect(after).not.toContain('echo don');
  });

  it('remove of the last subscriber of an event removes the event and keeps the others', () => {
    writeFileSync(file, TRICKY);
    const doc = load();
    setEventEntries(doc, 'other.event', []);
    expect(saveSubsDoc(doc, { command: 'remove', rewrite: false })).toMatchObject({ ok: true });
    const after = readFileSync(file, 'utf-8');
    expect(after).not.toContain('other.event');
    expect(after).toContain('# about the second one');
  });

  it('add to an existing event keeps the comments', () => {
    writeFileSync(file, TRICKY);
    const doc = load();
    setEventEntries(doc, 'deploy.done', [...eventEntries(doc, 'deploy.done'), { type: 'cli', name: 'third', command: 'echo 3' }]);
    expect(saveSubsDoc(doc, { command: 'add', rewrite: false, appended: { event: 'deploy.done', entry: { type: 'cli', name: 'third', command: 'echo 3' } } })).toMatchObject({ ok: true, mode: 'rewrite' });
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('# about the second one');
    expect(after).toContain('mask: 0x1F');
    expect(after).toContain('name: third');
  });

  it('keeps the CRLF line endings of the file', () => {
    writeFileSync(file, TRICKY.replace(/\n/g, '\r\n'));
    expect(edit(load(), 'deploy.done', 0, { timeout: '9s' })).toMatchObject({ ok: true });
    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('timeout: 9s');
    expect(after).not.toMatch(/[^\r]\n/);
  });

  it('what is written reads back, through the loader, as exactly the edited document', () => {
    writeFileSync(file, TRICKY);
    const doc = load();
    edit(doc, 'deploy.done', 1, { timeout: '9s' });
    expect(yamlLoad(readFileSync(file, 'utf-8'))).toEqual(doc.raw);
  });

  it('a change that cannot be made in place is refused without --rewrite, and the file is untouched', () => {
    const text = lines('# keep', 'x-base: &b', '  type: cli', '  command: echo base', '  timeout: 5s', 'subscribers:', '  a:', '    - <<: *b', '      name: one');
    writeFileSync(file, text);
    // The timeout comes from the merge key: removing it cannot be done on the entry itself
    const withoutTimeout = (d: SubsDoc): void => setEventEntries(d, 'a', eventEntries(d, 'a').map(({ timeout: _timeout, ...rest }) => rest));
    const first = load();
    withoutTimeout(first);
    const result = saveSubsDoc(first, { command: 'edit', rewrite: false });
    expect(result).toMatchObject({ error: expect.stringContaining('--rewrite') });
    expect(readFileSync(file, 'utf-8')).toBe(text);
    const doc = load();
    withoutTimeout(doc);
    expect(saveSubsDoc(doc, { command: 'edit', rewrite: true })).toMatchObject({ ok: true, mode: 'rewrite', lost: expect.stringContaining('comment') });
    expect(yamlLoad(readFileSync(file, 'utf-8'))).toEqual(doc.raw);
  });
});

describe('saveSubsDoc - a symlinked subscribers.yml stays a symlink', () => {
  it('writes through the link: the target changes, the link path is still the link (injected link detection)', () => {
    const target = join(dir, 'real.yml');
    writeFileSync(target, 'subscribers:\n  a:\n    - type: cli\n      name: x\n      command: echo\n');
    const loaded = loadSubsDoc(target);
    if ('error' in loaded) {
      throw new Error(loaded.error);
    }
    const doc = loaded.doc;
    // The path the user gave is `file`; it is reported as a link to `target`
    doc.filePath = file;
    setEventEntries(doc, 'a', [{ type: 'cli', name: 'x', command: 'echo', timeout: '9s' }]);
    const result = saveSubsDoc(doc, { command: 'edit', rewrite: false, fs: { isSymlink: (p) => p === file, realpath: (p) => (p === file ? target : p) } });
    expect(result).toMatchObject({ ok: true });
    expect(readFileSync(target, 'utf-8')).toContain('timeout: 9s');
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['real.yml']);
  });

  it('refuses, naming the file, when the link cannot be resolved', () => {
    writeFileSync(file, 'subscribers:\n  a: []\n');
    const doc = load();
    setEventEntries(doc, 'a', [{ type: 'cli', name: 'x', command: 'echo' }]);
    const result = saveSubsDoc(doc, { command: 'add', rewrite: false, fs: { isSymlink: () => true, realpath: () => { throw new Error('ENOENT: dangling'); } } });
    expect(result).toMatchObject({ error: expect.stringContaining(file) });
    expect((result as { error: string }).error).toContain('dangling');
    expect(readFileSync(file, 'utf-8')).toBe('subscribers:\n  a: []\n');
  });

  it('a real symlink (skipped with a message where the OS refuses to create one)', (ctx) => {
    const target = join(dir, 'real.yml');
    writeFileSync(target, 'subscribers:\n  a:\n    - type: cli\n      name: x\n      command: echo\n');
    try {
      symlinkSync(target, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') {
        ctx.skip(`cannot create a symlink on this Windows session (EPERM): the injected-seam tests above cover the logic`);
      }
      throw err;
    }
    const doc = load();
    setEventEntries(doc, 'a', [{ type: 'cli', name: 'x', command: 'echo', timeout: '9s' }]);
    expect(saveSubsDoc(doc, { command: 'edit', rewrite: false })).toMatchObject({ ok: true });
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('timeout: 9s');
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

  it('a file without comments is rewritten without ceremony, and nothing but the data changes', () => {
    writeFileSync(file, lines('subscribers:', '  a:', '    - type: cli', '      name: x', '      command: echo', '      notes: n', '  o:', '    cwd: sub', '    commands:', '      - type: cli', '        name: y', '        command: echo'));
    const doc = load();
    setEventEntries(doc, 'a', [{ ...eventEntries(doc, 'a')[0]!, retries: 3 }]);
    expect(saveSubsDoc(doc, { command: 'edit', rewrite: false })).toEqual({ ok: true, mode: 'rewrite' });
    const after = yamlLoad(readFileSync(file, 'utf-8')) as { subscribers: Record<string, any> };
    expect(after.subscribers['a'][0]).toMatchObject({ retries: 3, notes: 'n' });
    expect(after.subscribers['o']).toMatchObject({ cwd: 'sub', commands: [{ name: 'y' }] });
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
