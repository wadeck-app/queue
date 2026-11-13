/**
 * Regression: the Go launcher resolves its config dir like the Node side (queue-core getQueueConfigDir).
 *
 * Bug: the SDK's default launcher template ignored QUEUE_CONFIG_DIR, so `QUEUE_CONFIG_DIR=<tmp> queue start`
 * ran the daemon in <tmp> while the launcher wrote its log and config.launcher-pid into the real
 * ~/.config/queue (and looked config.port up there for dispatched commands). The fix is ci/launcher-main.go.tmpl.
 *
 * This test builds the real launcher (needs `go` and `bash` in PATH, throws with instructions when missing, no
 * silent skip), copies it next to a stub queue.cjs and runs it with throwaway HOME / XDG / QUEUE_CONFIG_DIR.
 * The developer's real ~/.config/queue is never read or written: every launcher run gets a throwaway HOME / USERPROFILE / XDG_CONFIG_HOME
 * (createIsolatedCliEnv), so it cannot reach the real directory, and the assertions look at the throwaway directories only.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goBuildEnv } from '../testing/goBuildEnv.js';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function launcherBinaryName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  switch (process.platform) {
    case 'win32': return 'queue_windows_release.exe';
    case 'darwin': return `queue_darwin_${arch}_release`;
    case 'linux': return `queue_linux_${arch}_release`;
    default: throw new Error(`No launcher is built for platform ${process.platform}`);
  }
}

/** Launcher-owned files of a config dir: config.launcher-pid and logs/<day>-launcher.log, as "path:size:mtimeMs". */
function launcherFiles(configDir: string): string[] {
  const out: string[] = [];
  const pid = join(configDir, 'config.launcher-pid');
  if (existsSync(pid)) {
    const s = statSync(pid);
    out.push(`${pid}:${s.size}:${s.mtimeMs}`);
  }
  const logs = join(configDir, 'logs');
  if (existsSync(logs)) {
    for (const f of readdirSync(logs).filter(n => n.endsWith('-launcher.log')).sort()) {
      const s = statSync(join(logs, f));
      out.push(`${join(logs, f)}:${s.size}:${s.mtimeMs}`);
    }
  }
  return out;
}

describe('Go launcher config dir (QUEUE_CONFIG_DIR)', () => {
  let iso: IsolatedCliEnv;
  let launcherExe: string;
  let stubArgsFile: string;
  let stubEnvFile: string;

  beforeAll(() => {
    iso = createIsolatedCliEnv();
    const outDir = join(iso.root, 'launcher-build');
    try {
      // Same entry point as CI: ci/scripts/build-launcher.mjs, but host platform only (build.sh builds 5 targets) into a throwaway dir, via bash + the same build.sh.
      execFileSync('node', [join(PACKAGE_DIR, 'ci', 'scripts', 'build-launcher.mjs')], {
        stdio: 'pipe', encoding: 'utf8', timeout: 240_000, windowsHide: true,
        env: { ...goBuildEnv(process.env, process.env['QUEUE_TEST_REAL_TMPDIR']), QUEUE_LAUNCHER_OUT_DIR: outDir, QUEUE_LAUNCHER_HOST_ONLY: '1' },
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      throw new Error(
        `Cannot build the Go launcher for the regression test (needs go and bash in PATH, see ci/scripts/build-launcher.mjs).\n` +
        `${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`,
      );
    }
    const built = join(outDir, launcherBinaryName());
    if (!existsSync(built)) {
      throw new Error(`The launcher build did not produce ${built} (files: ${existsSync(outDir) ? readdirSync(outDir).join(', ') : 'none'}).`);
    }
    // The launcher starts "queue.cjs" next to itself: a stub that records its arguments and exits.
    const appDir = join(iso.root, 'app');
    mkdirSync(appDir, { recursive: true });
    launcherExe = join(appDir, launcherBinaryName());
    copyFileSync(built, launcherExe);
    stubArgsFile = join(iso.root, 'stub-args.json');
    stubEnvFile = join(iso.root, 'stub-env.json');
    // Records the arguments and the port variables node would receive
    writeFileSync(join(appDir, 'queue.cjs'),
      `const fs = require('node:fs');\n` +
      `fs.writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n` +
      `fs.writeFileSync(process.env.STUB_ENV_FILE, JSON.stringify({ daemon: process.env.QUEUE_DAEMON_PORT, relay: process.env.QUEUE_RELAY_PORT }));\n`);
  }, 300_000);

  afterAll(() => {
    iso?.cleanup();
  });

  function runLauncher(args: string[], extraEnv: NodeJS.ProcessEnv) {
    const env: NodeJS.ProcessEnv = { ...iso.env, STUB_ARGS_FILE: stubArgsFile, STUB_ENV_FILE: stubEnvFile, ...extraEnv };
    if (extraEnv['QUEUE_CONFIG_DIR'] === undefined) {
      delete env['QUEUE_CONFIG_DIR'];
    }
    const res = spawnSync(launcherExe, args, { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (res.error) {
      throw res.error;
    }
    return res;
  }

  it('QUEUE_CONFIG_DIR: the launcher log and config.launcher-pid land in that dir, not in XDG / HOME', () => {
    const custom = join(iso.root, 'custom-queue-dir');
    // iso.configDir is where XDG_CONFIG_HOME/queue points (isolated): it must stay untouched.
    const xdgQueueDir = iso.configDir;

    const res = runLauncher(['start'], { QUEUE_CONFIG_DIR: custom });

    expect(res.status, `launcher exited ${res.status}: ${res.stderr}`).toBe(0);
    const files = launcherFiles(custom);
    expect(files.some(f => f.includes('config.launcher-pid')), `no config.launcher-pid in ${custom}`).toBe(true);
    expect(files.some(f => f.includes('-launcher.log')), `no launcher log in ${custom}/logs`).toBe(true);
    expect(launcherFiles(xdgQueueDir)).toEqual([]);
    // The flag the launcher feeds itself must not reach node.
    expect(JSON.parse(readFileSync(stubArgsFile, 'utf8'))).toEqual(['start']);
  });

  it('--config beats QUEUE_CONFIG_DIR', () => {
    const fromEnv = join(iso.root, 'env-dir');
    const fromFlag = join(iso.root, 'flag-dir');

    const res = runLauncher(['--config', fromFlag, 'start'], { QUEUE_CONFIG_DIR: fromEnv });

    expect(res.status, `launcher exited ${res.status}: ${res.stderr}`).toBe(0);
    expect(launcherFiles(fromFlag).length).toBeGreaterThan(0);
    expect(launcherFiles(fromEnv)).toEqual([]);
  });

  it('without QUEUE_CONFIG_DIR: $XDG_CONFIG_HOME/queue (unchanged behaviour)', () => {
    const res = runLauncher(['start'], {});

    expect(res.status, `launcher exited ${res.status}: ${res.stderr}`).toBe(0);
    expect(launcherFiles(iso.configDir).length).toBeGreaterThan(0);
  });

  it('QUEUE_DAEMON_PORT / QUEUE_RELAY_PORT reach the node process the launcher starts (the launcher itself hard-codes no port)', () => {
    const res = runLauncher(['start'], { QUEUE_DAEMON_PORT: '51234', QUEUE_RELAY_PORT: '51300' });

    expect(res.status, `launcher exited ${res.status}: ${res.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(stubEnvFile, 'utf8'))).toEqual({ daemon: '51234', relay: '51300' });
  });
});
