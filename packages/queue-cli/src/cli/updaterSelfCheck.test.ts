/**
 * The updater verifies the install after an upgrade with `queue cli self-check`, found through `npm root -g`. When npm cannot say where the global
 * install is, the update goes on without that check; it used to say nothing at that point.
 */
import { describe, it, expect } from 'vitest';
import { prepareSelfCheck } from './updaterSelfCheck.js';

const base = { pkgName: '@wadeck-app/queue-cli', execPath: '/usr/bin/node' };
const NPM_ROOT = '/global/lib';

describe('prepareSelfCheck', () => {
  it('npm root works: the self-check command is set from it and the npm root is returned', () => {
    const env: Record<string, string | undefined> = {};

    const result = prepareSelfCheck({ ...base, env, execNpm: () => `${NPM_ROOT}\n` });

    expect(result.npmRoot).toBe(NPM_ROOT);
    expect(result.warning).toBeUndefined();
    expect(env['UPDATER_SELF_CHECK_CMD']).toContain('queue.cjs');
    expect(env['UPDATER_SELF_CHECK_CMD']).toContain('cli self-check');
  });

  it('a self-check command given by the caller is kept', () => {
    const env: Record<string, string | undefined> = { UPDATER_SELF_CHECK_CMD: 'my-check' };

    prepareSelfCheck({ ...base, env, execNpm: () => NPM_ROOT });

    expect(env['UPDATER_SELF_CHECK_CMD']).toBe('my-check');
  });

  it('npm root fails: a warning says the post-install self-check is skipped, why, and what that means; no command is set', () => {
    const env: Record<string, string | undefined> = {};

    const result = prepareSelfCheck({ ...base, env, execNpm: () => { throw new Error('spawn npm ENOENT'); } });

    expect(result.npmRoot).toBeUndefined();
    expect(result.warning).toContain('post-install self-check is skipped');
    expect(result.warning).toContain('"npm root -g" failed: spawn npm ENOENT');
    expect(result.warning).toContain('queue cli self-check');
    expect(env['UPDATER_SELF_CHECK_CMD']).toBeUndefined();
  });
});
