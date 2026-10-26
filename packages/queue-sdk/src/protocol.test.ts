import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  SDK_UNDERSTANDS,
  DAEMON_ACCEPTS,
  LEGACY_DAEMON_PROTOCOL,
  parseDaemonProtocol,
  negotiate,
  checkClientProtocol,
  daemonSupportsEventCatalog,
  daemonSupportsPushProject,
  daemonSupportsPushWithoutCwd,
} from './protocol.js';
import { satisfies } from './semver.js';

describe('protocol constants', () => {
  it('start at 1.1.0 and are consistent with each other', () => {
    expect(PROTOCOL_VERSION).toBe('1.3.0');
    expect(satisfies(PROTOCOL_VERSION, DAEMON_ACCEPTS)).toBe(true);
    expect(satisfies(PROTOCOL_VERSION, SDK_UNDERSTANDS)).toBe(true);
  });

  it('describe the daemon that exists today: a /version without queueProtocol is 1.0.0 accepting ^1.0.0', () => {
    expect(LEGACY_DAEMON_PROTOCOL).toEqual({ version: '1.0.0', accepts: '^1.0.0' });
  });
});

describe('parseDaemonProtocol (what GET /version says)', () => {
  it('reads version and accepts', () => {
    expect(parseDaemonProtocol({ version: '2026.10.23', queueProtocol: { version: '1.2.0', accepts: '^1.0.0 || ^2.0.0' } })).toEqual({
      version: '1.2.0',
      accepts: '^1.0.0 || ^2.0.0',
    });
  });

  it('treats a missing queueProtocol as the legacy daemon (it predates versioning, it is not broken)', () => {
    expect(parseDaemonProtocol({ version: '2026.10.20', pid: 1 })).toEqual(LEGACY_DAEMON_PROTOCOL);
  });

  it.each([
    ['a non-object /version answer', 'oops'],
    ['null', null],
    ['queueProtocol not an object', { queueProtocol: '1.0.0' }],
    ['queueProtocol without version', { queueProtocol: { accepts: '^1.0.0' } }],
    ['queueProtocol without accepts', { queueProtocol: { version: '1.0.0' } }],
    ['a malformed version', { queueProtocol: { version: '1.x', accepts: '^1.0.0' } }],
    ['a malformed range', { queueProtocol: { version: '1.0.0', accepts: '~1' } }],
  ])('throws on %s, saying what it got', (_label, answer) => {
    expect(() => parseDaemonProtocol(answer)).toThrow(/queueProtocol|\/version/);
  });
});

describe('negotiate (SDK side, before sending anything)', () => {
  it('agrees with a daemon of the same version', () => {
    expect(negotiate({ version: '1.0.0', accepts: '^1.0.0' })).toEqual({ ok: true, version: PROTOCOL_VERSION });
  });

  it('agrees with a newer MINOR daemon: additive changes are compatible', () => {
    expect(negotiate({ version: '1.4.0', accepts: '^1.0.0' })).toEqual({ ok: true, version: PROTOCOL_VERSION });
  });

  it('refuses a daemon of a MAJOR the SDK does not understand, naming both versions and who to update', () => {
    const result = negotiate({ version: '2.0.0', accepts: '^2.0.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('2.0.0');
      expect(result.reason).toContain(PROTOCOL_VERSION);
      expect(result.reason).toMatch(/update .*queue-sdk/i);
    }
  });

  it('refuses a daemon that no longer accepts the SDK version (the SDK is too old)', () => {
    const result = negotiate({ version: '1.5.0', accepts: '>=1.9.0 <2.0.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('>=1.9.0 <2.0.0');
      expect(result.reason).toMatch(/update .*queue-sdk/i);
    }
  });

  it('refuses a daemon older than what the SDK understands and says to update queue', () => {
    const result = negotiate({ version: '1.0.0', accepts: '^1.0.0' }, { version: '2.0.0', understands: '^2.0.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/update .*queue-cli/i);
    }
  });

  it('keeps talking to a daemon that still accepts the previous MAJOR during its deprecation window', () => {
    expect(negotiate({ version: '2.0.0', accepts: '^1.0.0 || ^2.0.0' }, { version: '1.0.0', understands: '^1.0.0 || ^2.0.0' })).toEqual({
      ok: true,
      version: '1.0.0',
    });
  });
});

describe('checkClientProtocol (daemon side, on receipt of a push)', () => {
  it('takes an absent protocol as 1.0.0, so every client that exists today keeps working', () => {
    expect(checkClientProtocol(undefined)).toEqual({ ok: true, version: '1.0.0' });
  });

  it('accepts a version inside the accepted range', () => {
    expect(checkClientProtocol('1.3.0')).toEqual({ ok: true, version: '1.3.0' });
  });

  it('rejects a version outside the accepted range, with the range', () => {
    const result = checkClientProtocol('2.0.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('2.0.0');
      expect(result.supported).toBe(DAEMON_ACCEPTS);
    }
  });

  it.each([['1'], ['1.0'], ['v1.0.0'], [1], [{}], [null], ['']])('rejects the malformed protocol %j without throwing', (value) => {
    const result = checkClientProtocol(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/protocol/i);
      expect(result.supported).toBe(DAEMON_ACCEPTS);
    }
  });

  it('uses the range it is given (a daemon in a later release)', () => {
    expect(checkClientProtocol('1.0.0', '^2.0.0').ok).toBe(false);
    expect(checkClientProtocol('2.1.0', '^1.0.0 || ^2.0.0').ok).toBe(true);
  });
});

describe('daemonSupportsEventCatalog (the event catalog arrived with protocol 1.1.0)', () => {
  it.each([
    ['1.0.0', false],
    ['1.0.9', false],
    ['1.1.0', true],
    ['1.4.2', true],
  ])('a daemon at %s: %s', (version, expected) => {
    expect(daemonSupportsEventCatalog(version)).toBe(expected);
  });
});

describe('daemonSupportsPushWithoutCwd (a push of a project without folder needs protocol 1.3.0)', () => {
  it.each([
    ['1.2.0', false],
    ['1.3.0', true],
    ['1.10.0', true],
  ])('a daemon speaking %s -> %s', (version, expected) => {
    expect(daemonSupportsPushWithoutCwd(version)).toBe(expected);
  });
});

describe('daemonSupportsPushProject (the project field of a push arrived with protocol 1.2.0)', () => {
  it.each([
    ['1.0.0', false],
    ['1.1.0', false],
    ['1.2.0', true],
    ['1.10.0', true],
  ])('a daemon speaking %s -> %s', (version, expected) => {
    expect(daemonSupportsPushProject(version)).toBe(expected);
  });
});
