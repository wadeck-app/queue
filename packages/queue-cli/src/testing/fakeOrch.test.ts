import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createIsolatedCliEnv, type IsolatedCliEnv } from './isolatedCliEnv.js';
import { pathKeyOf } from './fakeOrch.js';

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
    if (!first.startsWith(e.root)) {
      throw new Error(`the first orch on the PATH is ${first}, not the fake of the environment (${e.root}): refusing to run it`);
    }
    return first;
  };

  it("is the first orch on the PATH of the environment, inside its throwaway tree, never the machine's orch", () => {
    iso = createIsolatedCliEnv();
    const found = lookup(iso);
    expect(found[0]!.startsWith(iso.root), found.join(' | ')).toBe(true);
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
