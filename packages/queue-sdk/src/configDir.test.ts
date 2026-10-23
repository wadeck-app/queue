import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfigDir } from './configDir.js';

const HOME = join('home', 'me');

describe('resolveConfigDir', () => {
  it('prefers QUEUE_CONFIG_DIR', () => {
    expect(resolveConfigDir({ QUEUE_CONFIG_DIR: 'explicit', XDG_CONFIG_HOME: 'xdg' }, HOME)).toBe('explicit');
  });

  it('uses XDG_CONFIG_HOME/queue when QUEUE_CONFIG_DIR is absent', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: 'xdg' }, HOME)).toBe(join('xdg', 'queue'));
  });

  it('falls back to ~/.config/queue', () => {
    expect(resolveConfigDir({}, HOME)).toBe(join(HOME, '.config', 'queue'));
  });

  it('ignores empty QUEUE_CONFIG_DIR', () => {
    expect(resolveConfigDir({ QUEUE_CONFIG_DIR: '', XDG_CONFIG_HOME: 'xdg' }, HOME)).toBe(join('xdg', 'queue'));
  });

  it('ignores whitespace-only variables', () => {
    expect(resolveConfigDir({ QUEUE_CONFIG_DIR: '  ', XDG_CONFIG_HOME: ' ' }, HOME)).toBe(join(HOME, '.config', 'queue'));
  });

  it('ignores empty XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '' }, HOME)).toBe(join(HOME, '.config', 'queue'));
  });

  it('reads the real environment and home directory by default', () => {
    expect(typeof resolveConfigDir()).toBe('string');
  });
});
