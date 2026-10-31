import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliTransport, type DispatchResult } from './CliTransport.js';
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

function run(command: string, payload: unknown, cwd: string = workDir): Promise<DispatchResult> {
  return transport.dispatch(command, envelope(payload), 30_000, cwd, undefined, 'notify');
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'queue-clitransport-'));
  printer = join(workDir, 'printer.js');
  writeFileSync(printer, PRINTER_SOURCE);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
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
  ['option-like', '--help'],
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
    expect(result.error).toContain('Fix: install it, put it on PATH, or give its full path in the command.');
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
    ['trailing backslash', 'C:\\dir\\'],
    ['empty', ''],
  ];

  it.each(ACCEPTED)('accepted value reaches the program intact through a .cmd found in the working directory: %s', async (_label, value) => {
    const result = await run('shim first {{ v }} last', { v: value }, shimDir);
    expect(received(result).argv).toEqual(['first', value, 'last']);
  });

  it('runs the .cmd by absolute path, and a .bat', async () => {
    expect(received(await run(`"${shim}" {{ v }}`, { v: 'abs path' })).argv).toEqual(['abs path']);
    expect(received(await run('legacy.bat {{ v }}', { v: 'bat' }, shimDir)).argv).toEqual(['bat']);
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
    const result = await run('shim {{ payload.title }}', { title: value }, shimDir);
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
    const result = await run('shim {{ v }}', { v: 'a & b' }, shimDir);
    expect(result.error).toContain("'&' (command separator)");
  });

  it('does not check the literal part of the template, only the substituted values', async () => {
    const result = await run('shim --flag=100%% {{ v }}', { v: 'ok' }, shimDir);
    expect(result.permanent).toBeUndefined();
  });

  it('a command without {{ }} that targets the .cmd keeps going through the shell, as before', async () => {
    const result = await run('shim plain & echo second', {}, shimDir);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('second');
  });
});
