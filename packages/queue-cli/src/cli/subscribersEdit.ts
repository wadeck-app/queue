import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { SubscribersYmlSchema, findUnknownKeys, getErrorMessage, isRecord, type SubscriberConfig, type UnknownKeyFinding } from '@wadeck-app/queue-core';

/**
 * Reading and writing a subscribers.yml for `queue sub add|edit|remove` without losing what the user wrote.
 *
 * The file is edited as the YAML value it parses to (not as what the loader's schema keeps, which strips unknown keys), so a key this CLI does not know
 * (`notes`, a typo like `timout`) and the form of every event (array, or `{cwd, env, commands}`) are written back as they were.
 * Comments cannot be kept by a dependency-free dump: `add` of a new event is therefore appended as text (the file stays byte for byte as it was); any
 * other change that would drop a comment is refused unless the user passes `--rewrite`.
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

export interface RewriteLoss {
  line: number;
  /** What would be lost: "a comment" or "an anchor or alias". */
  what: string;
  snippet: string;
}

/**
 * The first thing in `text` that dumping the parsed value would not bring back: a comment (a `#` that starts a line or follows a space, outside a quoted
 * scalar) or a YAML anchor/alias (the dump expands them). Conservative on purpose: a `#` inside a block scalar counts, the user can pass `--rewrite`.
 */
export function findRewriteLoss(text: string): RewriteLoss | undefined {
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let quote: '"' | "'" | undefined;
    for (let j = 0; j < row.length; j++) {
      const c = row[j]!;
      const before = j === 0 ? '' : row[j - 1]!;
      if (quote === '"') {
        if (c === '\\') {
          j++;
        } else if (c === '"') {
          quote = undefined;
        }
        continue;
      }
      if (quote === "'") {
        if (c === "'") {
          if (row[j + 1] === "'") {
            j++;
          } else {
            quote = undefined;
          }
        }
        continue;
      }
      const startsToken = before === '' || /\s/.test(before);
      if (c === '#' && startsToken) {
        return { line: i + 1, what: 'a comment', snippet: row.trim() };
      }
      // A quote opens a quoted scalar only where a value or an item starts; inside a plain scalar it is a character
      if ((c === '"' || c === "'") && (startsToken || /[[{,]/.test(before))) {
        const lead = row.slice(0, j).trimEnd();
        if (lead === '' || /[:\-,[{?]$/.test(lead)) {
          quote = c;
          continue;
        }
      }
      if ((c === '&' || c === '*') && startsToken && /[A-Za-z0-9_-]/.test(row[j + 1] ?? '')) {
        return { line: i + 1, what: 'an anchor or alias', snippet: row.trim() };
      }
    }
  }
  return undefined;
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

function writeAtomically(filePath: string, content: string): string | undefined {
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpPath, filePath);
    return undefined;
  } catch (err) {
    return `Failed to write ${filePath}: ${getErrorMessage(err)}`;
  }
}

/**
 * Writes the document back. `appended` (the event just added, which was not in the file) is written as a text append, so the file stays as it was. Any
 * other write is a dump of the parsed value: refused with the way out when it would drop a comment, unless `rewrite`.
 */
export function saveSubsDoc(doc: SubsDoc, options: { command: 'add' | 'edit' | 'remove'; rewrite: boolean; appended?: { event: string; entry: object } }): SaveResult {
  const checked = SubscribersYmlSchema.safeParse(doc.raw);
  if (!checked.success) {
    return { error: `Invalid subscriber config: ${checked.error.toString()}` };
  }
  if (!doc.exists) {
    const failure = writeAtomically(doc.filePath, yamlDump(doc.raw, { lineWidth: -1, noRefs: true }));
    return failure === undefined ? { ok: true, mode: 'create' } : { error: failure };
  }
  const { appended } = options;
  if (appended !== undefined && !Object.hasOwn(doc.original.subscribers, appended.event)) {
    const text = appendEventBlock(doc.text, appended.event, appended.entry, doc.raw);
    if (text !== undefined) {
      const failure = writeAtomically(doc.filePath, text);
      return failure === undefined ? { ok: true, mode: 'append' } : { error: failure };
    }
  }
  const loss = findRewriteLoss(doc.text);
  if (loss !== undefined && !options.rewrite) {
    return {
      error:
        `${doc.filePath} has ${loss.what} (line ${loss.line}: ${loss.snippet}), and 'queue sub ${options.command}' has to rewrite the whole file for this change, which would delete ${loss.what === 'a comment' ? 'its comments' : 'it'}. ` +
        `Fix: make the change by hand in the file, or add --rewrite to rewrite it anyway (comments and formatting are lost, the subscribers and their keys are kept).`,
    };
  }
  const failure = writeAtomically(doc.filePath, yamlDump(doc.raw, { lineWidth: -1, noRefs: true }));
  if (failure !== undefined) {
    return { error: failure };
  }
  return { ok: true, mode: 'rewrite', ...(loss !== undefined && { lost: `${loss.what} (first at line ${loss.line}) was dropped by --rewrite` }) };
}
