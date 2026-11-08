import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliTransport } from './CliTransport.js';
import { CommandTemplateError } from './commandTemplate.js';
import { parseNpmShim, resolveNpmShim, scriptInside } from './NpmShim.js';
import type { EventEnvelope } from '../types.js';

const IS_WINDOWS = process.platform === 'win32';

// Real text of C:\App\nodejs\flow.cmd (npm 10)
const MODERN = (rel: string): string => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`, '',
].join('\r\n');
const REL = 'node_modules\\@wadeck-app\\flow-cli\\bin\\flow.js';

const NPM6 = (rel: string): string => [
  '@ECHO off', 'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '', `"%_prog%"  "%dp0%\\${rel}" %*`, 'ENDLOCAL', 'EXIT /b %errorlevel%', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', '',
].join('\n');

const OLD = (rel: string): string => [
  '@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*`, ') ELSE (', '  @SETLOCAL', '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  `  node  "%~dp0\\${rel}" %*`, ')', '',
].join('\r\n');

describe('parseNpmShim - recognised forms (pure, every platform)', () => {
  it('the modern form (real flow.cmd text), CRLF', () => {
    expect(parseNpmShim(MODERN(REL))).toBe(REL);
  });
  it('the same with LF line endings', () => {
    expect(parseNpmShim(MODERN(REL).replace(/\r\n/g, '\n'))).toBe(REL);
  });
  it('the npm 6 form with a launch line then ENDLOCAL', () => {
    expect(parseNpmShim(NPM6(REL))).toBe(REL);
  });
  it('the older form with a launch line per branch', () => {
    expect(parseNpmShim(OLD(REL))).toBe(REL);
  });
  it('the minimal `node "%~dp0\\x.js" %*` form', () => {
    expect(parseNpmShim('@echo off\r\nnode "%~dp0\\bin\\x.js" %*\r\n')).toBe('bin\\x.js');
  });
  it.each(['.js', '.cjs', '.mjs'])('accepts a %s script', (ext) => {
    expect(parseNpmShim(MODERN(`bin\\x${ext}`))).toBe(`bin\\x${ext}`);
  });
});

describe('parseNpmShim - rejections (pure, every platform)', () => {
  const rejected: ReadonlyArray<[string, string]> = [
    ['an empty file', ''],
    ['a different command line', MODERN(REL) + 'del /q *.*\r\n'],
    ['an extra command before the launch', 'echo hi\r\n' + MODERN(REL)],
    ['a command chained after %*', MODERN(REL).replace(/%\*/, '%* & calc')],
    ['anything after %*', MODERN(REL).replace(/%\*/, '%* extra')],
    ['an extra argument before %*', MODERN(REL).replace(/ %\*/, ' --flag %*')],
    ['an extra argument between script and %*', MODERN(REL).replace(/ %\*/, ' "other" %*')],
    ['two different scripts', OLD('a.js').replace(/node {2}"%~dp0\\a\.js"/, 'node "%~dp0\\b.js"')],
    ['an environment tweak', MODERN(REL).replace('SETLOCAL', 'SETLOCAL\r\nSET NODE_OPTIONS=--require evil.js')],
    ['a different PATHEXT tweak', MODERN(REL).replace(';.JS;', ';.EXE;')],
    ['a parent segment', MODERN('..\\evil.js')],
    ['a nested parent segment', MODERN('a\\..\\..\\evil.js')],
    ['a drive letter', MODERN('C:\\evil.js')],
    ['an absolute path', MODERN('\\evil.js')],
    ['a double separator', MODERN('a\\\\evil.js')],
    ['a percent in the path', MODERN('a\\%TEMP%\\evil.js')],
    ['a metacharacter in the path', MODERN('a&calc\\evil.js')],
    ['a script that is not js', MODERN('bin\\run.cmd')],
    ['no extension', MODERN('bin\\run')],
    ['a NUL character', MODERN(REL) + '\0'],
    ['a file over 8 KB', MODERN(REL) + 'REM ' + 'x'.repeat(9000)],
    ['a user batch calling node', '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\tools\\printer.js" %*\r\n'],
    ['no launch line', '@ECHO off\r\nSETLOCAL\r\n'],
  ];
  it.each(rejected)('returns undefined for %s', (_label, text) => {
    expect(parseNpmShim(text)).toBeUndefined();
  });
});

let workDir: string;
let shimDir: string;
let argvScript: string;
let markerDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'queue-npmshim-'));
  shimDir = join(workDir, 'shims');
  markerDir = join(workDir, 'cwd');
  mkdirSync(join(shimDir, 'node_modules', 'pkg', 'bin'), { recursive: true });
  mkdirSync(markerDir);
  argvScript = join(shimDir, 'node_modules', 'pkg', 'bin', 'argv.js');
  writeFileSync(argvScript, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  writeFileSync(join(shimDir, 'argv.cmd'), MODERN('node_modules\\pkg\\bin\\argv.js'));
  writeFileSync(join(shimDir, 'missing.cmd'), MODERN('node_modules\\pkg\\bin\\missing.js'));
  writeFileSync(join(shimDir, 'escape.cmd'), MODERN('..\\argv.js'));
  // Not an npm shim: calls node itself
  writeFileSync(join(shimDir, 'tweaked.bat'), `@echo off\r\n"${process.execPath}" "${argvScript}" %*\r\n`);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('resolveNpmShim - files (pure fs, every platform)', () => {
  it('resolves the script under the shim directory and node from the environment PATH', () => {
    const nodeDir = join(workDir, 'nodebin');
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, 'node.exe'), '');
    // Lowercase extensions: the file system of the CI (Linux) is case sensitive, Windows is not; the code under test only runs on Windows
    const launch = resolveNpmShim(join(shimDir, 'argv.cmd'), { PATH: nodeDir, PATHEXT: '.com;.exe' });
    // PATHEXT case decides the case of the extension on Windows
    expect(launch?.nodeExe.toLowerCase()).toBe(join(nodeDir, 'node.exe').toLowerCase());
    expect(launch?.script).toBe(argvScript);
  });

  it('prefers node.exe next to the shim', () => {
    const dir = join(workDir, 'withnode');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'x.js'), '');
    writeFileSync(join(dir, 'node.exe'), '');
    writeFileSync(join(dir, 'x.cmd'), MODERN('bin\\x.js'));
    expect(resolveNpmShim(join(dir, 'x.cmd'), { PATH: '' })?.nodeExe).toBe(join(dir, 'node.exe'));
  });

  it('is undefined when the script does not exist', () => {
    expect(resolveNpmShim(join(shimDir, 'missing.cmd'), { PATH: '' })).toBeUndefined();
  });

  // The parser already refuses a '..' segment, so this is the first line of defence; scriptInside below covers the second one directly
  it('is undefined when the shim names a script outside its directory (refused before any file is touched)', () => {
    expect(existsSync(argvScript)).toBe(true);
    expect(resolveNpmShim(join(shimDir, 'escape.cmd'), { PATH: '' })).toBeUndefined();
  });

  it('is undefined when the shim file is over the size limit, even if it starts like a shim', () => {
    const big = join(shimDir, 'big.cmd');
    writeFileSync(big, MODERN('node_modules\\pkg\\bin\\argv.js') + 'REM ' + 'x'.repeat(9000));
    expect(resolveNpmShim(big, { PATH: '' })).toBeUndefined();
  });

  it('is undefined when the script path is a directory, not a file', () => {
    mkdirSync(join(shimDir, 'dirscript.js'), { recursive: true });
    writeFileSync(join(shimDir, 'dirscript.cmd'), MODERN('dirscript.js'));
    expect(resolveNpmShim(join(shimDir, 'dirscript.cmd'), { PATH: '' })).toBeUndefined();
  });

  it('refuses a node on PATH that is not an .exe, and says which one it found', () => {
    const nodeDir = join(workDir, 'nodecmd');
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, 'node.cmd'), '');
    expect(() => resolveNpmShim(join(shimDir, 'argv.cmd'), { PATH: nodeDir, PATHEXT: '.CMD;.EXE' })).toThrow(/is not an .exe/);
  });

  it('resolves a script inside a folder whose name merely starts with two dots', () => {
    const dir = join(workDir, 'dots');
    mkdirSync(join(dir, '..lib'), { recursive: true });
    writeFileSync(join(dir, '..lib', 'x.js'), '');
    writeFileSync(join(dir, 'node.exe'), '');
    writeFileSync(join(dir, 'dots.cmd'), MODERN('..lib\\x.js'));
    expect(resolveNpmShim(join(dir, 'dots.cmd'), { PATH: '' })?.script).toBe(join(dir, '..lib', 'x.js'));
  });

  it('is undefined for a non-shim batch file and for a missing file', () => {
    expect(resolveNpmShim(join(shimDir, 'tweaked.bat'), { PATH: '' })).toBeUndefined();
    expect(resolveNpmShim(join(shimDir, 'nope.cmd'), { PATH: '' })).toBeUndefined();
  });

  it('does not pick a node.exe from the working directory, and explains how to fix a missing node', () => {
    writeFileSync(join(markerDir, 'node.exe'), '');
    const previous = process.cwd();
    process.chdir(markerDir);
    try {
      const env = { PATH: join(workDir, 'empty'), PATHEXT: '.EXE' };
      expect(() => resolveNpmShim(join(shimDir, 'argv.cmd'), env)).toThrow(CommandTemplateError);
      expect(() => resolveNpmShim(join(shimDir, 'argv.cmd'), env)).toThrow(/Fix: put node\.exe on PATH/);
    } finally {
      process.chdir(previous);
    }
  });
});

describe('scriptInside - the second guard, whatever the parser lets through (pure, every platform)', () => {
  const dir = resolve(tmpdir(), 'queue-npmshim-guard');
  it('keeps a script under the directory', () => {
    expect(scriptInside(dir, 'bin\\x.js')).toBe(resolve(dir, 'bin', 'x.js'));
  });
  it('keeps a folder whose name starts with two dots', () => {
    expect(scriptInside(dir, '..lib\\x.js')).toBe(resolve(dir, '..lib', 'x.js'));
  });
  it.each([['a parent segment', '..\\x.js'], ['a nested parent segment', 'a\\..\\..\\x.js'], ['the directory itself', '.']])('refuses %s', (_label, rel) => {
    expect(scriptInside(dir, rel)).toBeUndefined();
  });
  it.skipIf(!IS_WINDOWS)('refuses another drive (relative() answers an absolute path)', () => {
    expect(scriptInside('C:\\shims', 'D:\\x.js')).toBeUndefined();
  });
});

const HOSTILE: ReadonlyArray<[string, string]> = [
  ['double quote', 'a"b'],
  ['ampersand command', 'x & echo INJECTED> marker.txt'],
  ['percent variable', '%PATH%'],
  ['caret', '^'],
  ['bang', '!'],
  ['backtick', '`calc`'],
  ['quoted command chain', 'say "hi" && calc'],
  ['trailing backslash', 'C:\\dir\\'],
  ['spaces', 'hello  big   world'],
  ['unicode', 'ünï 日本 😀'],
  ['empty', ''],
  ['20000 characters', 'x"&%^!'.repeat(3300)],
];

function envelope(payload: unknown): EventEnvelope {
  return { id: 'evt-1', timestamp: '2026-01-01T00:00:00.000Z', event: 'onTest', payload, meta: { cwd: markerDir } };
}

describe.skipIf(!IS_WINDOWS)('CliTransport - npm shim on Windows: run directly, values stay data (skipped off Windows: .cmd and cmd.exe exist only there)', () => {
  const transport = new CliTransport();
  const pathKey = (): string => Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';

  async function runShim(command: string, payload: unknown) {
    return transport.dispatch(command, envelope(payload), 30_000, markerDir, { [pathKey()]: `${shimDir};${process.env[pathKey()] ?? ''}` }, 'notify');
  }

  it.each(HOSTILE)('arrives unchanged as one argument and runs nothing: %s', async (_label, value) => {
    const result = await runShim('argv first {{ payload.v }} last', { v: value });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.stdout ?? '')).toEqual(['first', value, 'last']);
    expect(existsSync(join(markerDir, 'marker.txt'))).toBe(false);
    expect(existsSync(join(shimDir, 'marker.txt'))).toBe(false);
  });

  it('a value inside a larger argument (--input "description={{ ... }}") stays one argument', async () => {
    const result = await runShim('argv run --input "description={{ payload.v }}"', { v: '{"a": "b & c"}' });
    expect(JSON.parse(result.stdout ?? '')).toEqual(['run', '--input', 'description={"a": "b & c"}']);
  });

  it('a non-npm .bat keeps the refusal, saying that npm shims are run directly and naming the file', async () => {
    const result = await runShim('tweaked.bat {{ payload.v }}', { v: 'a"b' });
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain('tweaked.bat');
    expect(result.error).toContain('not a recognised npm shim');
    expect(result.error).toContain('Fix:');
  });
});
