import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import {
  ProjectResolver, SubscribersYmlSchema, findActionCycles, getErrorMessage, readCatalog,
  type ActionRegistry, type CycleSubscriber, type SubscriberConfig,
} from '@wadeck-app/queue-core';

/**
 * What `queue sub add|edit` refuses for an action subscriber, before the file is written: the same checks the daemon runs when it loads the file,
 * so the problem is met while the user is at the keyboard. Empty for a subscriber that is not an action.
 */
export function actionEntryProblems(entry: SubscriberConfig, event: string, actions: ActionRegistry): string[] {
  if (entry.type !== 'action') {
    return [];
  }
  if (entry.action === undefined) {
    return [`--action is required for type: action. Available actions: ${actions.names().join(', ')}. Example: --action emit`];
  }
  const plugin = actions.get(entry.action);
  if (plugin === undefined) {
    return [actions.unknownActionProblem(entry.action)];
  }
  const problem = plugin.validate(entry.with ?? {}, { event, ...(entry.name !== undefined && { name: entry.name }) });
  return problem === undefined ? [] : [`action '${entry.action}': ${problem} Fix: correct the --set flags.`];
}

/** A warning when the event an action emits is declared by no program (the catalog is how `queue events list` and `queue wait` know an event), undefined otherwise. */
export function undeclaredEventWarning(entry: SubscriberConfig, actions: ActionRegistry, configDir: string): string | undefined {
  if (entry.type !== 'action' || entry.action === undefined) {
    return undefined;
  }
  const plugin = actions.get(entry.action);
  const emitted = plugin?.emits?.(entry.with ?? {});
  if (emitted === undefined) {
    return undefined;
  }
  // The plugin declares its own events in the catalog when the daemon starts: nothing for the user to declare
  if (plugin?.events?.some((declared) => declared.name === emitted)) {
    return undefined;
  }
  const catalog = readCatalog(configDir);
  if (catalog.sources.some((source) => source.events.some((declared) => declared.name === emitted))) {
    return undefined;
  }
  return (
    `the action emits '${emitted}', which no program has declared in the events catalog (queue events list). It still works; ` +
    `the program that owns this event should declare it (queue events register) so that 'queue events show ${emitted}' and 'queue wait' know it.`
  );
}

interface FileSource {
  file: string;
  /** The registered project that owns the file; absent for the global file. */
  projectId?: string;
}

export interface LoopCheckInput {
  configDir: string;
  registryDir: string;
  cwd: string;
  scope: 'global' | 'project';
  /** The subscribers.yml being written, and what it will contain. */
  filePath: string;
  after: Record<string, SubscriberConfig[]>;
  /** The subscriber being added or edited. */
  changed: { event: string; name: string };
  actions: ActionRegistry;
}

export interface LoopCheckResult {
  /** The change would create a loop with no `when:` anywhere in it: refuse it. */
  errors: string[];
  /** A loop that a `when:` may break: say it, write it. */
  warnings: string[];
  /** Files that could not be read for the check, with why: said, never hidden. */
  notes: string[];
}

function readFileEntries(file: string): Record<string, SubscriberConfig[]> {
  if (!existsSync(file)) {
    return {};
  }
  const parsed = SubscribersYmlSchema.parse(yamlLoad(readFileSync(file, 'utf-8')));
  const result: Record<string, SubscriberConfig[]> = {};
  for (const [event, config] of Object.entries(parsed.subscribers)) {
    result[event] = (Array.isArray(config) ? config : config.commands) as SubscriberConfig[];
  }
  return result;
}

/**
 * Looks for a loop between action subscribers once `after` is written: reads the global file and the file of every registered project (the same view
 * the daemon logs at start), with the file being written replaced by what it will contain. Only loops that involve the changed subscriber count:
 * a loop already in some other file is not this change's to refuse. Never throws; a file it cannot read goes to `notes`.
 */
export function checkActionLoops(input: LoopCheckInput): LoopCheckResult {
  const result: LoopCheckResult = { errors: [], warnings: [], notes: [] };
  const sources: FileSource[] = [{ file: join(input.configDir, 'subscribers.yml') }];
  const chains = new Map<string, string[]>();
  const resolver = new ProjectResolver(input.registryDir);
  try {
    for (const source of resolver.allConfigSources()) {
      chains.set(source.projectId, source.layers.map((layer) => layer.projectId));
      for (const layer of source.layers) {
        sources.push({ file: join(layer.dir, 'subscribers.yml'), projectId: layer.projectId });
      }
    }
  } catch (err) {
    result.notes.push(`the project registry could not be read, so only the global subscribers.yml and the file being written were checked for loops: ${getErrorMessage(err)}`);
  }
  let changedProjectId: string | undefined;
  if (input.scope === 'project') {
    const lookup = resolver.lookup(input.cwd);
    changedProjectId = lookup.kind === 'registered' ? lookup.project.id : undefined;
  }
  // Windows paths are not case sensitive
  const normalize = (path: string): string => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  const sameFile = (a: string, b: string): boolean => normalize(a) === normalize(b);
  if (!sources.some((source) => sameFile(source.file, input.filePath))) {
    sources.push({ file: input.filePath, ...(changedProjectId !== undefined && { projectId: changedProjectId }) });
  }

  const nodes = new Map<string, CycleSubscriber>();
  for (const source of sources) {
    let entries: Record<string, SubscriberConfig[]>;
    if (sameFile(source.file, input.filePath)) {
      entries = input.after;
    } else {
      try {
        entries = readFileEntries(source.file);
      } catch (err) {
        result.notes.push(`${source.file} could not be read for the loop check (${getErrorMessage(err)}); loops through it are not detected`);
        continue;
      }
    }
    for (const [event, list] of Object.entries(entries)) {
      list.forEach((entry, index) => {
        const name = entry.name ?? `${event}[${index}]`;
        const subscriberId = source.projectId === undefined ? name : `${source.projectId}/${name}`;
        nodes.set(`${source.file}\u0000${subscriberId}\u0000${event}`, {
          subscriberId,
          event,
          type: entry.type,
          ...(entry.action !== undefined && { action: entry.action }),
          ...(entry.with !== undefined && { with: entry.with }),
          ...(entry.when !== undefined && { when: entry.when }),
          ...(source.projectId !== undefined && { projectId: source.projectId }),
        });
      });
    }
  }

  const changedId = changedProjectId === undefined ? input.changed.name : `${changedProjectId}/${input.changed.name}`;
  try {
    for (const finding of findActionCycles([...nodes.values()], input.actions, { chains })) {
      if (!finding.members.includes(changedId)) {
        continue;
      }
      (finding.severity === 'error' ? result.errors : result.warnings).push(finding.message);
    }
  } catch (err) {
    result.notes.push(`the loop check failed: ${getErrorMessage(err)}`);
  }
  return result;
}
