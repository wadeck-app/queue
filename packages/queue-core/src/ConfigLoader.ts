import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname, resolve, isAbsolute } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { validateLayer, type ConfigSchema } from '@wadeck-app/project-sdk';
import { z } from 'zod';
import { EventMatcher } from './dispatch/EventMatcher.js';
import type { ResolvedSubscriber } from './types.js';
import { getErrorMessage } from './errors.js';
import { isRecord } from './isRecord.js';

const SubscriberConfigSchema = z.object({
  type: z.enum(['cli', 'http']),
  name: z.string().optional(),
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

/** Returns the project root for a subscribers.yml at <root>/.queue/subscribers.yml, else the file's directory. */
function defaultCwdForDir(fileDir: string): string {
  return basename(fileDir) === '.queue' ? dirname(fileDir) : fileDir;
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
  type: 'cli' | 'http';
  name?: string;
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
  fileDir: string;
  /** Prefix of the ids of this file's subscribers: empty for the global file, '<project folder>/' for a project file. */
  idPrefix: string;
  kind: 'global' | 'project';
  via?: 'registry' | 'walk-up';
  globalCwd?: string;
  globalEnv?: Record<string, string>;
  eventCwd?: string;
  eventEnv?: Record<string, string>;
}

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
  if (raw.type === 'http' && !raw.url) {
    throw new Error(
      `[queue] Invalid ${location}: type 'http' requires a 'url' field.\n` +
      `Fix: add 'url: <endpoint>' or run: queue sub edit ${event} --index ${index} --type http --url "<url>"`
    );
  }
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
  if (raw.name !== undefined) {
    assertValidName(event, index, raw.name, ctx.filePath);
  }
  const legacyId = `${event}[${index}]`;

  // cwd resolution: subscriber > event > global > file default (project root)
  const fileDefaultCwd = defaultCwdForDir(ctx.fileDir);
  const baseCwd = ctx.globalCwd
    ? resolveCwd(ctx.fileDir, ctx.globalCwd)
    : fileDefaultCwd;
  const eventCwd = ctx.eventCwd ? resolveCwd(ctx.fileDir, ctx.eventCwd) : baseCwd;
  const resolvedCwd = raw.cwd ? resolveCwd(ctx.fileDir, raw.cwd) : eventCwd;

  // env resolution: merge from least to most specific (global -> event -> subscriber)
  const mergedEnv: Record<string, string> | undefined = (() => {
    const layers = [ctx.globalEnv, ctx.eventEnv, raw.env].filter(Boolean) as Record<string, string>[];
    if (layers.length === 0) {
      return undefined;
    }
    return Object.assign({}, ...layers) as Record<string, string>;
  })();

  return {
    subscriberId: `${ctx.idPrefix}${raw.name ?? legacyId}`,
    legacyId,
    name: raw.name,
    file: ctx.filePath,
    scope: ctx.kind,
    ...(ctx.via !== undefined && { via: ctx.via }),
    event,
    type: raw.type,
    command: raw.command,
    url: raw.url,
    method: raw.method ?? 'POST',
    headers: raw.headers,
    retries: raw.retries ?? 5,
    when: raw.when,
    timeoutMs: raw.timeout ? parseDurationMs(raw.timeout) : 30_000,
    backoff: raw.backoff ?? 'exponential',
    cwd: resolvedCwd,
    env: mergedEnv,
  };
}

/**
 * What to tell the owner of a subscriber that has no name (names will become mandatory), or undefined when it has one.
 * The fix is one command: `queue sub edit` with only --name keeps the rest of the entry.
 */
export function unnamedSubscriberAdvice(sub: ResolvedSubscriber): string | undefined {
  if (sub.name !== undefined) {
    return undefined;
  }
  const position = /^(.*)\[(\d+)\]$/.exec(sub.legacyId);
  const event = position?.[1] ?? sub.event;
  const index = position?.[2] ?? '0';
  return (
    `subscriber ${sub.subscriberId} (event '${event}', ${sub.file}) has no name: a name tells the dashboard, the history, the DLQ and the logs who listens, ` +
    `survives a reorder of the list, and will become mandatory. Fix: queue sub edit ${event} --index ${index} --name <name>${sub.scope === 'project' ? ' --scope project' : ''}`
  );
}

function assertUniqueNames(event: string, resolved: ResolvedSubscriber[], filePath: string): void {
  const seen = new Set<string>();
  for (const sub of resolved) {
    if (sub.name === undefined) {
      continue;
    }
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
}

/** The registered project of an event: where its subscribers are kept and the folder they run from. */
export interface ProjectConfigSource {
  projectId: string;
  /** The registered path of the project the working directory is in (its main path for an explicit project): the default `cwd` of its subscribers, and what a relative `cwd` is resolved against. */
  baseDir: string;
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

  constructor(globalConfigDir: string) {
    this.globalConfigDir = globalConfigDir;
  }

  /**
   * `project`: the registered project of the event, when there is one. Its config folders are read first; a .queue/subscribers.yml found above
   * the working directory is the fallback of a project that has no file yet (transition), and is not read once it has one.
   */
  load(cwd: string, project?: ProjectConfigSource): Map<string, ResolvedSubscriber[]> {
    const globalFile = join(this.globalConfigDir, 'subscribers.yml');
    const registryFiles = (project?.layers ?? []).map((layer) => ({ layer, file: join(layer.dir, 'subscribers.yml') })).filter(({ file }) => existsSync(file));
    const projectFile = registryFiles.length > 0 ? null : this.findProjectFile(cwd);

    const merged = new Map<string, ResolvedSubscriber[]>();

    const addFromYml = (yml: SubscribersYml | null, filePath: string, registry?: { projectId: string; baseDir: string }): void => {
      if (!yml) {
        return;
      }
      // A file of the registry is resolved against the project folder (its config folder says nothing about where to run)
      const fileDir = registry === undefined ? dirname(filePath) : registry.baseDir;
      const kind = filePath === globalFile ? 'global' : 'project';
      const via = registry !== undefined ? 'registry' : kind === 'project' ? 'walk-up' : undefined;
      // A project subscriber is identified by the id of its project once the project is registered, wherever its file is
      const projectPrefix = registry !== undefined ? `${registry.projectId}/` : project !== undefined ? `${project.projectId}/` : `${basename(defaultCwdForDir(fileDir))}/`;
      const globalCtx: Pick<ResolveContext, 'filePath' | 'fileDir' | 'idPrefix' | 'kind' | 'globalCwd' | 'globalEnv'> = {
        filePath,
        fileDir,
        idPrefix: kind === 'global' ? '' : projectPrefix,
        kind,
        ...(via !== undefined && { via }),
        globalCwd: yml.cwd,
        globalEnv: yml.env,
      };
      for (const [event, eventConfig] of Object.entries(yml.subscribers)) {
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

        const ctx: ResolveContext = { ...globalCtx, eventCwd, eventEnv };
        const resolved = subs.map((s, i) => toResolved(event, i, s, ctx));
        assertUniqueNames(event, resolved, filePath);
        const existing = merged.get(event) ?? [];
        merged.set(event, [...existing, ...resolved]);
      }
    };

    addFromYml(loadYml(globalFile), globalFile);
    for (const { layer, file } of registryFiles) {
      assertKnownKeys(file);
      addFromYml(loadYml(file), file, { projectId: layer.projectId, baseDir: project!.baseDir });
    }
    if (projectFile) {
      addFromYml(loadYml(projectFile), projectFile);
    }

    return merged;
  }

  getSubscribers(event: string, cwd: string, project?: ProjectConfigSource): ResolvedSubscriber[] {
    const all = this.load(cwd, project);
    const result: ResolvedSubscriber[] = [];
    for (const [pattern, subs] of all) {
      if (EventMatcher.matches(pattern, event)) {
        result.push(...subs);
      }
    }
    return result;
  }

  /** The .queue/subscribers.yml found above `cwd`, if any (the lookup that is being replaced by the config folder of the registered project). */
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
