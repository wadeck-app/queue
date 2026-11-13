/**
 * The bin shim runs `queue wait` inside its own process (one node instead of two) with the REAL bundle: the wait must still register,
 * end with its own exit code and leave its record, exactly as when the bundle is run directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { testBundleFile } from '../testing/testBundle.js';

const SUPPORTED = ['win32-x64', 'darwin-arm64', 'linux-x64'];
const platformKey = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

describe.runIf(SUPPORTED.includes(platformKey))('bin shim: queue wait in the shim process, real bundle', () => {
  let iso: IsolatedCliEnv;
  let root: string;
  let shim: string;

  beforeAll(() => {
    iso = createIsolatedCliEnv();
    root = mkdtempSync(join(tmpdir(), 'queue-shim-wait-'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fake', version: '0.0.0-test-shim' }));
    const template = join(__dirname, '../../ci/templates/bin-launcher.js.tmpl');
    shim = join(root, 'bin', 'queue.js');
    writeFileSync(shim, readFileSync(template, 'utf8').replace(/{{CLI_NAME}}/g, 'queue').replace(/{{PKG_PREFIX}}/g, 'queue-cli'));
    copyFileSync(testBundleFile('queue.cjs'), join(root, 'queue.cjs'));
    const pkgDir = join(root, 'node_modules', '@wadeck-app', `queue-cli-${platformKey}`);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, process.platform === 'win32' ? 'queue.exe' : 'queue'), 'unused: only start would run it');
  });

  afterAll(() => {
    iso?.cleanup();
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const run = (args: string[]) => spawnSync(process.execPath, [shim, ...args], { encoding: 'utf8', timeout: 60_000, env: iso.env });

  it('a wait that times out ends with the same exit code and records its end, run through the shim', () => {
    const viaShim = run(['--cli-foreground', 'wait', 'zz.never', '--timeout', '2s', '--name', 'probe.shim']);
    const direct = spawnSync(process.execPath, [join(root, 'queue.cjs'), 'wait', 'zz.never', '--timeout', '2s', '--name', 'probe.direct'], { encoding: 'utf8', timeout: 60_000, env: iso.env });
    // Same result as the bundle run directly
    expect(viaShim.status).toBe(direct.status);
    expect(viaShim.status).not.toBe(0);
    expect(viaShim.stdout.replace(/probe\.shim/g, 'N')).toBe(direct.stdout.replace(/probe\.direct/g, 'N'));
    // The wait registered itself and left its end record
    const history = run(['--cli-foreground', 'waiters', '--history', '--json']);
    expect(history.status).toBe(0);
    expect(history.stdout).toContain('probe.shim');
    expect(history.stdout).toContain('"timeout"');
  });

  it('-V answers through the shim even without a TTY (print-only flag keeps its output)', () => {
    const r = run(['-V']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain('0.0.0-test-integration');
  });
});
