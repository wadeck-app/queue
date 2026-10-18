import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getQueueConfigDir } from './configDir.js';

const saved = { queue: process.env['QUEUE_CONFIG_DIR'], xdg: process.env['XDG_CONFIG_HOME'] };

beforeEach(() => {
  delete process.env['QUEUE_CONFIG_DIR'];
  delete process.env['XDG_CONFIG_HOME'];
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

describe('getQueueConfigDir', () => {
  it('uses QUEUE_CONFIG_DIR when it is set', () => {
    process.env['QUEUE_CONFIG_DIR'] = '/somewhere/queue-config';
    expect(getQueueConfigDir()).toBe('/somewhere/queue-config');
  });

  it('QUEUE_CONFIG_DIR wins over XDG_CONFIG_HOME', () => {
    process.env['QUEUE_CONFIG_DIR'] = '/explicit';
    process.env['XDG_CONFIG_HOME'] = '/xdg';
    expect(getQueueConfigDir()).toBe('/explicit');
  });

  it('falls back to $XDG_CONFIG_HOME/queue', () => {
    process.env['XDG_CONFIG_HOME'] = '/xdg';
    expect(getQueueConfigDir()).toBe(join('/xdg', 'queue'));
  });

  it('falls back to ~/.config/queue (also on Windows, same convention as the other CLIs)', () => {
    expect(getQueueConfigDir()).toBe(join(homedir(), '.config', 'queue'));
  });
});
