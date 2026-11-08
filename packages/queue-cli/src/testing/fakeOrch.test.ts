import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createIsolatedCliEnv, type IsolatedCliEnv } from './isolatedCliEnv.js';
import { isInside, pathKeyOf } from './fakeOrch.js';

describe('the fake orch of an isolated environment', () => {
  let iso: IsolatedCliEnv | undefined;

  afterEach(() => {
    iso?.cleanup();
    iso = undefined;
  });

  // What RetryScheduler does: ask the PATH (where / which), then run the first answer
  const lookup = (e: IsolatedCliEnv): string[] =>
    execFileSync(process.platform === 'win32' ? 'where' : 'which', process.platform === 'win32' ? ['orch'] : ['-a', 'orch'], { encoding: 'utf8', env: e.env, windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

  // The file to run: refuses (before anything runs) one that is not inside the throwaway tree, so a broken fake can never execute the machine's real orch
  const fakeFile = (e: IsolatedCliEnv): string => {
    const first = lookup(e)[0]!;
    if (!isInside(first, e.root)) {
      throw new Error(`the first orch on the PATH is ${first}, not the fake of the environment (${e.root}): refusing to run it`);
    }
    return first;
  };

  it("is the first orch on the PATH of the environment, inside its throwaway tree, never the machine's orch", () => {
    iso = createIsolatedCliEnv();
    const found = lookup(iso);
    expect(isInside(found[0]!, iso.root), found.join(' | ')).toBe(true);
    expect(found[0]).toContain('fake-bin');
  });

  it('runs the way RetryScheduler runs orch (execFile of what the lookup returned): exits 0 and records the arguments, nothing else', () => {
    iso = createIsolatedCliEnv();
    expect(iso.orch.readCalls()).toEqual([]);
    const file = fakeFile(iso);
    execFileSync(file, ['add', '--once', 'job-1', '--delay', '2m', '--command', 'queue retry --event w 1'], { env: iso.env, stdio: 'pipe', windowsHide: true });
    execFileSync(file, ['add', 'second'], { env: iso.env, stdio: 'pipe', windowsHide: true });
    expect(iso.orch.readCalls()).toEqual([
      { argv: ['add', '--once', 'job-1', '--delay', '2m', '--command', 'queue retry --event w 1'] },
      { argv: ['add', 'second'] },
    ]);
  });

  it('does not turn the other node processes of the environment into the fake', () => {
    iso = createIsolatedCliEnv();
    // a script that really runs (--version would exit before any preload does)
    const script = join(iso.root, 'hello.cjs');
    writeFileSync(script, "console.log('hello');\n");
    const output = execFileSync(process.execPath, [script], { env: iso.env, encoding: 'utf8', windowsHide: true });
    expect(output.trim()).toBe('hello');
    expect(iso.orch.readCalls()).toEqual([]);
  });

  it('keeps the rest of the parent PATH behind the fake, and each environment has its own record', () => {
    iso = createIsolatedCliEnv();
    const other = createIsolatedCliEnv();
    try {
      expect(iso.env[pathKeyOf(iso.env)]!.endsWith(process.env[pathKeyOf(process.env)]!)).toBe(true);
      execFileSync(fakeFile(iso), ['add', 'x'], { env: iso.env, stdio: 'pipe', windowsHide: true });
      expect(iso.orch.readCalls()).toHaveLength(1);
      expect(other.orch.readCalls()).toEqual([]);
    } finally {
      other.cleanup();
    }
  });

  it('extends the PATH and the NODE_OPTIONS the caller asks for in `extra`, never replaces them (replacing would drop the fake)', () => {
    iso = createIsolatedCliEnv({ extra: { NODE_OPTIONS: '--no-warnings', [pathKeyOf(process.env)]: `${process.env[pathKeyOf(process.env)]}${delimiter}/extra/bin` } });
    expect(iso.env[pathKeyOf(iso.env)]!.startsWith(iso.orch.binDir)).toBe(true);
    expect(iso.env[pathKeyOf(iso.env)]!.endsWith('/extra/bin')).toBe(true);
    expect(iso.env['NODE_OPTIONS']).toContain('--no-warnings');
    // Windows runs the fake through a preload of the node it is a copy of; elsewhere it is a script and NODE_OPTIONS is the caller's
    expect(iso.env['NODE_OPTIONS']!.includes('--require=')).toBe(process.platform === 'win32');
    execFileSync(fakeFile(iso), ['add', 'x'], { env: iso.env, stdio: 'pipe', windowsHide: true });
    expect(iso.orch.readCalls()).toEqual([{ argv: ['add', 'x'] }]);
  });
});

describe('isInside - is a path inside a tree, whatever form the platform gives the two paths', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'queue-isinside-'));
    mkdirSync(join(base, 'root', 'fake-bin'), { recursive: true });
    mkdirSync(join(base, 'root-other'), { recursive: true });
    writeFileSync(join(base, 'root', 'fake-bin', 'orch.exe'), '');
    writeFileSync(join(base, 'root-other', 'orch.exe'), '');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('accepts a file under the root', () => {
    expect(isInside(join(base, 'root', 'fake-bin', 'orch.exe'), join(base, 'root'))).toBe(true);
  });

  it('refuses a sibling folder that merely starts with the same characters (a string prefix test accepts it)', () => {
    expect(isInside(join(base, 'root-other', 'orch.exe'), join(base, 'root'))).toBe(false);
  });

  it('refuses a path that climbs out of the root with ..', () => {
    expect(isInside(join(base, 'root', '..', 'root-other', 'orch.exe'), join(base, 'root'))).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('accepts the same folder written in another case (Windows paths are case-insensitive)', () => {
    expect(isInside(join(base, 'root', 'fake-bin', 'orch.exe').toUpperCase(), join(base, 'root'))).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('accepts the 8.3 short form of the root against the long form of the file (what where.exe returned on the CI runner)', () => {
    // Verbatim arguments: Node would otherwise escape the quotes of the command line and cmd.exe would print garbage
    const short = (spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${join(base, 'root')}") do @echo %~sI"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).stdout ?? '').trim();
    expect(short, 'the 8.3 short name lookup returned something that is not a path').toMatch(/^[A-Za-z]:\\/);
    expect(isInside(join(base, 'root', 'fake-bin', 'orch.exe'), short)).toBe(true);
  });
});
