import { describe, it, expect } from 'vitest';
import { WAKE_LINE_MAX_BYTES, MAX_SOCKET_PATH_BYTES, deriveWakeAddress, encodeWake, parseWake } from './WaiterWake.js';

// Pure parts: they run on every platform (the platform, tmpdir and uid are parameters)
const POSIX = { platform: 'linux' as const, tmpdir: () => '/tmp', uid: 1000 };

describe('deriveWakeAddress: the address is a function of the config dir and the validated name, nothing else', () => {
  it('Windows: a named pipe whose name holds a hash of the config dir and the name', () => {
    const a = deriveWakeAddress('C:\\Users\\me\\.config\\queue', 'w-agent-wake.ab12cd34', { platform: 'win32' });
    expect(a).toEqual({ kind: 'pipe', path: expect.stringMatching(/^\\\\\.\\pipe\\queue-wait-[0-9a-f]{12}-w-agent-wake\.ab12cd34$/) });
  });

  it('Windows: two config dirs never share a pipe, and the same dir written with another case or a trailing separator does', () => {
    const win = { platform: 'win32' as const };
    const one = deriveWakeAddress('C:\\Users\\me\\q1', 'a.b', win);
    const two = deriveWakeAddress('C:\\Users\\me\\q2', 'a.b', win);
    expect(one).not.toEqual(two);
    expect(deriveWakeAddress('c:\\users\\ME\\q1\\', 'a.b', win)).toEqual(one);
  });

  it('POSIX: a socket in the waiters folder of the config dir, named after a hash of the name (the name never reaches the file name)', () => {
    const a = deriveWakeAddress('/home/me/.config/queue', 'w-agent-wake.ab12cd34', POSIX);
    expect(a).toEqual({ kind: 'pipe', path: expect.stringMatching(/^\/home\/me\/\.config\/queue\/waiters\/wake-[0-9a-f]{16}\.sock$/) });
    expect(JSON.stringify(a)).not.toContain('w-agent-wake');
  });

  it('POSIX: two names get two sockets, the same name the same socket', () => {
    const one = deriveWakeAddress('/c', 'a.b', POSIX);
    expect(deriveWakeAddress('/c', 'a.b', POSIX)).toEqual(one);
    expect(deriveWakeAddress('/c', 'a.c', POSIX)).not.toEqual(one);
  });

  it('POSIX: the path of the socket is never longer than the sun_path limit, the longest name included (the hash, not the name, is in it)', () => {
    const longName = 'x'.repeat(31) + '.' + 'y'.repeat(32);
    const a = deriveWakeAddress('/c', longName, POSIX);
    expect(a.kind).toBe('pipe');
    if (a.kind === 'pipe') {
      expect(Buffer.byteLength(a.path)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    }
  });

  it('POSIX: a config dir too deep for the socket falls back to a short path under the temp dir, in a private per-user folder', () => {
    const deep = '/' + 'd'.repeat(120);
    const a = deriveWakeAddress(deep, 'a.b', POSIX);
    expect(a).toEqual({ kind: 'pipe', path: expect.stringMatching(/^\/tmp\/queue-wait-1000\/[0-9a-f]{8}-[0-9a-f]{10}\.sock$/), privateDir: '/tmp/queue-wait-1000' });
  });

  it('POSIX: the fallback is per config dir (two deep config dirs do not share a socket)', () => {
    const one = deriveWakeAddress('/' + 'd'.repeat(120), 'a.b', POSIX);
    const two = deriveWakeAddress('/' + 'e'.repeat(120), 'a.b', POSIX);
    expect(one).not.toEqual(two);
  });

  it('POSIX: when even the fallback is too long there is no wake, and the reason says what to change', () => {
    const a = deriveWakeAddress('/' + 'd'.repeat(120), 'a.b', { ...POSIX, tmpdir: () => '/' + 't'.repeat(100) });
    expect(a.kind).toBe('none');
    if (a.kind === 'none') {
      expect(a.reason).toMatch(/TMPDIR/);
      expect(a.reason).toMatch(/QUEUE_CONFIG_DIR/);
    }
  });

  it('counts bytes, not characters (a multi-byte config dir path)', () => {
    const accents = '/' + 'é'.repeat(45);
    const a = deriveWakeAddress(accents, 'a.b', POSIX);
    expect(a.kind === 'pipe' && a.path.startsWith('/tmp/queue-wait-')).toBe(true);
  });

  it.each(['', 'nodot', '../a.b', 'A.b', 'a/b.c', 'a\\b.c'])('refuses to derive from the invalid name %j (no path is ever built from it)', (name) => {
    for (const platform of ['win32', 'linux'] as const) {
      const a = deriveWakeAddress('/c', name, { ...POSIX, platform });
      expect(a.kind).toBe('none');
    }
  });
});

describe('the wake line: an event name and an event id, nothing else', () => {
  it('round-trips', () => {
    const line = encodeWake({ event: 'onTaskDone', eventId: 'evt-1' });
    expect(line.endsWith('\n')).toBe(true);
    expect(parseWake(line.trimEnd())).toEqual({ event: 'onTaskDone', eventId: 'evt-1' });
  });

  it('is small and fits one read', () => {
    expect(Buffer.byteLength(encodeWake({ event: 'e'.repeat(2000), eventId: 'i'.repeat(2000) }))).toBeLessThanOrEqual(WAKE_LINE_MAX_BYTES);
  });

  it.each([
    ['not JSON', 'hello'],
    ['an array', '[1]'],
    ['no marker', '{"event":"a","eventId":"b"}'],
    ['a wrong version', '{"wake":2,"event":"a","eventId":"b"}'],
    ['a payload', '{"wake":1,"event":"a","eventId":"b","payload":{"x":1}}'],
    ['an extra key that sorts after the others', '{"wake":1,"event":"a","eventId":"b","zzz":1}'],
    ['a number for the event', '{"wake":1,"event":1,"eventId":"b"}'],
    ['an empty event', '{"wake":1,"event":"","eventId":"b"}'],
    ['a control character', '{"wake":1,"event":"a\\u0007","eventId":"b"}'],
    ['an event id that is too long', `{"wake":1,"event":"a","eventId":"${'i'.repeat(200)}"}`],
    ['an empty line', ''],
  ])('ignores %s', (_label, line) => {
    expect(parseWake(line)).toBeUndefined();
  });
});
