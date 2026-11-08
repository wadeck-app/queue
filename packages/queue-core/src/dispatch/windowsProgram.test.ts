import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { delimiter, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describePathEntryCount, findWindowsProgram } from './windowsProgram.js';

// Real folders and lowercase PATHEXT: the search order is the same on every platform, so this test runs everywhere
let root: string;
let cwd: string;
let binA: string;
let binB: string;

function touch(directory: string, name: string): string {
  const file = join(directory, name);
  writeFileSync(file, '');
  return file;
}

function envWith(...directories: string[]): NodeJS.ProcessEnv {
  return { PATH: directories.join(delimiter), PATHEXT: '.com;.exe;.bat;.cmd' };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'queue-winprog-'));
  cwd = join(root, 'cwd');
  binA = join(root, 'binA');
  binB = join(root, 'binB');
  for (const directory of [cwd, binA, binB]) {
    mkdirSync(directory);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findWindowsProgram - a bare program name is looked up on PATH only', () => {
  it('does not pick a file planted in the working directory when the PATH holds the real tool', () => {
    touch(cwd, 'tool.cmd');
    const real = touch(binA, 'tool.exe');
    expect(findWindowsProgram('tool', cwd, envWith(binA))).toBe(real);
  });

  it('does not find a program that exists only in the working directory', () => {
    touch(cwd, 'tool.cmd');
    expect(findWindowsProgram('tool', cwd, envWith(binA))).toBeUndefined();
  });

  it('takes the first PATH directory that has it, trying the PATHEXT extensions in order', () => {
    touch(binB, 'tool.exe');
    const first = touch(binA, 'tool.cmd');
    expect(findWindowsProgram('tool', cwd, envWith(binA, binB))).toBe(first);
    touch(binA, 'tool.exe');
    expect(findWindowsProgram('tool', cwd, envWith(binA, binB))).toBe(join(binA, 'tool.exe'));
  });

  it('accepts a name that already carries an extension of PATHEXT', () => {
    const real = touch(binA, 'tool.cmd');
    expect(findWindowsProgram('tool.cmd', cwd, envWith(binA))).toBe(real);
  });
});

describe('findWindowsProgram - a program written with a directory is resolved as given, relative to the working directory', () => {
  it('./tool and sub/tool', () => {
    const local = touch(cwd, 'tool.cmd');
    mkdirSync(join(cwd, 'sub'));
    const nested = touch(join(cwd, 'sub'), 'other.exe');
    expect(findWindowsProgram('./tool', cwd, envWith(binA))).toBe(local);
    expect(findWindowsProgram('sub/other', cwd, envWith(binA))).toBe(nested);
  });

  it('an absolute path, whatever the working directory and PATH', () => {
    const real = touch(binB, 'tool.exe');
    expect(findWindowsProgram(join(binB, 'tool'), cwd, envWith(binA))).toBe(real);
  });

  it('does not fall back to PATH when the path is missing', () => {
    touch(binA, 'tool.exe');
    expect(findWindowsProgram('./tool', cwd, envWith(binA))).toBeUndefined();
  });
});

describe('describePathEntryCount - what a "program not found" error may say about PATH (it reaches the DLQ and the events subscribers see)', () => {
  it('gives the count and no directory', () => {
    const text = describePathEntryCount(envWith(binA, binB));
    expect(text).toBe('2 PATH entries');
    expect(text).not.toContain(root);
  });

  it('says so when PATH is empty or missing', () => {
    expect(describePathEntryCount({ PATH: '' })).toBe('PATH is empty or not set');
    expect(describePathEntryCount({})).toBe('PATH is empty or not set');
  });

  it('counts one entry without a plural', () => {
    expect(describePathEntryCount(envWith(binA))).toBe('1 PATH entry');
  });
});

describe('findWindowsProgram - a relative PATH entry is ignored (it would resolve against the subscriber working directory)', () => {
  it('does not find a tool planted in the working directory through PATH=.', () => {
    touch(cwd, 'tool.cmd');
    expect(findWindowsProgram('tool', cwd, envWith('.'))).toBeUndefined();
  });

  it('does not find a tool in a relative PATH entry such as bin', () => {
    mkdirSync(join(cwd, 'bin'));
    touch(join(cwd, 'bin'), 'tool.exe');
    expect(findWindowsProgram('tool', cwd, envWith('bin'))).toBeUndefined();
  });

  it('still finds the tool in the absolute entries around a relative one', () => {
    touch(cwd, 'tool.cmd');
    const real = touch(binB, 'tool.exe');
    expect(findWindowsProgram('tool', cwd, envWith('.', binB))).toBe(real);
  });

  it('reports the ignored entries by count in the not-found message, without the directories', () => {
    expect(describePathEntryCount(envWith(binA, '.', 'bin'))).toBe('3 PATH entries (2 relative entries ignored: they would resolve against the working directory)');
    expect(describePathEntryCount(envWith(binA, '.'))).toBe('2 PATH entries (1 relative entry ignored: it would resolve against the working directory)');
  });
});
