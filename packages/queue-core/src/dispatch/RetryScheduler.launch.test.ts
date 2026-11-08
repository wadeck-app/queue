import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOrchProgram, resolveOrchLaunch } from './RetryScheduler.js';

const IS_WINDOWS = process.platform === 'win32';
const ARGS = ['add', '--once', 'queue-retry-x', '--delay', '1m', '--command', 'queue retry --event x'];

// Real text of an npm-generated shim (npm 10), the form of C:\App\nodejs\orch.cmd
const SHIM = (rel: string): string => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`, '',
].join('\r\n');

describe('resolveOrchLaunch - how orch is started (every platform)', () => {
  it('starts what was found as is on a POSIX platform', () => {
    expect(resolveOrchLaunch('/usr/local/bin/orch', ARGS, {}, 'linux')).toEqual({ file: '/usr/local/bin/orch', args: ARGS });
  });

  it.each(['C:\\tools\\orch.exe', 'C:\\tools\\orch.com'])('starts %s directly on Windows', (found) => {
    expect(resolveOrchLaunch(found, ARGS, {}, 'win32')).toEqual({ file: found, args: ARGS });
  });

  it('refuses a .cmd that is not a standard npm shim, with the way out (never through cmd.exe)', () => {
    expect(() => resolveOrchLaunch('C:\\does-not-exist\\orch.cmd', ARGS, {}, 'win32')).toThrow(/not a standard npm shim[\s\S]*orch\.exe/);
  });

  it('refuses a program without a launchable extension on Windows (an sh script such as the extensionless npm shim)', () => {
    expect(() => resolveOrchLaunch('C:\\App\\nodejs\\orch', ARGS, {}, 'win32')).toThrow(/cannot be started[\s\S]*orch\.cmd|orch\.exe/);
  });
});

describe.skipIf(!IS_WINDOWS)('resolveOrchLaunch - a real npm shim on disk (Windows)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-orch-shim-'));
    const script = join(dir, 'node_modules', '@wadeck', 'orchestrator', 'bin');
    mkdirSync(script, { recursive: true });
    writeFileSync(join(script, 'orch.js'), '');
    writeFileSync(join(dir, 'node.exe'), '');
    writeFileSync(join(dir, 'orch.cmd'), SHIM('node_modules\\@wadeck\\orchestrator\\bin\\orch.js'));
    writeFileSync(join(dir, 'orch'), '#!/bin/sh\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('starts node on the shim script with the orch arguments, without cmd.exe', () => {
    const launch = resolveOrchLaunch(join(dir, 'orch.cmd'), ARGS, {}, 'win32');
    expect(launch.file).toBe(join(dir, 'node.exe'));
    expect(launch.args).toEqual([join(dir, 'node_modules', '@wadeck', 'orchestrator', 'bin', 'orch.js'), ...ARGS]);
  });

  it('finds orch.cmd, not the extensionless sh script that sits first in the folder (where.exe lists it first)', () => {
    const found = findOrchProgram({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    expect(found?.toLowerCase()).toBe(join(dir, 'orch.cmd').toLowerCase());
  });

  it('finds nothing when orch is not on PATH', () => {
    expect(findOrchProgram({ PATH: join(dir, 'empty'), PATHEXT: '.CMD' })).toBeNull();
  });
});
