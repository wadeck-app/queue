import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname, resolve, isAbsolute } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';
import { EventMatcher } from './dispatch/EventMatcher.js';
import type { ResolvedSubscriber } from './types.js';
import { getErrorMessage } from './errors.js';

const SubscriberConfigSchema = z.object({
  type: z.enum(['cli', 'http']),
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
  if (!match) throw new Error(`Invalid duration: "${duration}". Expected format: 30s, 1m, 500ms, 2h`);
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
    if (parent === current) break;
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
  if (!existsSync(filePath)) return null;
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
  fileDir: string;
  globalCwd?: string;
  globalEnv?: Record<string, string>;
  eventCwd?: string;
  eventEnv?: Record<string, string>;
}

function toResolved(event: string, index: number, raw: SubscriberConfig, ctx: ResolveContext): ResolvedSubscriber {
  // cwd resolution: subscriber > event > global > file default (project root)
  const fileDefaultCwd = defaultCwdForDir(ctx.fileDir);
  const baseCwd = ctx.globalCwd
    ? resolveCwd(ctx.fileDir, ctx.globalCwd)
    : fileDefaultCwd;
  const eventCwd = ctx.eventCwd ? resolveCwd(ctx.fileDir, ctx.eventCwd) : baseCwd;
  const resolvedCwd = raw.cwd ? resolveCwd(ctx.fileDir, raw.cwd) : eventCwd;

  // env resolution: merge from least to most specific (global → event → subscriber)
  const mergedEnv: Record<string, string> | undefined = (() => {
    const layers = [ctx.globalEnv, ctx.eventEnv, raw.env].filter(Boolean) as Record<string, string>[];
    if (layers.length === 0) return undefined;
    return Object.assign({}, ...layers) as Record<string, string>;
  })();

  return {
    subscriberId: `${event}[${index}]`,
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

export class ConfigLoader {
  private readonly globalConfigDir: string;

  constructor(globalConfigDir: string) {
    this.globalConfigDir = globalConfigDir;
  }

  load(cwd: string): Map<string, ResolvedSubscriber[]> {
    const globalFile = join(this.globalConfigDir, 'subscribers.yml');
    const projectFile = this.findProjectFile(cwd);

    const merged = new Map<string, ResolvedSubscriber[]>();

    const addFromYml = (yml: SubscribersYml | null, filePath: string): void => {
      if (!yml) return;
      const fileDir = dirname(filePath);
      const globalCtx: Pick<ResolveContext, 'fileDir' | 'globalCwd' | 'globalEnv'> = {
        fileDir,
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
        const existing = merged.get(event) ?? [];
        merged.set(event, [...existing, ...resolved]);
      }
    };

    addFromYml(loadYml(globalFile), globalFile);
    if (projectFile) addFromYml(loadYml(projectFile), projectFile);

    return merged;
  }

  getSubscribers(event: string, cwd: string): ResolvedSubscriber[] {
    const all = this.load(cwd);
    const result: ResolvedSubscriber[] = [];
    for (const [pattern, subs] of all) {
      if (EventMatcher.matches(pattern, event)) {
        result.push(...subs);
      }
    }
    return result;
  }

  private findProjectFile(cwd: string): string | null {
    let current = cwd;
    for (let i = 0; i < 20; i++) {
      const candidate = join(current, '.queue', 'subscribers.yml');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }
}
