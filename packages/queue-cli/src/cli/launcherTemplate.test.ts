/**
 * Unit tests for bin-launcher.js.tmpl resolveStdio function.
 * Tests the stdio mode detection and user notification logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';

describe('launcherTemplate resolveStdio', () => {
  let tempDir: string;
  let resolveStdio: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
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

    it('non-TTY + --help: should return ignore with notice', () => {
      const result = resolveStdio(['--help'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toContain('stdin is not a TTY');
      expect(result.notice).toContain('command output is discarded');
      expect(result.args).toEqual(['--help']);
    });

    it('TTY + --help: should return inherit with no notice', () => {
      const result = resolveStdio(['--help'], true);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.args).toEqual(['--help']);
    });

    it('non-TTY + -h: should return ignore with notice', () => {
      const result = resolveStdio(['-h'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toContain('stdin is not a TTY');
      expect(result.args).toEqual(['-h']);
    });

    it('non-TTY + --version: should return ignore with notice', () => {
      const result = resolveStdio(['--version'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toContain('stdin is not a TTY');
      expect(result.args).toEqual(['--version']);
    });

    it('TTY + --version: should return inherit with no notice', () => {
      const result = resolveStdio(['--version'], true);
      expect(result.stdio).toBe('inherit');
      expect(result.notice).toBeNull();
      expect(result.args).toEqual(['--version']);
    });

    it('non-TTY + -v: should return ignore with notice', () => {
      const result = resolveStdio(['-v'], false);
      expect(result.stdio).toBe('ignore');
      expect(result.notice).toContain('stdin is not a TTY');
      expect(result.args).toEqual(['-v']);
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
        [false, ['--help'], 'ignore', 'should exist', 'non-TTY help -> ignore + notice'],
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
