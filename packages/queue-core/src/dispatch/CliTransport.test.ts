import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliTransport, type TransportTimers } from './CliTransport.js';
import { waitFor } from '../waitFor.testUtil.js';
import type { DispatchResult } from './DispatchResult.js';
import type { EventEnvelope } from '../types.js';

const IS_WINDOWS = process.platform === 'win32';
const NODE = process.execPath;

let workDir: string;
let printer: string;

/** Prints what the child received: its argv (after the script) and its stdin. */
const PRINTER_SOURCE = `
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin }));
});
`;

function envelope(payload: unknown): EventEnvelope {
  return { id: 'evt-1', timestamp: '2026-01-01T00:00:00.000Z', event: 'onTest', payload, meta: { cwd: workDir } };
}

function received(result: DispatchResult): { argv: string[]; stdin: string } {
  if (!result.success) {
    throw new Error(`dispatch failed: ${result.error ?? '?'}\nstdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}`);
  }
  return JSON.parse(result.stdout ?? '') as { argv: string[]; stdin: string };
}

const transport = new CliTransport();

/** Timers that remember what was asked of them. The ones `hold` selects only fire when the test calls `fire`; the others are real timers. */
class ManualTimers implements TransportTimers {
  readonly scheduled: Array<{ callback: () => void; delayMs: number; held: boolean; cancelled: boolean; fired: boolean; real?: NodeJS.Timeout }> = [];

  constructor(private readonly hold: (delayMs: number) => boolean) {}

  set(callback: () => void, delayMs: number): unknown {
    const timer: (typeof this.scheduled)[number] = { callback, delayMs, held: this.hold(delayMs), cancelled: false, fired: false };
    if (!timer.held) {
      timer.real = setTimeout(callback, delayMs);
    }
    this.scheduled.push(timer);
    return timer;
  }

  clear(handle: unknown): void {
    const timer = handle as (typeof this.scheduled)[number];
    timer.cancelled = true;
    clearTimeout(timer.real);
  }

  /** Fires the timer scheduled at `index` (in the order they were asked for) unless it was cancelled or already fired. */
  fire(index: number): void {
    const timer = this.scheduled[index];
    if (timer === undefined || timer.cancelled || timer.fired) {
      return;
    }
    timer.fired = true;
    timer.callback();
  }

  delays(): number[] {
    return this.scheduled.map((timer) => timer.delayMs);
  }
}

/** True while the process exists (EPERM means it exists but is not ours). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function run(command: string, payload: unknown, cwd: string = workDir): Promise<DispatchResult> {
  return transport.dispatch(command, envelope(payload), 30_000, cwd, undefined, 'notify');
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'queue-clitransport-'));
  printer = join(workDir, 'printer.js');
  writeFileSync(printer, PRINTER_SOURCE);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const HOSTILE_VALUES: ReadonlyArray<[string, string]> = [
  ['semicolon command', 'a; touch injected-semicolon'],
  ['command substitution', '$(calc)'],
  ['backticks', '`calc`'],
  ['ampersand command', '& echo INJECTED'],
  ['percent variable', '%PATH%'],
  ['double ampersand', 'x && echo INJECTED'],
  ['pipe', 'x | more'],
  ['redirection', 'x > injected-redirect.txt'],
  ['quotes', `it's "quoted" and 'single'`],
  ['trailing backslash', 'C:\\dir\\'],
  ['spaces', 'two words   and more'],
  ['negative number', '-5'],
  ['a lone dash', '-'],
  ['empty', ''],
  ['unicode', 'ünï–cödé 😀 日本語'],
  ['very long', 'x'.repeat(20_000)],
];

describe('CliTransport - command with {{ }}: values reach the program as single, verbatim arguments', () => {
  it.each(HOSTILE_VALUES)('%s', async (_label, value) => {
    const result = await run(`"${NODE}" "${printer}" first {{ payload.v }} last`, { v: value });
    expect(received(result).argv).toEqual(['first', value, 'last']);
    expect(existsSync(join(workDir, 'injected-semicolon'))).toBe(false);
    expect(existsSync(join(workDir, 'injected-redirect.txt'))).toBe(false);
  });

  describe('option injection: a value that is the whole argument and starts like an option', () => {
    it.each([
      ['--help', '--help'],
      ['-rf', '-rf'],
      ['-x', '-x'],
      ['--', '--'],
      ['--output=/etc/passwd', '--output=/etc/passwd'],
      ['@ (curl / many tools read the file that follows)', '@/etc/passwd'],
    ])('refuses %s as a permanent failure that names the field, the program-reads-it-as-an-option reason and the fix', async (_label, value) => {
      const result = await run(`"${NODE}" "${printer}" first {{ payload.name }}`, { name: value });
      expect(result.success).toBe(false);
      expect(result.permanent).toBe(true);
      expect(result.error).toContain("subscriber 'notify'");
      expect(result.error).toContain("'name'");
      expect(result.error).toMatch(/read as an option/);
      expect(result.error).toContain('--name={{ name }}');
      expect(result.error).toContain('Fix:');
      // Nothing ran: the printer would have printed its argv
      expect(result.stdout).toBeUndefined();
    });

    it('also refuses it inside double quotes (still the whole argument)', async () => {
      const result = await run(`"${NODE}" "${printer}" "{{ v }}"`, { v: '-rf' });
      expect(result.permanent).toBe(true);
      expect(result.error).toMatch(/read as an option/);
    });

    it('refuses a whole argument made of several placeholders when the result starts like an option', async () => {
      const result = await run(`"${NODE}" "${printer}" {{ a }}{{ b }}`, { a: '-', b: 'rf' });
      expect(result.permanent).toBe(true);
    });

    it.each([['-5'], ['-.5'], ['-'], ['- spaced'], ['a-b'], [' -x']])('lets %j through: not an option', async (value) => {
      expect(received(await run(`"${NODE}" "${printer}" {{ v }}`, { v: value })).argv).toEqual([value]);
    });

    it('lets the same value through when it is written after `--name=` (the value cannot start the argument)', async () => {
      expect(received(await run(`"${NODE}" "${printer}" --title={{ v }} "--t2={{ v }}"`, { v: '--help' })).argv).toEqual(['--title=--help', '--t2=--help']);
    });
  });

  it('keeps a value with spaces as ONE argument and a template with quotes as written', async () => {
    const result = await run(`"${NODE}" "${printer}" --title "Fix: {{ payload.title }}" --id={{ id }} 'a  b'`, { title: 'two words', id: 7 });
    expect(received(result).argv).toEqual(['--title', 'Fix: two words', '--id=7', 'a  b']);
  });

  it('passes an object value as one JSON argument and a missing field as an empty argument', async () => {
    const result = await run(`"${NODE}" "${printer}" {{ o }} {{ missing }}`, { o: { a: [1, 'x y'] } });
    expect(received(result).argv).toEqual(['{"a":[1,"x y"]}', '']);
  });

  it('still sends the envelope on stdin', async () => {
    const result = await run(`"${NODE}" "${printer}" {{ v }}`, { v: 'x' });
    const { stdin } = received(result);
    expect((JSON.parse(stdin) as EventEnvelope).id).toBe('evt-1');
  });

  it('refuses a value holding a NUL character as a permanent failure that names the subscriber and the field', async () => {
    const result = await run(`"${NODE}" "${printer}" {{ v }}`, { v: 'a\0b' });
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("subscriber 'notify'");
    expect(result.error).toContain("'v'");
    expect(result.error).toContain('Fix:');
  });

  it('reports a program that does not exist with an actionable message', async () => {
    const result = await run('queue-test-no-such-program {{ v }}', { v: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.error).toContain('Fix:');
  });

  it.skipIf(!IS_WINDOWS)('Windows only: a shell built-in (echo, dir, copy, ...) is a program that is not found: permanent failure with the program name and a Fix', async () => {
    const result = await run('queue-test-no-such-builtin hello {{ v }}', { v: 'x' });
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("subscriber 'notify'");
    expect(result.error).toContain("program 'queue-test-no-such-builtin' was not found");
    expect(result.error).toContain('Fix: install it, put it on PATH, or give its full path in the command');
    // A daemon keeps the PATH it was started with: the message says how many entries it searched and how to refresh it
    expect(result.error).toMatch(/\d+ PATH entries|PATH is empty or not set/);
    expect(result.error).toContain('restart the daemon from that shell ("queue stop"');
    expect(result.error).toContain('queue logs');
  });

  it.skipIf(!IS_WINDOWS)('Windows only: the not-found error does not list the PATH directories (it flows into the DLQ and the events subscribers see): only their count', async () => {
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
    const secretA = join(workDir, 'secret-user-name-a');
    const secretB = join(workDir, 'secret-user-name-b');
    const result = await transport.dispatch('queue-test-no-such-builtin {{ v }}', envelope({ v: 'x' }), 30_000, workDir, { [pathKey]: `${secretA};${secretB}` }, 'notify');
    expect(result.error).toContain("program 'queue-test-no-such-builtin' was not found");
    expect(result.error).not.toContain('secret-user-name');
    expect(result.error).not.toContain(workDir);
    expect(result.error).toContain('2 PATH entries');
    expect(result.error).toContain('queue logs');
  });

  it.skipIf(!IS_WINDOWS)('Windows only: a .cmd planted in the working directory does NOT run in place of the tool of the PATH', async () => {
    const planted = join(workDir, 'planted-cwd');
    mkdirSync(planted);
    const marker = join(planted, 'planted-ran.txt');
    writeFileSync(join(planted, 'whoami.cmd'), `@echo off\r\necho PLANTED> "${marker}"\r\n`);
    const result = await run('whoami {{ v }}', { v: 'x' }, planted);
    // The real whoami.exe of System32 ran (it rejects the unknown argument or prints a user): either way the planted file did not
    expect(existsSync(marker)).toBe(false);
    expect(result.stdout ?? '').not.toContain('PLANTED');
  });

  it.skipIf(!IS_WINDOWS)('Windows only: a program written with a directory is resolved relative to the working directory', async () => {
    const dir = join(workDir, 'rel-dir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'local.cmd'), `@echo off\r\n"${NODE}" "${printer}" %*\r\n`);
    expect(received(await run('./local {{ v }}', { v: 'rel' }, dir)).argv).toEqual(['rel']);
    const missing = await run('local {{ v }}', { v: 'bare' }, dir);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("program 'local' was not found");
    expect(missing.error).toContain('./local');
  });

  it.skipIf(IS_WINDOWS)('POSIX only: a missing program fails with ENOENT, the subscriber and a Fix (not flagged permanent: spawn reports it)', async () => {
    const result = await run('queue-test-no-such-program {{ v }}', { v: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain("subscriber 'notify'");
    expect(result.error).toContain('the program was not found');
  });

  it('applies the timeout', async () => {
    const sleeper = join(workDir, 'sleeper.js');
    writeFileSync(sleeper, 'setTimeout(() => {}, 20000);');
    const result = await transport.dispatch(`"${NODE}" "${sleeper}" {{ v }}`, envelope({ v: 'x' }), 300, workDir, undefined, 'notify');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout/);
  });

  it('prints a timeout under one second in milliseconds, not as 0s', async () => {
    const sleeper = join(workDir, 'sleeper-ms.js');
    writeFileSync(sleeper, 'setTimeout(() => {}, 20000);');
    const result = await transport.dispatch(`"${NODE}" "${sleeper}" {{ v }}`, envelope({ v: 'x' }), 300, workDir, undefined, 'notify');
    expect(result.error).toMatch(/^timeout after 300ms/);
  });

  it('reports a non-zero exit', async () => {
    const failing = join(workDir, 'failing.js');
    writeFileSync(failing, 'process.exit(3);');
    const result = await run(`"${NODE}" "${failing}" {{ v }}`, { v: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('exited with code 3');
    expect(result.permanent).toBeUndefined();
  });

  it('refuses an unterminated quote as a permanent failure', async () => {
    const result = await run(`"${NODE}" "${printer}" "{{ v }}`, { v: 'x' });
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain('unterminated');
  });

  it('refuses a placeholder in the program position', async () => {
    const result = await run('{{ v }} arg', { v: NODE });
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
  });

  it.skipIf(IS_WINDOWS)('POSIX only (the shell script needs a shebang and chmod): an executable script receives the hostile values verbatim', async () => {
    const script = join(workDir, 'args.sh');
    writeFileSync(script, '#!/bin/sh\nprintf "%s|" "$@"\n');
    chmodSync(script, 0o755);
    const result = await run(`"${script}" {{ a }} {{ b }}`, { a: '$(touch injected-semicolon)', b: 'x; touch injected-semicolon' });
    expect(result.stdout).toBe('$(touch injected-semicolon)|x; touch injected-semicolon|');
    expect(existsSync(join(workDir, 'injected-semicolon'))).toBe(false);
  });
});

describe('CliTransport - exit code and output reach the result', () => {
  const NOISY_SOURCE = `process.stdout.write('to-out'); process.stderr.write('to-err'); process.exit(Number(process.argv[2] ?? 0));`;

  function noisy(): string {
    const file = join(workDir, 'noisy.js');
    writeFileSync(file, NOISY_SOURCE);
    return file;
  }

  it.each([
    ['with placeholders', (file: string, code: number) => `"${NODE}" "${file}" ${code} {{ v }}`],
    ['without placeholders', (file: string, code: number) => `"${NODE}" "${file}" ${code}`],
  ])('success %s: exitCode 0 and both streams', async (_label, build) => {
    const result = await run(build(noisy(), 0), { v: 'x' });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('to-out');
    expect(result.stderr).toBe('to-err');
  });

  it.each([
    ['with placeholders', (file: string, code: number) => `"${NODE}" "${file}" ${code} {{ v }}`],
    ['without placeholders', (file: string, code: number) => `"${NODE}" "${file}" ${code}`],
  ])('failure %s: non-zero exitCode and both streams', async (_label, build) => {
    const result = await run(build(noisy(), 4), { v: 'x' });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(4);
    expect(result.error).toBe('exited with code 4');
    expect(result.stdout).toBe('to-out');
    expect(result.stderr).toBe('to-err');
  });

  describe('a timeout stops the whole process tree, and a grandchild holding the pipes cannot block the dispatch', () => {
    let treeDir: string;
    beforeAll(() => {
      treeDir = join(workDir, 'tree');
      mkdirSync(treeDir);
      // The grandchild inherits the stdio pipes of the child. It records its pid, then writes the marker after 15 s unless it is killed (15 s only bounds a run where the kill does not work)
      writeFileSync(join(treeDir, 'grandchild.js'), `require('node:fs').writeFileSync(process.argv[3], String(process.pid)); setTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'alive'), 15000);`);
      writeFileSync(join(treeDir, 'parent.js'), `
        const { spawn } = require('node:child_process');
        spawn(process.execPath, [require('node:path').join(__dirname, 'grandchild.js'), process.argv[2], process.argv[3]], { stdio: 'inherit' });
        setTimeout(() => {}, 9000);
      `);
      // Exits at once and leaves a grandchild that keeps the pipes open for 7 s
      writeFileSync(join(treeDir, 'daemonizer.js'), `
        const { spawn } = require('node:child_process');
        // unref: the parent must be able to exit while the grandchild still holds the pipes
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 7000)'], { stdio: 'inherit' }).unref();
        process.stdout.write('parent-done');
      `);
    });

    it.each([
      ['with placeholders (no shell)', (marker: string, pidFile: string) => `"${NODE}" "${join(treeDir, 'parent.js')}" "${marker}" "${pidFile}" {{ v }}`],
      ['without placeholders (shell)', (marker: string, pidFile: string) => `"${NODE}" "${join(treeDir, 'parent.js')}" "${marker}" "${pidFile}"`],
    ])('%s: the timeout kills the whole tree, the grandchild included', async (label, build) => {
      const suffix = label.startsWith('with ') ? 'a' : 'b';
      const marker = join(treeDir, `marker-${suffix}.txt`);
      const pidFile = join(treeDir, `pid-${suffix}.txt`);
      // Only the timeout of the dispatch (1000 ms) is held back: the test fires it once the grandchild is known to run, so no race with a slow start
      const timers = new ManualTimers((delayMs) => delayMs === 1000);
      const pending = new CliTransport(timers).dispatch(build(marker, pidFile), envelope({ v: 'x' }), 1000, workDir, undefined, 'notify');
      await waitFor('the grandchild wrote its pid', () => existsSync(pidFile) && /^\d+$/.test(readFileSync(pidFile, 'utf8')));
      const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
      expect(isAlive(grandchildPid)).toBe(true);
      timers.fire(0);
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout after 1s/);
      // The dispatch ends at the latest 5 s after the kill even if the process never reports its end
      expect(timers.delays()).toContain(5000);
      // The grandchild is gone. If it survived, it would write the marker after 15 s: the marker is the proof, not a sleep
      await waitFor('the grandchild process to be gone', () => !isAlive(grandchildPid));
      expect(existsSync(marker)).toBe(false);
    });

    it('a program that exits while a grandchild keeps the pipes open resolves once the grace period after the exit is over, with what it printed and its exit code', async () => {
      // Every timer is held: the test fires the grace timer itself (when the pipes closed on their own first, the dispatch is already settled and firing it is a no-op)
      const timers = new ManualTimers(() => true);
      const pending = new CliTransport(timers).dispatch(`"${NODE}" "${join(treeDir, 'daemonizer.js')}" {{ v }}`, envelope({ v: 'x' }), 600_000, workDir, undefined, 'notify');
      // timer 0 is the timeout of the dispatch; the grace period is scheduled when the process exits
      await waitFor('the process exited and the grace timer was scheduled', () => timers.scheduled.length >= 2);
      expect(timers.scheduled[1]!.delayMs).toBe(3000);
      timers.fire(1);
      const result = await pending;
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('parent-done');
    });
  });

  it('a timeout carries no exitCode', async () => {
    const sleeper = join(workDir, 'sleeper2.js');
    writeFileSync(sleeper, 'setTimeout(() => {}, 20000);');
    const result = await transport.dispatch(`"${NODE}" "${sleeper}"`, envelope({}), 300, workDir, undefined, 'notify');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBeUndefined();
  });
});

describe('CliTransport - command without {{ }}: unchanged, run by the shell', () => {
  it('runs shell syntax as written (trusted subscribers.yml)', async () => {
    const result = await run('echo one && echo two', {});
    expect(result.success).toBe(true);
    expect(result.stdout).toMatch(/one/);
    expect(result.stdout).toMatch(/two/);
  });

  it('does not touch a payload: a literal payload-looking text stays', async () => {
    const result = await run('echo {{ not a placeholder', {});
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('{{ not a placeholder');
  });
});

describe.skipIf(!IS_WINDOWS)('CliTransport - Windows .cmd/.bat targets (cmd.exe /d /s /c)', () => {
  let shimDir: string;
  let shim: string;

  beforeAll(() => {
    shimDir = join(workDir, 'shims');
    mkdirSync(shimDir);
    shim = join(shimDir, 'shim.cmd');
    // %* forwards the quoted arguments to node unchanged
    writeFileSync(shim, `@echo off\r\n"${NODE}" "${printer}" %*\r\n`);
    writeFileSync(join(shimDir, 'legacy.bat'), `@echo off\r\n"${NODE}" "${printer}" %*\r\n`);
  });

  const ACCEPTED: ReadonlyArray<[string, string]> = [
    ['plain', 'hello'],
    ['spaces', 'hello  big world'],
    ['unicode', 'ünï 日本'],
    ['assignment and glob', 'a=b *.txt'],
    ['shell characters cmd ignores', "$(x) ; ' ( ) { } ~ #"],
    // 'trailing backslash' is not here: cmd.exe cannot pass it faithfully to both %~1 and a %* forwarded to a C-runtime program, so it is refused (see below)
    ['empty', ''],
  ];

  it.each(ACCEPTED)('accepted value reaches the program intact through a .cmd found in the working directory: %s', async (_label, value) => {
    const result = await run('./shim first {{ v }} last', { v: value }, shimDir);
    expect(received(result).argv).toEqual(['first', value, 'last']);
  });

  // set /p prints without a line break; the brackets show a lost or added character at either end. It sets errorlevel 1 on the empty input: exit /b 0 clears it
  function writeEchoBat(): string {
    const out = join(shimDir, 'echo-arg.txt');
    rmSync(out, { force: true });
    writeFileSync(join(shimDir, 'echo-arg.bat'), `@echo off\r\n<nul set /p="[%~1]"> "%~dp0echo-arg.txt"\r\nexit /b 0\r\n`);
    return out;
  }

  it.each([
    ['no trailing backslash', 'C:\\dir'],
    ['inner backslashes', 'C:\\a\\b'],
    ['a backslash followed by a space', 'C:\\a b\\ c'],
  ])('a batch file receives the value exactly in %%~1, %s', async (_label, value) => {
    const out = writeEchoBat();
    const result = await run('./echo-arg.bat {{ v }}', { v: value }, shimDir);
    expect(result.success, result.error).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe(`[${value}]`);
  });

  // cmd.exe cannot pass a final backslash faithfully: %~1 wants it raw, a program parsing %* like the C runtime wants it doubled. Refused instead of corrupted
  it.each([
    ['one trailing backslash', 'C:\\dir\\'],
    ['two trailing backslashes', 'C:\\a b\\\\'],
    ['a UNC path', '\\\\server\\share\\'],
    ['a lone backslash', '\\'],
  ])('refuses %s for a batch file: permanent failure naming the field, the backslash and the fix, and the batch file is not started', async (_label, value) => {
    const out = writeEchoBat();
    const result = await run('./echo-arg.bat {{ payload.dir }}', { dir: value }, shimDir);
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("subscriber 'notify'");
    expect(result.error).toContain("'dir'");
    expect(result.error).toContain('backslash');
    expect(result.error).toContain('Fix:');
    expect(existsSync(out)).toBe(false);
  });

  it('a recognised npm shim runs through node directly: a trailing backslash arrives intact', async () => {
    const npmDir = join(workDir, 'npm-shim');
    mkdirSync(npmDir);
    writeFileSync(join(npmDir, 'tool.js'), PRINTER_SOURCE);
    writeFileSync(join(npmDir, 'tool.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>nul || title %COMSPEC% & "%_prog%"  "%dp0%\\tool.js" %*', '',
    ].join('\r\n'));
    const result = await run('./tool {{ v }} {{ w }}', { v: 'C:\\dir\\', w: 'a & b' }, npmDir);
    expect(received(result).argv).toEqual(['C:\\dir\\', 'a & b']);
  });

  it('runs the .cmd by absolute path, and a .bat', async () => {
    expect(received(await run(`"${shim}" {{ v }}`, { v: 'abs path' })).argv).toEqual(['abs path']);
    expect(received(await run('./legacy.bat {{ v }}', { v: 'bat' }, shimDir)).argv).toEqual(['bat']);
  });

  it('finds a .cmd on PATH through PATHEXT', async () => {
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
    const result = await transport.dispatch('shim {{ v }}', envelope({ v: 'via-path' }), 30_000, workDir, { [pathKey]: `${shimDir};${process.env[pathKey] ?? ''}` }, 'notify');
    expect(received(result).argv).toEqual(['via-path']);
  });

  it.each([
    ['&', 'a & echo INJECTED> marker.txt'],
    ['|', 'a | echo INJECTED> marker.txt'],
    ['<', 'a < nul'],
    ['>', 'a > marker.txt'],
    ['^', 'a^b'],
    ['%', '%PATH%'],
    ['!', 'a!b'],
    ['"', 'a" & echo INJECTED> marker.txt & "'],
    ['`', 'a`b'],
    ['CR', 'a\rb'],
    ['LF', 'a\nb & echo INJECTED> marker.txt'],
  ])('refuses a value holding %s as a permanent failure naming the subscriber, the field and the character class, and runs nothing', async (_label, value) => {
    const result = await run('./shim {{ payload.title }}', { title: value }, shimDir);
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("subscriber 'notify'");
    expect(result.error).toContain("'title'");
    expect(result.error).toContain('cmd.exe');
    expect(result.error).toContain('Fix:');
    expect(result.error).not.toContain(value);
    expect(existsSync(join(shimDir, 'marker.txt'))).toBe(false);
    expect(existsSync(join(workDir, 'marker.txt'))).toBe(false);
  });

  it('names the character class in the refusal', async () => {
    const result = await run('./shim {{ v }}', { v: 'a & b' }, shimDir);
    expect(result.error).toContain("'&' (command separator)");
  });

  it('does not check the literal part of the template, only the substituted values', async () => {
    const result = await run('./shim --flag=100%% {{ v }}', { v: 'ok' }, shimDir);
    expect(result.permanent).toBeUndefined();
  });

  it('a command without {{ }} that targets the .cmd keeps going through the shell, as before', async () => {
    const result = await run('shim plain & echo second', {}, shimDir);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('second');
  });
});
