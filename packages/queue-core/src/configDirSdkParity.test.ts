import { describe, it, expect, afterEach } from 'vitest';
import { getQueueConfigDir } from './configDir.js';
// The SDK restates the config dir convention because it has no dependency; this keeps the two equal.
import { resolveConfigDir } from '@wadeck-app/queue-sdk';

const saved = { queue: process.env['QUEUE_CONFIG_DIR'], xdg: process.env['XDG_CONFIG_HOME'] };

afterEach(() => {
  for (const [name, value] of [['QUEUE_CONFIG_DIR', saved.queue], ['XDG_CONFIG_HOME', saved.xdg]] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('config dir: queue-core and @wadeck-app/queue-sdk agree', () => {
  it.each([
    ['nothing set', undefined, undefined],
    ['QUEUE_CONFIG_DIR set', '/somewhere/queue-config', undefined],
    ['only XDG_CONFIG_HOME set', undefined, '/xdg'],
    ['both set: QUEUE_CONFIG_DIR wins', '/somewhere/queue-config', '/xdg'],
    ['empty variables are ignored', '', ''],
  ])('%s', (_label, queue, xdg) => {
    for (const [name, value] of [['QUEUE_CONFIG_DIR', queue], ['XDG_CONFIG_HOME', xdg]] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    expect(resolveConfigDir(process.env)).toBe(getQueueConfigDir());
  });
});
