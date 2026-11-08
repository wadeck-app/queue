/**
 * The dashboard module cannot import queue-cli, so it keeps its own list of relay plugins (the ones that describe a delivery in one line) in
 * app-module-queue/src/backend/relayWebhooks.ts. It must name exactly the packages of BUILTIN_RELAY_PLUGINS, or the dashboard would describe
 * deliveries of a source differently from `queue relay webhook history` (or not at all).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_RELAY_PLUGINS } from './builtinPlugins.js';

const MODULE_SOURCE = fileURLToPath(new URL('../../../app-module-queue/src/backend/relayWebhooks.ts', import.meta.url));

/** The packages the module lists: the identifiers of its `PLUGINS = [...]` array, mapped through its `import x from '@wadeck-app/plugin-...'` lines. */
export function modulePluginPackages(source: string): string[] {
  const importedFrom = new Map<string, string>();
  for (const match of source.matchAll(/^import\s+(\w+)\s+from\s+'(@wadeck-app\/plugin-[\w-]+)';?$/gm)) {
    importedFrom.set(match[1]!, match[2]!);
  }
  const list = /\bPLUGINS\s*(?::[^=]+)?=\s*\[([^\]]*)\]/.exec(source);
  if (list === null) {
    throw new Error(`No "PLUGINS = [...]" array found in ${MODULE_SOURCE}: this parity test must be updated to the new shape of the module's plugin list.`);
  }
  return list[1]!
    .split(',')
    .map((identifier) => identifier.trim())
    .filter((identifier) => identifier !== '')
    .map((identifier) => {
      const pkg = importedFrom.get(identifier);
      if (pkg === undefined) {
        throw new Error(`"${identifier}" in the module's PLUGINS is not imported from a @wadeck-app/plugin-* package: update this parity test.`);
      }
      return pkg;
    });
}

describe('the relay plugins of the dashboard module and of the CLI', () => {
  it('the module source is where the test looks for it', () => {
    expect(existsSync(MODULE_SOURCE), `${MODULE_SOURCE} not found: the module moved, update this parity test`).toBe(true);
  });

  it('name the same packages', () => {
    const inModule = modulePluginPackages(readFileSync(MODULE_SOURCE, 'utf8')).sort();
    const inCli = BUILTIN_RELAY_PLUGINS.map((entry) => entry.name).sort();

    expect(inModule, 'app-module-queue/src/backend/relayWebhooks.ts PLUGINS differs from queue-cli BUILTIN_RELAY_PLUGINS: change both together').toEqual(inCli);
  });

  it('the check itself sees a plugin that is missing from the module list', () => {
    const source = `import githubPlugin from '@wadeck-app/plugin-github';\nimport gitlabPlugin from '@wadeck-app/plugin-gitlab';\nconst PLUGINS = [githubPlugin];\n`;

    expect(modulePluginPackages(source)).toEqual(['@wadeck-app/plugin-github']);
  });
});
