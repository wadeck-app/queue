import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname, resolve, isAbsolute } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { validateLayer, type ConfigSchema } from '@wadeck-app/project-sdk';
import { z } from 'zod';
import { EventMatcher, doubleStarProblem } from './dispatch/EventMatcher.js';
import type { ResolvedSubscriber } from './types.js';
import { getErrorMessage } from './errors.js';
import { isRecord } from './isRecord.js';
import { findTemplateProblem } from './dispatch/commandTemplate.js';
import type { ActionRegistry } from './actions/ActionRegistry.js';

const SubscriberConfigSchema = z.object({
  type: z.enum(['cli', 'http', 'action']),
  name: z.string().optional(),
  action: z.string().optional(),
  with: z.record(z.unknown()).optional(),
  command: z.string().optional(),
  url: z.string().optional(),
  method: z.string().optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.string().optional(),
  retries: z.number().int().nonnegative().optional(),
  backoff: z.enum(['exponential', 'linear']).optional(),
  when: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
});

// Per-event entry can be a plain array (existing format) or an object with optional cwd/env + commands array
const EventConfigSchema = z.union([
  z.array(SubscriberConfigSchema),
  z.object({
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    commands: z.array(SubscriberConfigSchema),
  }),
]);

export const SubscribersYmlSchema = z.object({
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  subscribers: z.record(EventConfigSchema),
});

type SubscribersYml = z.infer<typeof SubscribersYmlSchema>;

function parseDurationMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(duration);
  if (!match) {
    throw new Error(`Invalid duration: "${duration}". Expected format: 30s, 1m, 500ms, 2h`);
  }
  const value = parseInt(match[1]!, 10);
  switch (match[2]) {
    case 'ms': return value;
    case 's': return value * 1_000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: throw new Error(`Unknown time unit in duration: ${duration}`);
  }
}

export function resolveProjectName(cwd: string): string | undefined {
  let current = cwd;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(current, '.queue'))) {
      return basename(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function resolveCwd(base: string, cwd: string): string {
  return isAbsolute(cwd) ? cwd : resolve(base, cwd);
}

function loadYml(filePath: string): SubscribersYml | null {
  if (!existsSync(filePath)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = yamlLoad(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `[queue] Failed to parse YAML at ${filePath}: ${getErrorMessage(err)}\n` +
      `Fix the YAML syntax and retry.`
    );
  }
  const result = SubscribersYmlSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `[queue] Invalid subscribers.yml at ${filePath}:\n${result.error.toString()}\n` +
      `Each key under 'subscribers' must be an array of subscriber objects with required field 'type'.`
    );
  }
  return result.data;
}

export interface SubscriberConfig {
  type: 'cli' | 'http' | 'action';
  name?: string;
  action?: string;
  with?: Record<string, unknown>;
  command?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  timeout?: string;
  retries?: number;
  backoff?: 'exponential' | 'linear';
  when?: string;
  cwd?: string;
  env?: Record<string, string>;
}

interface ResolveContext {
  filePath: string;
  /** The folder a relative cwd is resolved against and the default cwd: the folder of the file (global) or the main folder of the project that owns it. Absent for a virtual project. */
  fileDir: string | undefined;
  /** The virtual project that owns the file, to name in the problem of a subscriber that has no folder to run from. */
  virtualProject?: string;
  /** The registered project that owns the file (absent for the global file). */
  owner?: ProjectConfigLayer;
  /** Prefix of the ids of this file's subscribers: empty for the global file, '<project id>/' for a project file. */
  idPrefix: string;
  kind: 'global' | 'project';
  via?: 'registry';
  globalCwd?: string;
  globalEnv?: Record<string, string>;
  eventCwd?: string;
  eventEnv?: Record<string, string>;
  /** When present, an `action` subscriber is checked against it (unknown action, `with` block); absent, only its structure is. */
  actions?: ActionRegistry;
}

/** Fields that mean something for a cli or http subscriber only: on an action they would be silently ignored, so they are refused. */
const FIELDS_REFUSED_ON_ACTION = ['command', 'url', 'method', 'headers', 'cwd', 'env'] as const;

/**
 * Rejects a subscriber that can never dispatch, at load time, rather than letting the daemon
 * discover it per event. Silence here used to produce a WAL entry stuck in 'failed' with no log line.
 */
function assertDispatchable(event: string, index: number, raw: SubscriberConfig, filePath: string): void {
  const location = `subscriber '${event}' index ${index} in ${filePath}`;
  if (raw.type === 'cli' && !raw.command) {
    throw new Error(
      `[queue] Invalid ${location}: type 'cli' requires a 'command' field.\n` +
      `Fix: add 'command: <shell command>' or run: queue sub edit ${event} --index ${index} --type cli --command "<cmd>"`
    );
  }
  if (raw.type === 'cli' && raw.command) {
    const problem = findTemplateProblem(raw.command);
    if (problem !== undefined) {
      throw new Error(`[queue] Invalid ${location}: ${problem}`);
    }
  }
  if (raw.type === 'http' && !raw.url) {
    throw new Error(
      `[queue] Invalid ${location}: type 'http' requires a 'url' field.\n` +
      `Fix: add 'url: <endpoint>' or run: queue sub edit ${event} --index ${index} --type http --url "<url>"`
    );
  }
  if (raw.type === 'action') {
    if (typeof raw.action !== 'string' || raw.action.trim() === '') {
      throw new Error(
        `[queue] Invalid ${location}: type 'action' requires an 'action' field (the name of the plugin to run).\n` +
        `Fix: add 'action: <name>' (e.g. 'action: emit') and its settings under 'with:'.`
      );
    }
    for (const field of FIELDS_REFUSED_ON_ACTION) {
      if (raw[field] !== undefined) {
        throw new Error(
          `[queue] Invalid ${location}: type 'action' does not take '${field}': it applies to cli and http subscribers and would be ignored here.\n` +
          `Fix: remove '${field}' (the settings of an action go under 'with:'), or use type '${field === 'command' || field === 'cwd' || field === 'env' ? 'cli' : 'http'}'.`
        );
      }
    }
  } else if (raw.action !== undefined || raw.with !== undefined) {
    throw new Error(
      `[queue] Invalid ${location}: '${raw.action !== undefined ? 'action' : 'with'}' only applies to type 'action', and this subscriber has type '${raw.type}'.\n` +
      `Fix: set 'type: action', or remove 'action' and 'with'.`
    );
  }
}

/**
 * The strict check of an action subscriber against the registry of this process. An unknown action is returned (it fails that subscriber alone, for good);
 * a `with` block the plugin refuses throws, like a cli template the loader refuses: the message says what to write.
 */
function checkAction(event: string, index: number, raw: SubscriberConfig, filePath: string, actions: ActionRegistry): string | undefined {
  const name = raw.action!;
  const plugin = actions.get(name);
  if (plugin === undefined) {
    return `subscriber '${raw.name ?? `index ${index}`}' of event '${event}' (${filePath}): ${actions.unknownActionProblem(name)}`;
  }
  const problem = plugin.validate(raw.with ?? {}, { event, ...(raw.name !== undefined && { name: raw.name }) });
  if (problem !== undefined) {
    throw new Error(
      `[queue] Invalid subscriber '${event}' index ${index} in ${filePath}: action '${name}': ${problem}\n` +
      `Fix: correct the 'with:' block of the subscriber.`
    );
  }
  return undefined;
}

export const SUBSCRIBER_NAME_FORMAT = '[a-z0-9][a-z0-9._-]*';
const SUBSCRIBER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidSubscriberName(name: string): boolean {
  return SUBSCRIBER_NAME_PATTERN.test(name);
}

function assertValidName(event: string, index: number, name: string, filePath: string): void {
  if (!isValidSubscriberName(name)) {
    throw new Error(
      `[queue] Invalid name ${JSON.stringify(name)} for subscriber '${event}' index ${index} in ${filePath}: a name must match ${SUBSCRIBER_NAME_FORMAT} and be at most 64 characters.\n` +
      `Fix: use lowercase letters, digits, '.', '_' or '-', starting with a letter or a digit, e.g. 'name: notify'.`
    );
  }
}

function toResolved(event: string, index: number, raw: SubscriberConfig, ctx: ResolveContext): ResolvedSubscriber {
  assertDispatchable(event, index, raw, ctx.filePath);
  const actionProblem = raw.type === 'action' && ctx.actions !== undefined ? checkAction(event, index, raw, ctx.filePath, ctx.actions) : undefined;
  const name = raw.name;
  if (name === undefined) {
    throw new Error(
      `[queue] Subscriber '${event}' index ${index} in ${ctx.filePath} has no name: a name tells the dashboard, the history, the DLQ and the logs who listens, and survives a reorder of the list.\n` +
      `Fix: add 'name: <name>' to the entry (${SUBSCRIBER_NAME_FORMAT}), or run: queue sub edit ${event} --index ${index} --name <name>${ctx.kind === 'project' ? ' --scope project' : ''}`
    );
  }
  assertValidName(event, index, name, ctx.filePath);

  // cwd resolution: subscriber > event > global > file default (the main folder of the project that owns the file)
  const cwdValue = raw.cwd ?? ctx.eventCwd ?? ctx.globalCwd;
  const fileDir = ctx.fileDir;
  let resolvedCwd: string;
  let cwdProblem: string | undefined;
  if (fileDir !== undefined) {
    resolvedCwd = cwdValue === undefined ? fileDir : resolveCwd(fileDir, cwdValue);
  } else if (cwdValue !== undefined && isAbsolute(cwdValue)) {
    resolvedCwd = cwdValue;
  } else {
    // A virtual project has no folder: only a command with an absolute cwd of its own can run (an http call needs none)
    resolvedCwd = '';
    if (raw.type === 'cli') {
      cwdProblem =
        `subscriber '${name}' of event '${event}' belongs to the virtual project '${ctx.virtualProject ?? '?'}', which has no folder to run its command from (${ctx.filePath}). ` +
        `Fix: give the subscriber an absolute 'cwd:' (a relative one has nothing to resolve against), or register a folder for the project: project path add`;
    }
  }

  // env resolution: merge from least to most specific (global -> event -> subscriber)
  const mergedEnv: Record<string, string> | undefined = (() => {
    // An action runs in the daemon: no process, no environment
    if (raw.type === 'action') {
      return undefined;
    }
    const layers = [ctx.globalEnv, ctx.eventEnv, raw.env].filter(Boolean) as Record<string, string>[];
    if (layers.length === 0) {
      return undefined;
    }
    return Object.assign({}, ...layers) as Record<string, string>;
  })();

  return {
    subscriberId: `${ctx.idPrefix}${name}`,
    name,
    file: ctx.filePath,
    scope: ctx.kind,
    ...(ctx.owner !== undefined && { projectId: ctx.owner.projectId, projectName: ctx.owner.projectName, ...(ctx.owner.descendant === true && { fromDescendant: true as const }) }),
    ...(ctx.via !== undefined && { via: ctx.via }),
    event,
    type: raw.type,
    ...(raw.type === 'action'
      ? { action: raw.action, with: raw.with ?? {}, ...(actionProblem !== undefined && { configProblem: actionProblem }) }
      : { command: raw.command, url: raw.url, method: raw.method ?? 'POST', headers: raw.headers }),
    retries: raw.retries ?? 5,
    when: raw.when,
    timeoutMs: raw.timeout ? parseDurationMs(raw.timeout) : 30_000,
    backoff: raw.backoff ?? 'exponential',
    // An action has no working directory: the project of its event is what places it
    ...(raw.type !== 'action' && { cwd: resolvedCwd }),
    ...(cwdProblem !== undefined && { cwdProblem }),
    env: mergedEnv,
  };
}

function assertUniqueNames(event: string, resolved: ResolvedSubscriber[], filePath: string): void {
  const seen = new Set<string>();
  for (const sub of resolved) {
    if (seen.has(sub.name)) {
      throw new Error(
        `[queue] Duplicate subscriber name '${sub.name}' on event '${event}' in ${filePath}: a name identifies one subscriber of an event within its file.\n` +
        `Fix: give each subscriber of '${event}' a different 'name'.`
      );
    }
    seen.add(sub.name);
  }
}

/** One config folder of a registered project (the project itself or one of its ancestors) that may hold a subscribers.yml. */
export interface ProjectConfigLayer {
  dir: string;
  /** Id of the project that owns the folder: it identifies the subscribers of the file. */
  projectId: string;
  projectName: string;
  /** True for the layer of a descendant of the emitter (direction `to-children`): only its own file is read. */
  descendant?: true;
  /** The main folder of that project: the default cwd of the subscribers of the file. Absent for a virtual project (no path). */
  folder?: string;
}

/** The registered project of an event: where its subscribers are kept. Each layer says the folder its subscribers run from. */
export interface ProjectConfigSource {
  projectId: string;
  /** Config folders of the project and its ancestors, root first. */
  layers: ProjectConfigLayer[];
}

// The top-level keys of a subscribers.yml (the file of a project is checked against them, nothing is ignored silently)
const SUBSCRIBERS_FILE_SCHEMA: ConfigSchema = {
  sections: { subscribers: { scope: 'inherit', merge: 'append' }, cwd: { scope: 'local' }, env: { scope: 'local' } },
};

function assertKnownKeys(filePath: string): void {
  const raw: unknown = yamlLoad(readFileSync(filePath, 'utf-8'));
  if (isRecord(raw)) {
    try {
      validateLayer(SUBSCRIBERS_FILE_SCHEMA, filePath, raw, 'project');
    } catch (err) {
      throw new Error(`[queue] Invalid subscribers.yml at ${filePath}: ${getErrorMessage(err)}\nFix: a subscribers.yml has the keys subscribers, cwd and env.`);
    }
  }
}

export class ConfigLoader {
  private readonly globalConfigDir: string;
  private readonly actions: ActionRegistry | undefined;

  /**
   * `actions`: the action plugins of this process. With it, `type: action` subscribers are checked strictly (unknown action, `with` block);
   * without it (listings, the dashboard) only their structure is, and they are returned as they are written.
   */
  constructor(globalConfigDir: string, options: { actions?: ActionRegistry } = {}) {
    this.globalConfigDir = globalConfigDir;
    this.actions = options.actions;
  }

  /**
   * `project`: the registered project of the event, when there is one. Its config folders are read. A .queue/subscribers.yml found above the working
   * directory is an error when the project has no file yet (see assertNoLegacyFile), and left alone once it has one.
   */
  load(cwd: string | undefined, project?: ProjectConfigSource): Map<string, ResolvedSubscriber[]> {
    const globalFile = join(this.globalConfigDir, 'subscribers.yml');
    const registryFiles = (project?.layers ?? []).map((layer) => ({ layer, file: join(layer.dir, 'subscribers.yml') })).filter(({ file }) => existsSync(file));
    if (registryFiles.length === 0) {
      this.assertNoLegacyFile(cwd, project);
    }

    const merged = new Map<string, ResolvedSubscriber[]>();

    const addFromYml = (yml: SubscribersYml | null, filePath: string, registry?: ProjectConfigLayer): void => {
      if (!yml) {
        return;
      }
      // A file of the registry is resolved against the main folder of the project that owns it (its config folder says nothing about where to run)
      const fileDir = registry === undefined ? dirname(filePath) : registry.folder;
      const kind = filePath === globalFile ? 'global' : 'project';
      const via = registry !== undefined ? 'registry' : undefined;
      const globalCtx: Pick<ResolveContext, 'filePath' | 'fileDir' | 'virtualProject' | 'owner' | 'idPrefix' | 'kind' | 'globalCwd' | 'globalEnv'> = {
        filePath,
        fileDir,
        ...(registry !== undefined && { owner: registry }),
        ...(registry !== undefined && registry.folder === undefined && { virtualProject: registry.projectName }),
        idPrefix: registry === undefined ? '' : `${registry.projectId}/`,
        kind,
        ...(via !== undefined && { via }),
        globalCwd: yml.cwd,
        globalEnv: yml.env,
      };
      for (const [event, eventConfig] of Object.entries(yml.subscribers)) {
        // '**' is not a wildcard: it would be a literal segment that never matches and the subscribers would silently never fire
        const patternProblem = doubleStarProblem(event);
        if (patternProblem !== null) {
          throw new Error(`[queue] Invalid event pattern in ${filePath}: ${patternProblem}\nFix: rename the key under 'subscribers' (> is the only multi-segment wildcard, * matches one segment).`);
        }
        let subs: SubscriberConfig[];
        let eventCwd: string | undefined;
        let eventEnv: Record<string, string> | undefined;

        if (Array.isArray(eventConfig)) {
          subs = eventConfig as SubscriberConfig[];
        } else {
          subs = eventConfig.commands as SubscriberConfig[];
          eventCwd = eventConfig.cwd;
          eventEnv = eventConfig.env;
        }

        const ctx: ResolveContext = { ...globalCtx, eventCwd, eventEnv, ...(this.actions !== undefined && { actions: this.actions }) };
        const resolved = subs.map((s, i) => toResolved(event, i, s, ctx));
        assertUniqueNames(event, resolved, filePath);
        const existing = merged.get(event) ?? [];
        merged.set(event, [...existing, ...resolved]);
      }
    };

    addFromYml(loadYml(globalFile), globalFile);
    for (const { layer, file } of registryFiles) {
      // parsed (and its syntax error explained) before its keys are checked
      const yml = loadYml(file);
      assertKnownKeys(file);
      addFromYml(yml, file, layer);
    }

    return merged;
  }

  getSubscribers(event: string, cwd: string | undefined, project?: ProjectConfigSource): ResolvedSubscriber[] {
    const all = this.load(cwd, project);
    const result: ResolvedSubscriber[] = [];
    for (const [pattern, subs] of all) {
      if (EventMatcher.matches(pattern, event)) {
        result.push(...subs);
      }
    }
    return result;
  }

  /**
   * A .queue/subscribers.yml above `cwd` is not read any more: silently ignoring it would leave its subscribers unfired with no sign,
   * so it is an error that names the file and where its content goes.
   */
  private assertNoLegacyFile(cwd: string | undefined, project?: ProjectConfigSource): void {
    // An event without a folder (virtual project) has no old file above it
    const legacy = cwd === undefined ? null : this.findProjectFile(cwd);
    if (legacy === null) {
      return;
    }
    const destination = project?.layers.at(-1);
    const fix = destination !== undefined
      ? `move its content to ${join(destination.dir, 'subscribers.yml')}, then delete ${legacy}`
      : `register the project (project add "${cwd ?? '<folder>'}"), move its content to the subscribers.yml of the queue config folder that 'project show' lists for it, then delete ${legacy}`;
    throw new Error(
      `[queue] ${legacy} is no longer read: the subscribers of a project live in the config folder of its project registry entry.\n` +
      `Fix: ${fix}`
    );
  }

  /** The .queue/subscribers.yml found above `cwd`, if any (no longer read: it is reported, see assertNoLegacyFile). */
  findProjectFile(cwd: string): string | null {
    let current = cwd;
    for (let i = 0; i < 20; i++) {
      const candidate = join(current, '.queue', 'subscribers.yml');
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return null;
  }
}
