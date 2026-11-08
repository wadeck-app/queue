import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WaiterRegistry, type WaiterContact, type WaiterRegistration } from '@wadeck-app/queue-core';

// Fixtures of the Waiters routes: real waiter files and real waits-history days, written by the queue-core registry with an injected clock (not a test file, never part of the module).

export interface FixtureWait {
  name: string;
  /** Epoch ms of the registration; also the heartbeat time of the file. */
  at: number;
  events?: string[];
  whens?: string[];
  label?: string;
  cwd?: string;
  pid?: number;
  id?: string;
  contact?: WaiterContact;
}

export interface FixtureRegistry {
  registry: WaiterRegistry;
  registration: WaiterRegistration;
}

/** A wait that registered at `at`: its file is `waiters/waiter-<name>.json`, its `start` record is in the history day of `at`. */
export function registerFixtureWait(configDir: string, wait: FixtureWait): FixtureRegistry {
  const registry = new WaiterRegistry(configDir, {
    pid: wait.pid ?? 4242,
    now: () => wait.at,
    isAlive: () => true,
    newId: () => wait.id ?? `id-${wait.name}`,
    onRetention: () => undefined,
    onDiagnostic: () => undefined,
  });
  const registration = registry.register({
    name: wait.name,
    events: wait.events ?? ['onFoo'],
    whens: wait.whens ?? [],
    label: wait.label ?? '',
    since: new Date(wait.at - 60_000).toISOString(),
    cwd: wait.cwd ?? '/work/project',
    ...(wait.contact !== undefined && { contact: wait.contact }),
  });
  return { registry, registration };
}

/** A registry whose clock reads `at` (to end a wait later than it started). */
export function registryAt(configDir: string, at: number): WaiterRegistry {
  return new WaiterRegistry(configDir, { pid: 4242, now: () => at, isAlive: () => true, onRetention: () => undefined, onDiagnostic: () => undefined });
}

/** Every file under `dir` with its content and modification time: a GET route must leave this unchanged. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        out[path] = `${readFileSync(path, 'utf8')}@${statSync(path).mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}
