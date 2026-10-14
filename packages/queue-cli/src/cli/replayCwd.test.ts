import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveReplayCwd } from './replayCwd.js';

describe('resolveReplayCwd', () => {
  it('returns recorded cwd when it exists', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'replay-project-'));
    try {
      const entry = { eventId: 'e1', cwd: projectDir } as any;
      const result = resolveReplayCwd(entry, '/current/dir');

      expect(result).toEqual({ cwd: projectDir, warning: undefined });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('returns warning when cwd is not recorded with exact message', () => {
    const entry = { eventId: 'e1' /* no cwd */ } as any;
    const currentDir = '/current/dir';
    const result = resolveReplayCwd(entry, currentDir);

    expect(result.cwd).toBe(currentDir);
    // Verify the exact <why> text for not-recorded case
    expect(result.warning).toContain('(no recorded working directory)');
    expect(result.warning).toMatch(/\[warn\] History entry e1 has no usable recorded working directory \(no recorded working directory\); replaying with the current directory \/current\/dir\./);
  });

  it('returns warning when cwd is recorded but does not exist with exact message', () => {
    const missingDir = '/this/path/definitely/does/not/exist/test-' + Math.random();
    const entry = { eventId: 'e1', cwd: missingDir } as any;
    const currentDir = '/current/dir';
    const result = resolveReplayCwd(entry, currentDir);

    expect(result.cwd).toBe(currentDir);
    // Verify the exact <why> text for recorded-but-missing case includes the path
    expect(result.warning).toContain(`(recorded working directory ${missingDir} no longer exists)`);
    expect(result.warning).toMatch(new RegExp(`\\[warn\\] History entry e1 has no usable recorded working directory \\(recorded working directory .* no longer exists\\); replaying with the current directory ${currentDir}\\.`));
  });

  it('accepts custom existsSync function', () => {
    const fakeExistsSync = vi.fn().mockReturnValue(true);
    const entry = { eventId: 'e1', cwd: '/project/dir' } as any;
    const result = resolveReplayCwd(entry, '/current/dir', fakeExistsSync);

    expect(result).toEqual({ cwd: '/project/dir', warning: undefined });
    expect(fakeExistsSync).toHaveBeenCalledWith('/project/dir');
  });
});
