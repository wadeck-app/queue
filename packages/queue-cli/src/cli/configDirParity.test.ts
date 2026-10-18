import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { getQueueConfigDir } from '@wadeck-app/queue-core';

/**
 * queue-core restates shared-cli's `ConfigDir.get('queue')` convention (it must not depend on a CLI library),
 * while the updater entry still uses shared-cli directly. If shared-cli changes the convention, this fails
 * instead of letting the updater and the daemon look at two different directories.
 */
const saved = { queue: process.env['QUEUE_CONFIG_DIR'], xdg: process.env['XDG_CONFIG_HOME'] };

beforeEach(() => {
  delete process.env['QUEUE_CONFIG_DIR'];
});

afterEach(() => {
  for (const [key, value] of [['QUEUE_CONFIG_DIR', saved.queue], ['XDG_CONFIG_HOME', saved.xdg]] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('queue-core getQueueConfigDir stays equal to shared-cli ConfigDir.get("queue")', () => {
  it('without XDG_CONFIG_HOME', () => {
    delete process.env['XDG_CONFIG_HOME'];
    expect(getQueueConfigDir()).toBe(ConfigDir.get('queue'));
  });

  it('with XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = '/some/xdg';
    expect(getQueueConfigDir()).toBe(ConfigDir.get('queue'));
  });
});
