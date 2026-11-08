import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameReplacing } from './AtomicRename.js';

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

describe('renameReplacing', () => {
  it('renames at once when the target is free', () => {
    const calls: Array<[string, string]> = [];
    renameReplacing('a.tmp', 'a', { rename: (f, t) => { calls.push([f, t]); }, sleep: () => { throw new Error('must not sleep'); } });
    expect(calls).toEqual([['a.tmp', 'a']]);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries after %s and succeeds once the target is released', (code) => {
    let failures = 2;
    const sleeps: number[] = [];
    renameReplacing('a.tmp', 'a', {
      rename: () => {
        if (failures-- > 0) {
          throw errno(code);
        }
      },
      sleep: (ms) => { sleeps.push(ms); },
    });
    expect(sleeps).toHaveLength(2);
  });

  it('throws any other error at once, untouched', () => {
    const failure = errno('ENOENT');
    expect(() => renameReplacing('a.tmp', 'a', { rename: () => { throw failure; }, sleep: () => { throw new Error('must not sleep'); } })).toThrow(failure);
  });

  it('gives up on a target that stays busy with a message naming the file, the code and what to do', () => {
    let calls = 0;
    expect(() => renameReplacing('a.tmp', 'a', { attempts: 3, rename: () => { calls++; throw errno('EPERM'); }, sleep: () => undefined }))
      .toThrow(/Could not replace a: EPERM on rename from a\.tmp after 3 attempts.*another program holds the file open.*exclude the queue config directory/s);
    expect(calls).toBe(3);
  });
});

describe('renameReplacing classifies the failure before waiting', () => {
  const ok = (): void => undefined;
  const denied = (code: string) => (): never => {
    throw errno(code);
  };

  it('retries EBUSY always, whatever the permissions say (a busy file is a transient lock)', () => {
    let failures = 3;
    const sleeps: number[] = [];
    renameReplacing('a.tmp', 'a', {
      rename: () => {
        if (failures-- > 0) throw errno('EBUSY');
      },
      sleep: ms => { sleeps.push(ms); },
      access: denied('EPERM'),
    });
    expect(sleeps).toHaveLength(3);
  });

  it.each(['EPERM', 'EACCES'])('retries %s when the target exists and is writable (another program holds it for a moment)', (code) => {
    let failures = 2;
    const sleeps: number[] = [];
    renameReplacing('a.tmp', 'a', {
      rename: () => {
        if (failures-- > 0) throw errno(code);
      },
      sleep: ms => { sleeps.push(ms); },
      access: ok,
    });
    expect(sleeps).toHaveLength(2);
  });

  it.each(['EPERM', 'EACCES'])('throws %s at once, without sleeping, when the existing target is not writable (read-only), and lists every cause', (code) => {
    let calls = 0;
    const started = Date.now();
    let message = '';
    try {
      renameReplacing('wal.ndjson.1.tmp', 'wal.ndjson', {
        rename: () => { calls++; throw errno(code); },
        sleep: () => { throw new Error('must not sleep on a permanent permission problem'); },
        access: denied('EPERM'),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(Date.now() - started).toBeLessThan(200);
    expect(calls).toBe(1);
    expect(message).toContain(`Could not replace wal.ndjson: ${code}`);
    expect(message).toContain('from wal.ndjson.1.tmp');
    expect(message).toContain('another program holds the file open');
    expect(message).toContain('read-only');
    expect(message).toContain('permissions');
    expect(message).toContain('attrib -R');
    expect(message).not.toContain('attempts');
  });

  it('keeps the original error as the cause of a permanent failure', () => {
    const failure = errno('EPERM');
    try {
      renameReplacing('a.tmp', 'a', { rename: () => { throw failure; }, sleep: ok, access: denied('EPERM') });
      expect.unreachable('must throw');
    } catch (err) {
      expect((err as Error).cause).toBe(failure);
    }
  });

  it('a target that does not exist yet is retried when its directory is writable, and fails at once when it is not', () => {
    const accessed: string[] = [];
    const missingTarget = (path: string): void => {
      accessed.push(path);
      if (path === 'dir/a') throw errno('ENOENT');
    };
    let failures = 1;
    renameReplacing('dir/a.tmp', 'dir/a', {
      rename: () => { if (failures-- > 0) throw errno('EPERM'); },
      sleep: ok,
      access: missingTarget,
    });
    expect(accessed).toEqual(['dir/a', 'dir']);

    const readOnlyDir = (path: string): void => {
      throw errno(path === 'dir/a' ? 'ENOENT' : 'EACCES');
    };
    expect(() => renameReplacing('dir/a.tmp', 'dir/a', {
      rename: denied('EPERM'),
      sleep: () => { throw new Error('must not sleep'); },
      access: readOnlyDir,
    })).toThrow(/Could not replace dir\/a: EPERM.*not retried/s);
  });

  it('blocks the event loop for at most one second on a target that stays busy, and the code says so', () => {
    const sleeps: number[] = [];
    expect(() => renameReplacing('a.tmp', 'a', { rename: denied('EBUSY'), sleep: ms => { sleeps.push(ms); }, access: ok })).toThrow(/after \d+ attempts/);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(1000);
    expect(sleeps.length).toBeGreaterThan(10);
  });

  it('the exhausted-retries message names the code, the paths, the attempts and both causes', () => {
    expect(() => renameReplacing('a.tmp', 'a', { attempts: 3, rename: denied('EBUSY'), sleep: ok, access: ok }))
      .toThrow(/Could not replace a: EBUSY on rename from a\.tmp after 3 attempts.*another program holds the file open.*read-only.*permissions/s);
  });

  // The real thing: a read-only file on Windows must fail fast with the permission advice, not after a second of blocking and a misleading message
  it.skipIf(process.platform !== 'win32')('REAL read-only target on Windows (attrib +R): fails in well under 200 ms and names the read-only case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-atomic-rename-'));
    const target = join(dir, 'wal.ndjson');
    const source = join(dir, 'wal.ndjson.1.tmp');
    writeFileSync(target, 'old');
    writeFileSync(source, 'new');
    execFileSync('attrib', ['+R', target]);
    let message = '';
    let elapsed = Infinity;
    try {
      const started = performance.now();
      try {
        renameReplacing(source, target);
      } catch (err) {
        message = (err as Error).message;
      }
      elapsed = performance.now() - started;
    } finally {
      execFileSync('attrib', ['-R', target]);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(message).toContain('Could not replace');
    expect(message).toContain('read-only');
    expect(elapsed).toBeLessThan(200);
  });
});
