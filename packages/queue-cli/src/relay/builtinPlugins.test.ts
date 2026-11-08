import { describe, it, expect } from 'vitest';
import { BUILTIN_RELAY_PLUGINS } from './builtinPlugins.js';

describe('BUILTIN_RELAY_PLUGINS', () => {
  it.each([
    ['github', '@wadeck-app/plugin-github'],
    ['gitlab', '@wadeck-app/plugin-gitlab'],
  ])('ships the %s plugin under its package name and its short alias', (source, name) => {
    const entry = BUILTIN_RELAY_PLUGINS.find((p) => p.name === name);
    expect(entry?.aliases).toEqual([source]);
    expect(entry?.plugin.source).toBe(source);
  });

  it('has no duplicated name or alias (registration would throw at relay start)', () => {
    const names = BUILTIN_RELAY_PLUGINS.flatMap((p) => [p.name, ...p.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });
});
