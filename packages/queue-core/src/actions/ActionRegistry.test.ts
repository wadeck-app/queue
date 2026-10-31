import { describe, it, expect } from 'vitest';
import { ActionRegistry } from './ActionRegistry.js';
import { createActionRegistry } from './createActionRegistry.js';
import type { ActionPlugin } from './ActionPlugin.js';

function plugin(name: string, aliases?: string[]): ActionPlugin {
  return { name, ...(aliases !== undefined && { aliases }), validate: () => undefined, run: () => Promise.resolve({ success: true }) };
}

describe('ActionRegistry', () => {
  it('finds a plugin by its name or by an alias', () => {
    const registry = new ActionRegistry();
    const p = plugin('agent-wake', ['wake']);
    registry.register(p);
    expect(registry.get('agent-wake')).toBe(p);
    expect(registry.get('wake')).toBe(p);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.names()).toEqual(['agent-wake']);
  });

  it('refuses a duplicate name, naming the plugin that owns it', () => {
    const registry = new ActionRegistry();
    registry.register(plugin('a'));
    expect(() => registry.register(plugin('a'))).toThrow(/already taken by the plugin 'a'/);
  });

  it('refuses an alias that is the name of another plugin, and registers nothing of the refused plugin', () => {
    const registry = new ActionRegistry();
    registry.register(plugin('a'));
    expect(() => registry.register(plugin('b', ['a']))).toThrow(/'a'/);
    expect(registry.get('b')).toBeUndefined();
  });

  it('refuses an alias repeated in one plugin and a malformed name', () => {
    const registry = new ActionRegistry();
    expect(() => registry.register(plugin('x', ['y', 'y']))).toThrow(/repeat/);
    expect(() => registry.register(plugin('Bad Name'))).toThrow(/must match/);
    expect(registry.names()).toEqual([]);
  });

  it('resolve throws an error that lists the available names', () => {
    const registry = createActionRegistry([plugin('agent-wake')]);
    expect(() => registry.resolve('nope')).toThrow(/unknown action "nope"\. Available actions: emit, agent-wake/);
    expect(registry.resolve('emit').name).toBe('emit');
  });
});

describe('createActionRegistry', () => {
  it('has emit pre-registered, and refuses a plugin that wants the name emit', () => {
    expect(createActionRegistry().names()).toEqual(['emit']);
    expect(() => createActionRegistry([plugin('emit')])).toThrow(/already taken/);
  });

  it('two registries are independent instances', () => {
    const a = createActionRegistry([plugin('only-a')]);
    const b = createActionRegistry();
    expect(a.get('only-a')).toBeDefined();
    expect(b.get('only-a')).toBeUndefined();
  });
});
