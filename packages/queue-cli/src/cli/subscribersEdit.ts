import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { Document, Pair, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';
import { SubscribersYmlSchema, findUnknownKeys, getErrorMessage, isRecord, type SubscriberConfig, type UnknownKeyFinding } from '@wadeck-app/queue-core';

/**
 * Reading and writing a subscribers.yml for `queue sub add|edit|remove` without losing what the user wrote.
 *
 * The file is edited as the YAML value it parses to (not as what the loader's schema keeps, which strips unknown keys), so a key this CLI does not know
 * (`notes`, a typo like `timout`) and the form of every event (array, or `{cwd, env, commands}`) are written back as they were.
 * A new event is appended as text (the file stays byte for byte as it was); any other change is made in place with the `yaml` package's Document API, which
 * keeps comments, anchors and the written text of every value that did not change. If that cannot be verified, the change is refused unless `--rewrite`.
 */

export interface SubsDoc {
  filePath: string;
  /** False when there is no file yet. */
  exists: boolean;
  /** The file as read ('' when it does not exist). */
  text: string;
  /** The parsed document, edited in place by the caller. */
  raw: { subscribers: Record<string, unknown>; [key: string]: unknown };
  /** The parsed document as read: tells whether an event was already in the file. */
  original: { subscribers: Record<string, unknown> };
  unknownKeys: UnknownKeyFinding[];
}

/** Reads and validates `filePath`; an error says which file and what is wrong. A missing file, an empty one and one with only comments are empty documents. */
export function loadSubsDoc(filePath: string): { doc: SubsDoc } | { error: string } {
  const exists = existsSync(filePath);
  const text = exists ? readFileSync(filePath, 'utf-8') : '';
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (err) {
    return { error: `Failed to parse YAML at ${filePath}: ${getErrorMessage(err)}` };
  }
  const raw = parsed === undefined || parsed === null ? { subscribers: {} } : parsed;
  const checked = SubscribersYmlSchema.safeParse(raw);
  if (!checked.success) {
    return { error: `Invalid subscribers.yml at ${filePath}:\n${checked.error.toString()}` };
  }
  const document = raw as SubsDoc['raw'];
  return { doc: { filePath, exists, text, raw: document, original: structuredClone(document), unknownKeys: findUnknownKeys(raw) } };
}

/** The subscribers of an event, whichever form the file uses. The array is the one in the document: change it, or give a new one to `setEventEntries`. */
export function eventEntries(doc: SubsDoc, event: string): SubscriberConfig[] {
  const value = Object.hasOwn(doc.raw.subscribers, event) ? doc.raw.subscribers[event] : undefined;
  if (Array.isArray(value)) {
    return value as SubscriberConfig[];
  }
  if (isRecord(value) && Array.isArray(value['commands'])) {
    return value['commands'] as SubscriberConfig[];
  }
  return [];
}

/** Stores the subscribers of an event in the form the file already uses (a new event is a plain array). An event left empty is removed, unless its object form still has a cwd or env. */
export function setEventEntries(doc: SubsDoc, event: string, entries: SubscriberConfig[]): void {
  const value = Object.hasOwn(doc.raw.subscribers, event) ? doc.raw.subscribers[event] : undefined;
  if (isRecord(value) && !Array.isArray(value)) {
    const hasExtras = value['cwd'] !== undefined || value['env'] !== undefined;
    if (entries.length === 0 && !hasExtras) {
      delete doc.raw.subscribers[event];
    } else {
      value['commands'] = entries;
    }
    return;
  }
  if (entries.length === 0) {
    delete doc.raw.subscribers[event];
  } else {
    doc.raw.subscribers[event] = entries;
  }
}

/**
 * `text` with the block of a new event added at the end of its `subscribers:` mapping, every other byte untouched; undefined when that cannot be
 * done safely (flow-style mapping, the event is already there, an unexpected layout) or when what comes out does not read back as `expected`.
 */
export function appendEventBlock(text: string, event: string, entry: object, expected: unknown): string | undefined {
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch {
    return undefined;
  }
  const current = isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
  if (parsed !== undefined && parsed !== null && current === undefined) {
    return undefined;
  }
  const subscribers = current?.['subscribers'];
  if (isRecord(subscribers) && Object.hasOwn(subscribers, event)) {
    return undefined;
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = text.split(/\r?\n/);
  const dumped = yamlDump({ [event]: [entry] }, { lineWidth: -1, noRefs: true }).replace(/\n$/, '').split('\n');
  const header = rows.findIndex((row) => /^subscribers\s*:\s*(#.*)?$/.test(row));

  let result: string[];
  if (header === -1) {
    // Only a file without any subscribers key gets one appended
    if (current !== undefined && Object.hasOwn(current, 'subscribers')) {
      return undefined;
    }
    const kept = text === '' || text.endsWith('\n') ? rows.slice(0, -1) : rows;
    result = [...kept, 'subscribers:', ...dumped.map((row) => `  ${row}`)];
  } else {
    let lastContent = header;
    let childIndent: string | undefined;
    for (let i = header + 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.trim() === '') {
        continue;
      }
      if (!/^\s/.test(row)) {
        // A top-level comment belongs to what follows it; any other top-level line ends the mapping
        if (row.startsWith('#')) {
          continue;
        }
        break;
      }
      lastContent = i;
      if (childIndent === undefined && !row.trim().startsWith('#')) {
        childIndent = /^\s*/.exec(row)![0];
      }
    }
    if (childIndent === undefined) {
      return undefined;
    }
    const block = dumped.map((row) => `${childIndent}${row}`);
    const before = rows.slice(0, lastContent + 1);
    const after = rows.slice(lastContent + 1);
    result = [...before, ...block, ...after];
    if (after.length === 0) {
      // A file that did not end with a newline now does
      result.push('');
    }
  }
  const out = result.join(eol) + (header === -1 ? eol : '');
  try {
    return isDeepStrictEqual(yamlLoad(out), expected) ? out : undefined;
  } catch {
    return undefined;
  }
}

export type SaveResult = { ok: true; mode: 'create' | 'append' | 'rewrite'; lost?: string } | { error: string };

/** The two file-system questions the write asks, injectable because creating a symlink needs a privilege on Windows. */
export interface WriteFs {
  isSymlink: (path: string) => boolean;
  realpath: (path: string) => string;
}

const DEFAULT_WRITE_FS: WriteFs = {
  isSymlink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  },
  realpath: (path) => realpathSync(path),
};

/** Writes through a symbolic link (the link stays a link, the file it points to changes); a link that cannot be resolved is refused. */
function writeAtomically(filePath: string, content: string, fs: WriteFs): string | undefined {
  try {
    let target = filePath;
    if (fs.isSymlink(filePath)) {
      try {
        target = fs.realpath(filePath);
      } catch (err) {
        return `${filePath} is a symbolic link whose target cannot be resolved (${getErrorMessage(err)}). Fix: repair the link, or replace it with the real file, then retry.`;
      }
    }
    const tmpPath = `${target}.tmp`;
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, target);
    return undefined;
  } catch (err) {
    return `Failed to write ${filePath}: ${getErrorMessage(err)}`;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function keyText(pair: Pair): string {
  return String(isScalar(pair.key) ? pair.key.value : pair.key);
}

/**
 * A node for a new value, with the quoting that makes the loader read it back as the same value. The file is parsed with the failsafe schema (every scalar
 * stays the text it was written as: `0x1F`, `0755`, `2024-01-01`, a 20-digit integer), so a new value is rendered by a normal document first and parsed
 * the same way, which keeps the quotes it needs (a string "123" or "true" stays quoted).
 */
function newNode(value: unknown): unknown {
  return parseDocument(new Document(value).toString({ lineWidth: 0 }), { schema: 'failsafe' }).contents;
}

/** The new node takes the comments of the one it replaces (the comment of a line stays on that line when its value changes). */
function inheritComments(replacement: unknown, old: unknown): void {
  if (isScalar(replacement) && isNode(old)) {
    if (old.comment !== undefined && old.comment !== null) {
      replacement.comment = old.comment;
    }
    if (old.commentBefore !== undefined && old.commentBefore !== null) {
      replacement.commentBefore = old.commentBefore;
    }
    if (old.spaceBefore === true) {
      replacement.spaceBefore = true;
    }
  }
}

/**
 * Brings `node` (parsed by the `yaml` package from the file) from the value `before` to the value `after` (both parsed by the loader's js-yaml, so the
 * difference between them is exactly what the command changed): a part that did not change keeps its node, so its comments, anchors and the text it was
 * written with stay; only what changed is rewritten.
 */
function reconcile(node: unknown, before: unknown, after: unknown): unknown {
  if (node !== undefined && node !== null && isDeepStrictEqual(before, after)) {
    return node;
  }
  if (isMap(node) && isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) {
        const index = node.items.findIndex((pair) => keyText(pair) === key);
        if (index !== -1) {
          node.items.splice(index, 1);
        }
      }
    }
    for (const key of Object.keys(after)) {
      if (after[key] === undefined) {
        continue;
      }
      const pair = node.items.find((candidate) => keyText(candidate) === key);
      if (pair === undefined) {
        node.items.push(new Pair(newNode(key), newNode(after[key])));
      } else if (Object.hasOwn(before, key)) {
        pair.value = reconcile(pair.value, before[key], after[key]) as typeof pair.value;
      } else {
        pair.value = newNode(after[key]);
      }
    }
    return node;
  }
  if (isSeq(node) && Array.isArray(before) && Array.isArray(after) && node.items.length === before.length) {
    const used = new Set<number>();
    const placed: unknown[] = after.map((item) => {
      const index = before.findIndex((candidate, j) => !used.has(j) && isDeepStrictEqual(candidate, item));
      if (index === -1) {
        return undefined;
      }
      used.add(index);
      return node.items[index];
    });
    // What matched nothing is a changed or a new entry: a changed one takes the place of an entry that was not matched, a new one has no node yet
    const leftovers = before.map((_, j) => j).filter((j) => !used.has(j));
    after.forEach((item, i) => {
      if (placed[i] === undefined) {
        const j = leftovers.shift();
        placed[i] = j === undefined ? newNode(item) : reconcile(node.items[j], before[j], item);
      }
    });
    node.items = placed as typeof node.items;
    return node;
  }
  const created = newNode(after);
  inheritComments(created, node);
  return created;
}

/** True when the document holds a comment anywhere (what a plain dump of the parsed value would drop). */
function hasComments(yamlDoc: Document): boolean {
  let found = Boolean(yamlDoc.comment) || Boolean(yamlDoc.commentBefore);
  visit(yamlDoc, (_key, node) => {
    if (isNode(node) && (Boolean(node.comment) || Boolean(node.commentBefore))) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  });
  return found;
}

/**
 * `text` with the change made in place by the `yaml` package (comments, anchors, and the text of every value that was not changed stay), or undefined
 * when that cannot be done reliably: the package reports an error, or what comes out does not read back through the loader as exactly `doc.raw`.
 */
function editInPlace(doc: SubsDoc): string | undefined {
  const yamlDoc = parseDocument(doc.text, { schema: 'failsafe' });
  if (yamlDoc.errors.length > 0 || !isMap(yamlDoc.contents)) {
    return undefined;
  }
  let out: string;
  try {
    yamlDoc.contents = reconcile(yamlDoc.contents, doc.original, doc.raw) as typeof yamlDoc.contents;
    out = yamlDoc.toString({ lineWidth: 0 });
  } catch {
    return undefined;
  }
  if (doc.text.includes('\r\n')) {
    out = out.replace(/\r?\n/g, '\r\n');
  }
  try {
    return isDeepStrictEqual(yamlLoad(out), doc.raw) ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the document back. A new event (`appended`, not in the file) is a text append, so the file stays as it was. Any other change is made in place by
 * editInPlace. When that cannot be verified the file is left alone with the way out, unless `rewrite`: then the parsed value is dumped (comments and layout lost).
 */
export function saveSubsDoc(
  doc: SubsDoc,
  options: { command: 'add' | 'edit' | 'remove'; rewrite: boolean; appended?: { event: string; entry: object }; fs?: WriteFs },
): SaveResult {
  const fs = options.fs ?? DEFAULT_WRITE_FS;
  const checked = SubscribersYmlSchema.safeParse(doc.raw);
  if (!checked.success) {
    return { error: `Invalid subscriber config: ${checked.error.toString()}` };
  }
  const dump = (): string => yamlDump(doc.raw, { lineWidth: -1, noRefs: true });
  if (!doc.exists) {
    const failure = writeAtomically(doc.filePath, dump(), fs);
    return failure === undefined ? { ok: true, mode: 'create' } : { error: failure };
  }
  const { appended } = options;
  if (appended !== undefined && !Object.hasOwn(doc.original.subscribers, appended.event)) {
    const text = appendEventBlock(doc.text, appended.event, appended.entry, doc.raw);
    if (text !== undefined) {
      const failure = writeAtomically(doc.filePath, text, fs);
      return failure === undefined ? { ok: true, mode: 'append' } : { error: failure };
    }
  }
  const inPlace = editInPlace(doc);
  if (inPlace !== undefined) {
    const failure = writeAtomically(doc.filePath, inPlace, fs);
    return failure === undefined ? { ok: true, mode: 'rewrite' } : { error: failure };
  }
  if (!options.rewrite) {
    return {
      error:
        `'queue sub ${options.command}' could not change ${doc.filePath} in place without altering something else (for example a YAML merge key '<<' or an alias that the change touches). ` +
        `Fix: make the change by hand in the file, or add --rewrite to write the whole file again (comments and formatting are lost, the subscribers and their keys are kept).`,
    };
  }
  const commented = hasComments(parseDocument(doc.text));
  const failure = writeAtomically(doc.filePath, dump(), fs);
  if (failure !== undefined) {
    return { error: failure };
  }
  return { ok: true, mode: 'rewrite', ...(commented && { lost: 'the comments of the file were dropped by --rewrite' }) };
}

