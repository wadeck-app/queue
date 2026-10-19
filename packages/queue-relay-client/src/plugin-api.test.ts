import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  loadPlugin,
  registerBuiltinPlugin,
  listBuiltinPlugins,
  __resetBuiltinPluginsForTests,
  type RelayEnvelope,
  type RelayPlugin,
} from './plugin-api.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('loadPlugin', () => {
  afterEach(() => {
    __resetBuiltinPluginsForTests();
  });

  it('loads a valid default-exported plugin', async () => {
    const plugin = await loadPlugin('./fixtures/valid-plugin.js');
    expect(plugin.source).toBe('fixture-source');
    const envelope: RelayEnvelope = {
      source: 'fixture-source',
      webhookConfigId: 'wc1',
      eventType: 'ping',
      receivedAt: new Date().toISOString(),
      deliveryId: 'd1',
      payload: { hello: 'world' },
      headers: {},
    };
    expect(plugin.mapEvent(envelope)).toEqual({ event: 'on.fixture-source.ping', payload: { hello: 'world' } });
  });

  it('rejects a module that does not export a valid RelayPlugin', async () => {
    await expect(loadPlugin('./fixtures/invalid-plugin.js')).rejects.toThrow(/does not export a valid RelayPlugin/);
  });

  describe('registerBuiltinPlugin', () => {
    it('registers a plugin by name so loadPlugin resolves it without import', async () => {
      const testPlugin: RelayPlugin = {
        source: 'test-builtin',
        mapEvent: (envelope) => ({ event: 'test.event', payload: envelope.payload }),
      };
      registerBuiltinPlugin('test-builtin-name', testPlugin);
      const loaded = await loadPlugin('test-builtin-name');
      expect(loaded).toBe(testPlugin);
    });

    it('resolves by alias to the registered plugin', async () => {
      const testPlugin: RelayPlugin = {
        source: 'my-source',
        mapEvent: (envelope) => ({ event: 'test', payload: null }),
      };
      registerBuiltinPlugin('my-module', testPlugin, ['my-alias', 'another-alias']);
      const loadedByName = await loadPlugin('my-module');
      const loadedByAlias1 = await loadPlugin('my-alias');
      const loadedByAlias2 = await loadPlugin('another-alias');
      expect(loadedByName).toBe(testPlugin);
      expect(loadedByAlias1).toBe(testPlugin);
      expect(loadedByAlias2).toBe(testPlugin);
    });

    it('throws a descriptive error if the plugin object is invalid', () => {
      const invalidPlugin = { source: 'test' }; // missing mapEvent
      expect(() => registerBuiltinPlugin('invalid', invalidPlugin as RelayPlugin)).toThrow(
        /does not conform to RelayPlugin/
      );
    });

    it('throws if the same name is registered with a different plugin object', () => {
      const plugin1: RelayPlugin = {
        source: 'p1',
        mapEvent: (e) => ({ event: 'e1', payload: null }),
      };
      const plugin2: RelayPlugin = {
        source: 'p2',
        mapEvent: (e) => ({ event: 'e2', payload: null }),
      };
      registerBuiltinPlugin('conflict', plugin1);
      expect(() => registerBuiltinPlugin('conflict', plugin2)).toThrow(/already registered with a different plugin/);
    });

    it('allows re-registering the same name with the identical plugin object', () => {
      const plugin: RelayPlugin = {
        source: 'same',
        mapEvent: (e) => ({ event: 'e', payload: null }),
      };
      registerBuiltinPlugin('same-name', plugin);
      // Should not throw
      expect(() => registerBuiltinPlugin('same-name', plugin)).not.toThrow();
    });

    it('throws if an alias conflicts with an existing name or alias', () => {
      const plugin1: RelayPlugin = {
        source: 'p1',
        mapEvent: (e) => ({ event: 'e1', payload: null }),
      };
      const plugin2: RelayPlugin = {
        source: 'p2',
        mapEvent: (e) => ({ event: 'e2', payload: null }),
      };
      registerBuiltinPlugin('first', plugin1, ['alias-a']);
      expect(() => registerBuiltinPlugin('second', plugin2, ['alias-a'])).toThrow(/already registered/);
    });
  });

  describe('listBuiltinPlugins', () => {
    it('returns an empty array when no plugins are registered', () => {
      expect(listBuiltinPlugins()).toEqual([]);
    });

    it('returns registered names and aliases sorted', () => {
      const plugin1: RelayPlugin = {
        source: 'p1',
        mapEvent: (e) => ({ event: 'e1', payload: null }),
      };
      const plugin2: RelayPlugin = {
        source: 'p2',
        mapEvent: (e) => ({ event: 'e2', payload: null }),
      };
      registerBuiltinPlugin('zebra', plugin1, ['yankee']);
      registerBuiltinPlugin('alpha', plugin2, ['bravo']);
      const list = listBuiltinPlugins();
      expect(list).toEqual(['alpha', 'bravo', 'yankee', 'zebra']);
    });
  });

  describe('error handling for missing modules', () => {
    it('unregistered missing module includes built-in list and module name in error', async () => {
      const plugin: RelayPlugin = {
        source: 'p1',
        mapEvent: (e) => ({ event: 'e1', payload: null }),
      };
      registerBuiltinPlugin('registered-one', plugin);
      await expect(loadPlugin('nonexistent-module-xyz')).rejects.toThrow(
        /Cannot load relay plugin module "nonexistent-module-xyz"/
      );
      try {
        await loadPlugin('nonexistent-module-xyz');
      } catch (err) {
        const message = String(err);
        expect(message).toContain('nonexistent-module-xyz');
        expect(message).toContain('registered-one');
        expect(message).toContain('Built-in plugins:');
      }
    });

    it('error message says "Built-in plugins: none" when registry is empty', async () => {
      await expect(loadPlugin('missing-xyz')).rejects.toThrow(/Built-in plugins: none/);
    });

    it('preserves the original error as cause', async () => {
      try {
        await loadPlugin('nonexistent-xyz');
      } catch (err) {
        expect((err as Error).cause).toBeDefined();
      }
    });

    it('absolute path plugin still loads via dynamic import', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-plugin-test-'));
      try {
        const pluginPath = path.join(tmpDir, 'my-plugin.mjs');
        const pluginCode = `
export default {
  source: 'tmp-plugin',
  mapEvent: (e) => ({ event: 'tmp.event', payload: e.payload })
};
`;
        await fs.writeFile(pluginPath, pluginCode, 'utf8');
        const loaded = await loadPlugin(pluginPath);
        expect(loaded.source).toBe('tmp-plugin');
        expect(loaded.mapEvent({ source: '', webhookConfigId: '', eventType: '', receivedAt: '', deliveryId: '', payload: { test: true }, headers: {} })).toEqual({
          event: 'tmp.event',
          payload: { test: true },
        });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('file that exports invalid plugin via absolute path gives existing error', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-plugin-test-'));
      try {
        const pluginPath = path.join(tmpDir, 'bad-plugin.mjs');
        const pluginCode = `export default { notAPlugin: true };`;
        await fs.writeFile(pluginPath, pluginCode, 'utf8');
        await expect(loadPlugin(pluginPath)).rejects.toThrow(/does not export a valid RelayPlugin/);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('__resetBuiltinPluginsForTests', () => {
    it('clears all registered plugins', () => {
      const plugin: RelayPlugin = {
        source: 'p1',
        mapEvent: (e) => ({ event: 'e1', payload: null }),
      };
      registerBuiltinPlugin('test', plugin);
      expect(listBuiltinPlugins()).toContain('test');
      __resetBuiltinPluginsForTests();
      expect(listBuiltinPlugins()).toEqual([]);
    });
  });
});
