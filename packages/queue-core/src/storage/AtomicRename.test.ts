import { describe, it, expect } from 'vitest';
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
      .toThrow(/Could not replace a: EPERM on rename from a\.tmp after 3 attempts.*Another program keeps the file open.*exclude the queue config directory/s);
    expect(calls).toBe(3);
  });
});
