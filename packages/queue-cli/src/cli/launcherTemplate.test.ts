/**
 * Unit tests for bin-launcher.js.tmpl resolveStdio function.
 * Tests the stdio mode detection and user notification logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

describe('launcherTemplate resolveStdio', () => {
  let tempDir: string;
  let resolveStdio: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  function renderTemplate(cliName: string, pkgPrefix: string): string {
    const templatePath = path.join(
      __dirname,
      '../../ci/templates/bin-launcher.js.tmpl'
    );
    let content = fs.readFileSync(templatePath, 'utf8');
    content = content.replace(/\{\{CLI_NAME\}\}/g, cliName);
    content = content.replace(/\{\{PKG_PREFIX\}\}/g, pkgPrefix);
    return content;
  }

  function requireRenderedModule(cliName: string = 'queue', pkgPrefix: string = 'queue-cli') {
    const rendered = renderTemplate(cliName, pkgPrefix);
    const modulePath = path.join(tempDir, 'launcher.js');
    fs.writeFileSync(modulePath, rendered, 'utf8');

    // Clear require cache to ensure fresh load
    delete require.cache[require.resolve(modulePath)];

    // Spy on child_process to ensure no side effects on require
    const Module = require('node:module');
    const originalRequire = Module.prototype.require;
    let childProcessCalled = false;
    Module.prototype.require = function(id: string) {
      if (id === 'child_process') {
        const cp = originalRequire.apply(this, [id]);
        const handler = {
          get: function(target: any, prop: string) {
            if (prop === 'execFileSync' || prop === 'execSync') {
              return function() {
                childProcessCalled = true;
                throw new Error('child_process should not be called on require');
              };
            }
            return target[prop];
          }
        };
        return new Proxy(cp, handler);
      }
      return originalRequire.apply(this, arguments);
    };

    try {
      const mod = require(modulePath);
      expect(childProcessCalled).toBe(false);
      return mod;
    } finally {
      Module.prototype.require = originalRequire;
    }
  }

  it('should export resolveStdio function', () => {
    const mod = requireRenderedModule();
    expect(mod.resolveStdio).toBeDefined();
    expect(typeof mod.resolveStdio).toBe('function');
  });

  describe('resolveStdio behavior', () => {
    beforeEach(() => {
      const mod = requireRenderedModule();
      resolveStdio = mod.resolveStdio;
    });

    it('TTY: should return inherit with no notice', () => {
      const result = resolveStdio(['history'], true);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(false);
      expect(result.args).toEqual(['history']);
    });

    it('non-TTY + no flags + history: should return ignore with notice', () => {
      const result = resolveStdio(['history'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toContain('stdin is not a TTY');
      expect(result.notice).toContain('command output is discarded');
      expect(result.notice).toContain('--cli-foreground');
      expect(result.auto).toBe(true);
      expect(result.args).toEqual(['history']);
    });

    it.each([['events', 'list'], ['events', 'show']])('non-TTY + %s %s: read-only catalog command, output is kept (inherit, no notice)', (...command) => {
      const result = resolveStdio([...command, 'job.completed'], false);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(false);
      expect(result.args).toEqual([...command, 'job.completed']);
    });

    it('non-TTY + events register: it writes through the daemon, so it keeps the discarded output like any other command', () => {
      const result = resolveStdio(['events', 'register', '--source', 'x'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toContain('--cli-foreground');
    });

    it('non-TTY + events list + --cli-background: the explicit flag still wins', () => {
      const result = resolveStdio(['events', 'list', '--cli-background'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toBeNull();
    });

    it('non-TTY + start: should return ignore with no notice (background command)', () => {
      const result = resolveStdio(['start'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(true);
      expect(result.args).toEqual(['start']);
    });

    it('non-TTY + --cli-foreground: should return inherit, no notice, flag stripped', () => {
      const result = resolveStdio(['--cli-foreground', 'history'], false);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(false);
      expect(result.args).toEqual(['history']);
    });

    it('non-TTY + --cli-background: should return ignore, no notice, flag stripped', () => {
      const result = resolveStdio(['--cli-background', 'history'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(false);
      expect(result.args).toEqual(['history']);
    });

    it('non-TTY + history + --cli-foreground: should return inherit, no notice, flag stripped', () => {
      const result = resolveStdio(['history', '--cli-foreground'], false);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(false);
      expect(result.args).toEqual(['history']);
    });

    it('non-TTY + history + --cli-background: should return ignore, no notice, flag stripped', () => {
      const result = resolveStdio(['history', '--cli-background'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(false);
      expect(result.args).toEqual(['history']);
    });

    it('both flags: last wins (--cli-background then --cli-foreground)', () => {
      const result = resolveStdio(['--cli-background', '--cli-foreground', 'history'], false);
      expect(result.stdio).toBe('inherit');
      expect(result.auto).toBe(false);
      expect(result.args).toEqual(['history']);
    });

    it('both flags: last wins (--cli-foreground then --cli-background)', () => {
      const result = resolveStdio(['--cli-foreground', '--cli-background', 'history'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.auto).toBe(false);
      expect(result.args).toEqual(['history']);
    });

    it.each([['--help'], ['-h'], ['--version'], ['-v'], ['-V']])('non-TTY + %s: a print-only flag keeps its output (inherit, no notice)', (flag) => {
      const result = resolveStdio([flag], false);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.auto).toBe(false);
      expect(result.args).toEqual([flag]);
    });

    it('non-TTY + --version + --cli-background: the explicit flag still wins', () => {
      const result = resolveStdio(['--version', '--cli-background'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toBeNull();
    });

    it('TTY + --help: should return inherit with no notice', () => {
      const result = resolveStdio(['--help'], true);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.args).toEqual(['--help']);
    });

    it('TTY + --version: should return inherit with no notice', () => {
      const result = resolveStdio(['--version'], true);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.args).toEqual(['--version']);
    });

    it('non-TTY + --pid: should return ignore with notice', () => {
      const result = resolveStdio(['--pid'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toContain('stdin is not a TTY');
      expect(result.args).toEqual(['--pid']);
    });

    it('--cli-foreground removed from forwarded args in all cases', () => {
      const tests = [
        ['--cli-foreground', 'history'],
        ['history', '--cli-foreground'],
        ['--cli-foreground', 'history', 'arg1'],
      ];
      for (const args of tests) {
        const result = resolveStdio(args, false);
        expect(result.args).not.toContain('--cli-foreground');
      }
    });

    it('--cli-background removed from forwarded args in all cases', () => {
      const tests = [
        ['--cli-background', 'history'],
        ['history', '--cli-background'],
        ['--cli-background', 'history', 'arg1'],
      ];
      for (const args of tests) {
        const result = resolveStdio(args, false);
        expect(result.args).not.toContain('--cli-background');
      }
    });

    it('notice includes CLI name from template', () => {
      const mod = requireRenderedModule('myqueue', 'myqueue-cli');
      const result = mod.resolveStdio(['history'], false);
      expect(result.notice).toContain('[myqueue]');
    });

    it('empty args: should handle gracefully', () => {
      const result = resolveStdio([], false);
      expect(result.stdio).toBeDefined();
      expect(result.args).toEqual([]);
    });

    // Truth table: original stdio decision logic from bin-launcher.js.tmpl
    // Documents equivalence between original and refactored resolveStdio function.
    // Original: var _stdio = process.stdin.isTTY ? 'inherit' : 'ignore'
    // + explicit flag handling: last flag wins, default 'ignore'
    it('truth table: original stdio decision semantics preserved', () => {
      const cases = [
        // [stdinIsTTY, args, expected_stdio, expected_notice, description]
        [true, ['history'], 'inherit', null, 'TTY with no flags -> inherit'],
        [false, ['history'], 'ignore', 'should exist', 'non-TTY with no flags -> ignore + notice'],
        [false, ['start'], 'ignore', null, 'non-TTY start command -> ignore, no notice'],
        [false, ['--help'], 'inherit', null, 'non-TTY help -> inherit, no notice (print-only)'],
        [true, ['--help'], 'inherit', null, 'TTY help -> inherit, no notice'],
        [false, ['--cli-foreground', 'history'], 'inherit', null, 'explicit foreground -> inherit, no notice'],
        [false, ['--cli-background', 'history'], 'ignore', null, 'explicit background -> ignore, no notice'],
        [false, ['--cli-background', '--cli-foreground', 'history'], 'inherit', null, 'last flag wins: foreground'],
        [false, ['--cli-foreground', '--cli-background', 'history'], 'ignore', null, 'last flag wins: background'],
      ] as const;

      for (const [stdinIsTTY, args, expectedStdio, expectedNotice, desc] of cases) {
        const result = resolveStdio(args, stdinIsTTY);
        expect(result.stdio).toBe(expectedStdio);
        if (expectedNotice === null) {
          expect(result.notice).toBeNull();
        } else {
          expect(result.notice).not.toBeNull();
        }
      }
    });
  });

  describe('require.main === module guard', () => {
    it('should have guard check that prevents side effects on require', () => {
      const templatePath = path.join(
        __dirname,
        '../../ci/templates/bin-launcher.js.tmpl'
      );
      const content = fs.readFileSync(templatePath, 'utf8');
      expect(content).toContain('require.main === module');
      // The guard should wrap the side-effect code
      expect(content).toContain('if');
    });

    it('should not call execFileSync or execSync on module require', () => {
      const spy = {
        execFileSync: false,
        execSync: false,
      };

      const originalRequire = require;
      const Module = require('node:module');
      const originalRequireImpl = Module.prototype.require;

      let intercepted = false;
      Module.prototype.require = function(id: string) {
        if (id === 'child_process' && !intercepted) {
          intercepted = true;
          const realModule = originalRequireImpl.apply(this, [id]);
          return {
            execFileSync: (...args: any[]) => {
              spy.execFileSync = true;
              throw new Error('execFileSync should not be called on require');
            },
            execSync: (...args: any[]) => {
              spy.execSync = true;
              throw new Error('execSync should not be called on require');
            },
          };
        }
        return originalRequireImpl.apply(this, arguments);
      };

      try {
        const mod = requireRenderedModule();
        expect(spy.execFileSync).toBe(false);
        expect(spy.execSync).toBe(false);
      } finally {
        Module.prototype.require = originalRequireImpl;
      }
    });
  });
});

describe('launcherTemplate buildInstallCommand', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '../../ci/templates/bin-launcher.js.tmpl'), 'utf8')
    .replace(/{{CLI_NAME}}/g, 'queue')
    .replace(/{{PKG_PREFIX}}/g, 'queue-cli');
  const load = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-install-'));
    const file = path.join(dir, 'launcher.js');
    fs.writeFileSync(file, tpl, 'utf8');
    try {
      return createRequire(file)(file) as { buildInstallCommand: (p: string, v: unknown) => string };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };

  it('pins the platform package to the exact bundle version', () => {
    expect(load().buildInstallCommand('@wadeck-app/queue-cli-win32-x64', '2026.10.31-244-cb188647'))
      .toBe('npm install -g @wadeck-app/queue-cli-win32-x64@2026.10.31-244-cb188647');
  });

  it.each([undefined, '', 42, '1.0 && calc', 'latest; x'])('refuses an invalid version %j instead of installing latest', (v) => {
    expect(() => load().buildInstallCommand('@wadeck-app/queue-cli-win32-x64', v)).toThrow(/valid version/);
  });

  it('builds the install command in one place, version-pinned, and runs only that command', () => {
    // The one string literal that starts an install is followed by the package name AND the version
    expect(tpl.match(/'npm install -g '/g)).toHaveLength(1);
    expect(tpl).toContain("'npm install -g ' + pkgName + '@' + version");
    // The only thing handed to execSync is the command built by buildInstallCommand (an unversioned literal at the call site is refused)
    const execCalls = tpl.split(/\r?\n/).filter((l) => l.includes('execSync(')).map((l) => l.slice(l.indexOf('execSync(')));
    expect(execCalls.filter((c) => !c.startsWith('execSync(installCmd,'))).toEqual([]);
    expect(execCalls.filter((c) => c.startsWith('execSync(installCmd,'))).toHaveLength(1);
  });
});

describe('launcherTemplate spawn failures and launcher bypass', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '../../ci/templates/bin-launcher.js.tmpl'), 'utf8')
    .replace(/{{CLI_NAME}}/g, 'queue')
    .replace(/{{PKG_PREFIX}}/g, 'queue-cli');
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const platformKey = `${process.platform}-${arch}`;
  const supportedPlatforms = ['win32-x64', 'darwin-arm64', 'linux-x64'];
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Renders the shim as <root>/bin/queue.js with a fake platform package whose "launcher" is a plain, non-executable file
  // and a fake bundle <root>/queue.cjs that prints its arguments
  function installFakePackage(bundleSource = 'console.log("BUNDLE:" + process.argv.slice(2).join(" "));'): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-run-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fake', version: '2026.1.1-1-abcdef12' }));
    const shim = path.join(root, 'bin', 'queue.js');
    fs.writeFileSync(shim, tpl, 'utf8');
    fs.writeFileSync(path.join(root, 'queue.cjs'), bundleSource, 'utf8');
    const pkgDir = path.join(root, 'node_modules', '@wadeck-app', `queue-cli-${platformKey}`);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, `queue${process.platform === 'win32' ? '.exe' : ''}`), 'not an executable', { mode: 0o644 });
    return shim;
  }

  function loadShim(): { describeSpawnFailure: (cli: string, bin: string, err: unknown) => string | null } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-spawn-'));
    dirs.push(dir);
    const file = path.join(dir, 'launcher.js');
    fs.writeFileSync(file, tpl, 'utf8');
    return createRequire(file)(file);
  }

  describe('describeSpawnFailure', () => {
    it('EACCES: names the file, the code and the exec-bit fix', () => {
      const err = Object.assign(new Error('spawnSync /x/queue EACCES'), { code: 'EACCES', status: null });
      const msg = loadShim().describeSpawnFailure('queue', '/x/queue', err)!;
      expect(msg).toContain('queue: cannot start /x/queue');
      expect(msg).toContain('EACCES');
      expect(msg).toContain('spawnSync /x/queue EACCES');
      expect(msg).toContain('chmod +x /x/queue');
    });

    it('ENOENT: names the file and the reinstall command, no exec-bit hint', () => {
      const err = Object.assign(new Error('spawnSync /x/queue ENOENT'), { code: 'ENOENT' });
      const msg = loadShim().describeSpawnFailure('queue', '/x/queue', err)!;
      expect(msg).toContain('ENOENT');
      expect(msg).toContain('npm install -g @wadeck-app/queue-cli');
      expect(msg).not.toContain('chmod');
    });

    it('a child that ran and exited with a status is not a spawn failure (its own output is already out)', () => {
      expect(loadShim().describeSpawnFailure('queue', '/x/queue', Object.assign(new Error('Command failed'), { status: 3 }))).toBeNull();
    });

    it('a child killed by a signal is not a spawn failure', () => {
      expect(loadShim().describeSpawnFailure('queue', '/x/queue', Object.assign(new Error('killed'), { status: null, signal: 'SIGTERM' }))).toBeNull();
    });
  });

  describe('running the rendered shim', () => {
    const run = (shim: string, args: string[]) => spawnSync(process.execPath, [shim, '--cli-foreground', ...args], { encoding: 'utf8', env: { ...process.env } });

    it.runIf(supportedPlatforms.includes(platformKey))('a command other than start runs the bundle with node, whatever the launcher is (every platform)', () => {
      const r = run(installFakePackage(), ['history', '--limit', '3']);
      expect(r.stderr).toBe('');
      expect(r.stdout.trim()).toBe('BUNDLE:history --limit 3');
      expect(r.status).toBe(0);
    });

    it.runIf(supportedPlatforms.includes(platformKey))('start goes through the launcher: a launcher that cannot be executed fails loudly with the file', () => {
      const r = run(installFakePackage(), ['start']);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain('BUNDLE:');
      expect(r.stderr).toContain('queue: cannot start');
    });

    // A bundle that reports who runs it: its pid, its argv and the bundle path the shim announces
    const reportingBundle = 'module.exports = { runQueueCommand: async () => { console.log("INPROC:" + process.pid + "|" + process.argv.slice(2).join(" ") + "|" + (process.env.LAUNCHER_BUNDLE_OVERRIDE || "").endsWith("queue.cjs")); process.exit(7); } };\n' +
      'if (process.argv[1] && process.argv[1].endsWith("queue.cjs")) { console.log("CHILD:" + process.pid + "|" + process.argv.slice(2).join(" ")); }';

    const runAsync = (shim: string, args: string[]) => new Promise<{ pid: number; stdout: string; stderr: string; status: number | null }>((resolve) => {
      const child = spawn(process.execPath, [shim, ...args], { env: { ...process.env } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ pid: child.pid!, stdout, stderr, status }));
    });

    it.runIf(supportedPlatforms.includes(platformKey))('wait with its output kept runs inside the shim process (no second node), with the flags stripped, and its exit code', async () => {
      const shim = installFakePackage(reportingBundle);
      const r = await runAsync(shim, ['--cli-foreground', 'wait', 'ci', 'abc', '--name', 'x.y']);
      expect(r.stderr).toBe('');
      expect(r.stdout.trim()).toBe(`INPROC:${r.pid}|wait ci abc --name x.y|true`);
      expect(r.status).toBe(7);
    });

    it.runIf(supportedPlatforms.includes(platformKey))('wait with its output discarded (non-TTY, no flag) still runs in a child node: nothing is muted inside the shim', async () => {
      const shim = installFakePackage(reportingBundle);
      const r = await runAsync(shim, ['wait', 'ci', 'abc']);
      // stdio 'ignore' for the child: no INPROC/CHILD output reaches us, only the notice
      expect(r.stdout).not.toContain('INPROC:');
      expect(r.stderr).toContain('stdin is not a TTY');
    });

    it.runIf(supportedPlatforms.includes(platformKey))('a bundle without runQueueCommand makes an in-process wait fail loudly with the fix', async () => {
      const shim = installFakePackage('module.exports = {};');
      const r = await runAsync(shim, ['--cli-foreground', 'wait', 'x']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('queue: cannot run');
      expect(r.stderr).toContain('npm install -g @wadeck-app/queue-cli');
    });

    it.runIf(supportedPlatforms.includes(platformKey))('other commands keep running in a child node', async () => {
      const shim = installFakePackage(reportingBundle);
      const r = await runAsync(shim, ['--cli-foreground', 'history']);
      expect(r.stdout.trim()).toMatch(/^CHILD:\d+\|history$/);
      expect(r.stdout).not.toContain(`CHILD:${r.pid}|`);
    });

    it.runIf(!supportedPlatforms.includes(platformKey))(`${platformKey} has no platform package: the shim says so and exits 1 (the run tests above need one of ${supportedPlatforms.join(', ')})`, () => {
      const r = run(installFakePackage(), ['history']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('unsupported platform');
      expect(r.stderr).toContain(`supported: ${supportedPlatforms.join(', ')}`);
    });

    it('the platform table lists exactly the supported platforms (no darwin-x64, no linux-arm64) and the unsupported message is built from it', () => {
      const table = [...tpl.matchAll(/^\s+'([a-z0-9]+-[a-z0-9]+)':\s+'@wadeck-app\/queue-cli-/gm)].map((m) => m[1]);
      expect(table).toEqual(supportedPlatforms);
      expect(tpl).toContain("(supported: ${Object.keys(PLATFORM_PKG).join(', ')})");
    });
  });
});
