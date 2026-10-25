import { describe, it, expect, vi } from 'vitest';
import type { HistoryEntry } from '@wadeck-app/queue-core';
import { resolveReplayCwd } from './replayCwd.js';

// Where a replay runs decides which subscribers fire (the directory selects the registered project), so a replay never
// falls back on its own to the directory the user happens to be in: it uses the recorded one, or the one the user names.

function entryWith(fields: { cwd?: string }): HistoryEntry {
  return { ts: '2026-01-01T00:00:00.000Z', eventId: 'e1', event: 'test', subscribers: [], orphan: false, ...fields };
}

const everythingExists = (): boolean => true;
const nothingExists = (): boolean => false;

describe('resolveReplayCwd', () => {
  it('uses the recorded directory when it exists', () => {
    expect(resolveReplayCwd(entryWith({ cwd: '/project' }), undefined, everythingExists)).toEqual({ ok: true, cwd: '/project' });
  });

  it('uses the directory the user names, even when the recorded one exists', () => {
    const existsSync = vi.fn(() => true);
    expect(resolveReplayCwd(entryWith({ cwd: '/project' }), '/elsewhere', existsSync)).toEqual({ ok: true, cwd: '/elsewhere' });
    expect(existsSync).toHaveBeenCalledWith('/elsewhere');
  });

  it('uses the directory the user names when nothing was recorded', () => {
    expect(resolveReplayCwd(entryWith({}), '/elsewhere', everythingExists)).toEqual({ ok: true, cwd: '/elsewhere' });
  });

  it('uses the directory the user names when the recorded one is gone', () => {
    const existsSync = (path: string): boolean => path === '/elsewhere';
    expect(resolveReplayCwd(entryWith({ cwd: '/gone' }), '/elsewhere', existsSync)).toEqual({ ok: true, cwd: '/elsewhere' });
  });

  it('refuses, and says how to choose, when nothing was recorded', () => {
    const result = resolveReplayCwd(entryWith({}), undefined, everythingExists);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('History entry e1 has no recorded working directory');
      expect(result.message).toContain('queue replay e1 --cwd <directory>');
      expect(result.message).toMatch(/subscribers/i);
    }
  });

  it('refuses, naming the missing directory and how to choose, when the recorded one no longer exists', () => {
    const result = resolveReplayCwd(entryWith({ cwd: '/gone' }), undefined, nothingExists);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('/gone no longer exists');
      expect(result.message).toContain('queue replay e1 --cwd <directory>');
    }
  });

  it('refuses a --cwd that does not exist, naming it, instead of replaying somewhere unknown', () => {
    const result = resolveReplayCwd(entryWith({ cwd: '/project' }), '/typo', nothingExists);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('--cwd /typo does not exist');
    }
  });
});
