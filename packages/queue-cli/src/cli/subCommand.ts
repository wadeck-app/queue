import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { findProjectForPath, loadRegistry } from '@wadeck-app/project-sdk';
import { eventPatternProblem, getErrorMessage, type ActionRegistry, type SubscriberConfig, type SubscriberListResponse } from '@wadeck-app/queue-core';
import { scanFlags } from './flagScan.js';
import { buildSubscriberEntry, entryProblems, locateSubscriber, mergeSubscriberEntry, parseScopeFlag, parseSubFlags, renameSubscriber, subscriberTarget, unnamedLine, type SubCommand } from './subscriberEntry.js';
import { actionEntryProblems, checkActionLoops, undeclaredEventWarning } from './subscriberChecks.js';
import { eventEntries, loadSubsDoc, saveSubsDoc, setEventEntries, type SaveResult, type SubsDoc } from './subscribersEdit.js';
import { subscribersFileFor } from './subscribersFile.js';

/** `queue sub list|add|edit|remove`: everything it needs from the outside comes in through here, so it runs in a test without a process, a daemon or a TTY. */
export interface SubDeps {
  configDir: string;
  cwd: string;
  registryDir: string;
  io: { stdout: { write: (text: string) => unknown }; stderr: { write: (text: string) => unknown } };
  isTTY: boolean;
  /** The action plugins of this CLI (checked when an action subscriber is written or listed). */
  actions: () => ActionRegistry;
  /** `queue sub list` without --scope asks the daemon, which knows the project of the cwd and checks the actions. */
  listFromDaemon: (event: string | undefined) => Promise<SubscriberListResponse['subscribers']>;
  help: string;
}

interface ListedEntry {
  subscriberId: string;
  event: string;
  type: string;
  command?: string;
  url?: string;
  action?: string;
  with?: Record<string, unknown>;
  problem?: string;
}

type Scope = 'global' | 'project';

function fail(deps: SubDeps, message: string): number {
  deps.io.stderr.write(`[fail] ${message}\n`);
  return 1;
}

function warn(deps: SubDeps, message: string): void {
  deps.io.stderr.write(`[warn] ${message}\n`);
}

function resolveFile(deps: SubDeps, scope: Scope): { file: string } | { code: number } {
  const target = subscribersFileFor(scope, { configDir: deps.configDir, cwd: deps.cwd, registryDir: deps.registryDir });
  return 'error' in target ? { code: fail(deps, target.error) } : { file: target.file };
}

/** The keys nothing reads (a typo, a note): the schema of the loader strips them, so they are said, never hidden. */
function warnUnknownKeys(doc: SubsDoc, deps: SubDeps): void {
  for (const found of doc.unknownKeys) {
    warn(deps, `${doc.filePath}: ${found.message}`);
  }
}

function afterOf(doc: SubsDoc): Record<string, SubscriberConfig[]> {
  const after: Record<string, SubscriberConfig[]> = {};
  for (const event of Object.keys(doc.raw.subscribers)) {
    after[event] = eventEntries(doc, event);
  }
  return after;
}

/** The problem an action subscriber has that the daemon would log, undefined for a healthy one and for any other type. */
function actionProblemOf(entry: SubscriberConfig, event: string, actions: ActionRegistry): string | undefined {
  if (entry.type !== 'action' || entry.action === undefined) {
    return undefined;
  }
  const plugin = actions.get(entry.action);
  if (plugin === undefined) {
    return actions.unknownActionProblem(entry.action);
  }
  const problem = plugin.validate(entry.with ?? {}, { event, ...(entry.name !== undefined && { name: entry.name }) });
  return problem === undefined ? undefined : `action '${entry.action}' refuses its 'with:' block: ${problem} Fix: correct the 'with:' block of the subscriber.`;
}

function warnProblem(deps: SubDeps, subscriberId: string, event: string, problem: string): void {
  warn(deps, `subscriber ${subscriberId} (event '${event}') cannot run: ${problem} Its events go to the dead-letter queue until this is fixed (queue dlq list).`);
}

/**
 * What `queue sub add|edit` checks for an action subscriber before the file is written: the registry (unknown action, `with` block), a warning for an
 * undeclared emitted event, and loops with the other action subscribers (a certain loop refuses the change, a possible one is a warning). Returns an exit code on a refusal.
 */
function checkActionEntry(entry: SubscriberConfig, event: string, doc: SubsDoc, scope: Scope, deps: SubDeps): number | undefined {
  if (entry.type !== 'action') {
    return undefined;
  }
  const actions = deps.actions();
  const problems = actionEntryProblems(entry, event, actions);
  if (problems.length > 0) {
    for (const problem of problems) {
      deps.io.stderr.write(`[fail] ${problem}\n`);
    }
    return 1;
  }
  const loops = checkActionLoops({
    configDir: deps.configDir,
    registryDir: deps.registryDir,
    cwd: deps.cwd,
    scope,
    filePath: doc.filePath,
    after: afterOf(doc),
    changed: { event, name: entry.name ?? '' },
    actions,
  });
  for (const note of loops.notes) {
    warn(deps, note);
  }
  if (loops.errors.length > 0) {
    for (const message of loops.errors) {
      deps.io.stderr.write(`[fail] ${message}\n`);
    }
    return 1;
  }
  for (const message of loops.warnings) {
    warn(deps, message);
  }
  const undeclared = undeclaredEventWarning(entry, actions, deps.configDir);
  if (undeclared !== undefined) {
    warn(deps, undeclared);
  }
  return undefined;
}

/** Turns what saveSubsDoc answered into the exit code, saying what was dropped by a --rewrite. */
function finishSave(result: SaveResult, deps: SubDeps): number | undefined {
  if ('error' in result) {
    return fail(deps, result.error);
  }
  if (result.lost !== undefined) {
    warn(deps, result.lost);
  }
  return undefined;
}

async function listCommand(args: string[], scope: { scope: Scope; given: boolean }, deps: SubDeps): Promise<number> {
  const scan = scanFlags(args, { values: ['--scope'], switches: ['--json'] }, 'queue sub list', [], 1);
  for (const issue of scan.issues) {
    if (issue.kind === 'unknown' || issue.kind === 'stray') {
      warn(deps, issue.message);
    } else {
      return fail(deps, issue.message);
    }
  }
  const json = scan.switches.has('--json');
  const eventArg = scan.positionals[0];
  const asText = deps.isTTY && !json;

  if (!scope.given) {
    // No --scope: the daemon answers (the global file and the project of the cwd, action problems included)
    const subscribers = await deps.listFromDaemon(eventArg);
    for (const sub of subscribers) {
      if (sub.problem !== undefined) {
        warnProblem(deps, sub.subscriberId, sub.event, sub.problem);
      }
    }
    // The daemon cannot tell a key it stripped: the files are read here for the unknown ones
    for (const wanted of ['global', 'project'] as const) {
      const target = subscribersFileFor(wanted, { configDir: deps.configDir, cwd: deps.cwd, registryDir: deps.registryDir });
      if (!('error' in target)) {
        const loaded = loadSubsDoc(target.file);
        if ('doc' in loaded) {
          warnUnknownKeys(loaded.doc, deps);
        }
      }
    }
    if (asText) {
      if (subscribers.length === 0) {
        deps.io.stdout.write('[ok] no subscribers\n');
      } else {
        for (const sub of subscribers) {
          deps.io.stdout.write(`[ok] ${sub.subscriberId}  ${sub.type}  ${subscriberTarget(sub) ?? '?'}\n`);
        }
      }
    } else {
      deps.io.stdout.write(JSON.stringify(subscribers, null, 2) + '\n');
    }
    return 0;
  }

  const resolved = resolveFile(deps, scope.scope);
  if ('code' in resolved) {
    return resolved.code;
  }
  const loaded = loadSubsDoc(resolved.file);
  if ('error' in loaded) {
    return fail(deps, loaded.error);
  }
  const doc = loaded.doc;
  warnUnknownKeys(doc, deps);

  // The ids are the ones of the daemon list, the history and the DLQ: '<project id>/' for a project file, '@<event>' for a name used under several events
  let prefix = '';
  if (scope.scope === 'project') {
    try {
      const match = findProjectForPath(loadRegistry(deps.registryDir), deps.cwd);
      prefix = match === undefined ? '' : `${match.project.id}/`;
    } catch (err) {
      return fail(deps, `the project registry in ${deps.registryDir} could not be read: ${getErrorMessage(err)}`);
    }
  }
  const holders = new Map<string, number>();
  for (const event of Object.keys(doc.raw.subscribers)) {
    for (const s of eventEntries(doc, event)) {
      if (s.name !== undefined) {
        holders.set(s.name, (holders.get(s.name) ?? 0) + 1);
      }
    }
  }
  const actions = deps.actions();
  const entries: ListedEntry[] = [];
  for (const event of Object.keys(doc.raw.subscribers)) {
    if (eventArg !== undefined && event !== eventArg) {
      continue;
    }
    eventEntries(doc, event).forEach((s, i) => {
      const subscriberId = s.name === undefined ? `(unnamed: ${event} index ${i})` : `${prefix}${s.name}${(holders.get(s.name) ?? 0) > 1 ? `@${event}` : ''}`;
      const problem = actionProblemOf(s, event, actions);
      entries.push({
        subscriberId,
        event,
        type: s.type,
        ...(s.command !== undefined && { command: s.command }),
        ...(s.url !== undefined && { url: s.url }),
        ...(s.action !== undefined && { action: s.action }),
        ...(s.with !== undefined && { with: s.with }),
        ...(problem !== undefined && { problem }),
      });
      if (s.name === undefined) {
        deps.io.stderr.write(`${unnamedLine(event, i, scope.scope)}\n`);
      }
      if (problem !== undefined) {
        warnProblem(deps, subscriberId, event, problem);
      }
    });
  }
  if (asText) {
    if (entries.length === 0) {
      deps.io.stdout.write('[ok] no subscribers\n');
    } else {
      for (const e of entries) {
        deps.io.stdout.write(`[ok] ${e.subscriberId}  ${e.type}  ${subscriberTarget(e) ?? '?'}\n`);
      }
    }
  } else {
    deps.io.stdout.write(JSON.stringify(entries, null, 2) + '\n');
  }
  return 0;
}

async function addCommand(event: string, args: string[], scope: Scope, deps: SubDeps): Promise<number> {
  const { config, errors, rewrite } = parseSubFlags(args, 'add');
  if (errors.length > 0) {
    errors.forEach((e) => fail(deps, e));
    return 1;
  }
  if (!config.type) {
    deps.io.stderr.write('[fail] --type cli|http|action is required\nUsage: queue sub add <event> --type cli|http|action ...\n');
    return 1;
  }
  if (config.name === undefined) {
    return fail(deps, '--name is required: it tells the dashboard, the history, the DLQ and the logs who listens, e.g. --name notify');
  }
  // A key that can never match ('**', 'dep.pub*', 'on..x', a '>' that is not last) would leave the subscriber silently never firing (the loader refuses it too)
  const eventProblem = eventPatternProblem(event);
  if (eventProblem !== null) {
    return fail(deps, `<event> ${eventProblem}`);
  }
  const newEntry = buildSubscriberEntry(config);
  const missing = entryProblems(newEntry, {});
  if (missing.length > 0) {
    missing.forEach((problem) => fail(deps, problem));
    return 1;
  }

  const resolved = resolveFile(deps, scope);
  if ('code' in resolved) {
    return resolved.code;
  }
  if (scope === 'project') {
    mkdirSync(dirname(resolved.file), { recursive: true });
  }
  const loaded = loadSubsDoc(resolved.file);
  if ('error' in loaded) {
    return fail(deps, loaded.error);
  }
  const doc = loaded.doc;
  warnUnknownKeys(doc, deps);
  const existing = eventEntries(doc, event);
  if (existing.some((entry) => entry.name === config.name)) {
    return fail(deps, `'${event}' already has a subscriber named '${config.name}' in ${doc.filePath}: a name identifies one subscriber of an event. Choose another --name, or edit that one: queue sub edit ${event} --name ${config.name} ...`);
  }
  setEventEntries(doc, event, [...existing, newEntry]);
  const refused = checkActionEntry(newEntry, event, doc, scope, deps);
  if (refused !== undefined) {
    return refused;
  }
  const saved = finishSave(saveSubsDoc(doc, { command: 'add', rewrite, appended: { event, entry: newEntry } }), deps);
  if (saved !== undefined) {
    return saved;
  }
  deps.io.stdout.write(`[ok] Added subscriber '${config.name}' to '${event}' (index ${existing.length}) in ${doc.filePath}\n`);
  return 0;
}

async function removeCommand(event: string, args: string[], scope: Scope, deps: SubDeps): Promise<number> {
  const { errors, rewrite } = parseSubFlags(args, 'remove');
  if (errors.length > 0) {
    errors.forEach((e) => fail(deps, e));
    return 1;
  }
  const resolved = resolveFile(deps, scope);
  if ('code' in resolved) {
    return resolved.code;
  }
  const loaded = loadSubsDoc(resolved.file);
  if ('error' in loaded) {
    return fail(deps, loaded.error);
  }
  const doc = loaded.doc;
  if (!doc.exists) {
    return fail(deps, `No subscribers file at: ${doc.filePath}`);
  }
  warnUnknownKeys(doc, deps);
  const subs = eventEntries(doc, event);
  const located = locateSubscriber(subs, event, args);
  if ('error' in located) {
    return fail(deps, located.error);
  }
  setEventEntries(doc, event, subs.filter((_, i) => i !== located.index));
  const saved = finishSave(saveSubsDoc(doc, { command: 'remove', rewrite }), deps);
  if (saved !== undefined) {
    return saved;
  }
  deps.io.stdout.write(`[ok] Removed subscriber at index ${located.index} from '${event}' in ${doc.filePath}\n`);
  return 0;
}

async function editCommand(event: string, args: string[], scope: Scope, deps: SubDeps): Promise<number> {
  const { config, errors, unset, rewrite, given } = parseSubFlags(args, 'edit');
  if (errors.length > 0) {
    errors.forEach((e) => fail(deps, e));
    return 1;
  }
  const resolved = resolveFile(deps, scope);
  if ('code' in resolved) {
    return resolved.code;
  }
  const loaded = loadSubsDoc(resolved.file);
  if ('error' in loaded) {
    return fail(deps, loaded.error);
  }
  const doc = loaded.doc;
  if (!doc.exists) {
    return fail(deps, `No subscribers file at: ${doc.filePath}`);
  }
  warnUnknownKeys(doc, deps);
  const subs = eventEntries(doc, event);
  const located = locateSubscriber(subs, event, args);
  if ('error' in located) {
    return fail(deps, located.error);
  }
  const index = located.index;
  const previous = subs[index]!;

  // The locating flags (--index, --name) are not changes: nothing else given means there is nothing to do
  const changes = Object.keys(config).filter((key) => !(key === 'name' && config.name === previous.name));
  if (changes.length === 0 && unset.length === 0) {
    return fail(deps, `nothing to change for the subscriber at index ${index} of '${event}': pass what to change (--timeout, --retries, --backoff, --when, --command, --url, --header, --set, --name, --type...) or what to remove (--unset <field>, e.g. --unset timeout)`);
  }

  // --name alone only names the entry (the fix the unnamed-subscriber warning gives); with --unset it is part of a larger change
  const renamed = unset.length === 0 ? renameSubscriber(subs, index, config) : undefined;
  let newSubs: SubscriberConfig[];
  let newEntry: SubscriberConfig;
  let message: string;
  if (renamed !== undefined) {
    if ('error' in renamed) {
      return fail(deps, renamed.error);
    }
    newSubs = renamed.subs;
    newEntry = newSubs[index]!;
    message = `[ok] Named the subscriber at index ${index} of '${event}' '${config.name}' in ${doc.filePath}\n`;
  } else {
    const merged = mergeSubscriberEntry(previous, { config, unset, given });
    if ('errors' in merged) {
      merged.errors.forEach((e) => fail(deps, e));
      return 1;
    }
    const missing = entryProblems(merged.entry, { from: previous.type, cleared: merged.cleared });
    if (missing.length > 0) {
      missing.forEach((problem) => fail(deps, problem));
      return 1;
    }
    if (merged.entry.name !== undefined) {
      const clash = subs.findIndex((s, i) => i !== index && s.name === merged.entry.name);
      if (clash !== -1) {
        return fail(deps, `The name '${merged.entry.name}' is already used by the subscriber at index ${clash} of this event: names are unique per event within a file`);
      }
    }
    merged.notes.forEach((note) => warn(deps, note));
    if (merged.cleared.length > 0) {
      warn(deps, `changing the type from ${previous.type} to ${merged.entry.type} cleared: ${merged.cleared.join(', ')}`);
    }
    newEntry = merged.entry;
    newSubs = subs.map((s, i) => (i === index ? newEntry : s));
    message = `[ok] Updated subscriber at index ${index} for '${event}' in ${doc.filePath}\n`;
  }
  setEventEntries(doc, event, newSubs);
  const refused = checkActionEntry(newEntry, event, doc, scope, deps);
  if (refused !== undefined) {
    return refused;
  }
  const saved = finishSave(saveSubsDoc(doc, { command: 'edit', rewrite }), deps);
  if (saved !== undefined) {
    return saved;
  }
  deps.io.stdout.write(message);
  return 0;
}

/** `queue sub ...` (args are everything after `sub`). Returns the exit code; every refusal says what to fix. */
export async function runSubCommand(args: string[], deps: SubDeps): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    deps.io.stdout.write(deps.help);
    return 0;
  }
  const scope = parseScopeFlag(args);
  if ('error' in scope) {
    return fail(deps, scope.error);
  }
  if (sub === 'list') {
    return listCommand(args.slice(1), scope, deps);
  }
  if (sub !== 'add' && sub !== 'remove' && sub !== 'edit') {
    deps.io.stderr.write(`Unknown sub subcommand: ${sub}\nUse: queue sub list|add|remove|edit\n`);
    return 1;
  }
  const event = args[1];
  if (!event || event.startsWith('--')) {
    deps.io.stderr.write(`Usage: queue sub ${sub} <event> [...]\n`);
    return 1;
  }
  const command: SubCommand = sub;
  const flags = args.slice(2);
  if (command === 'add') {
    return addCommand(event, flags, scope.scope, deps);
  }
  return command === 'remove' ? removeCommand(event, flags, scope.scope, deps) : editCommand(event, flags, scope.scope, deps);
}
