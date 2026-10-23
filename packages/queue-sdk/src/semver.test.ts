import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, satisfies, parseRange, SemverError } from './semver.js';

describe('parseVersion', () => {
  it('reads MAJOR.MINOR.PATCH', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseVersion('10.20.30')).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  it.each(['', '1', '1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '01.2.3', '1.02.3', '-1.2.3', '1.2.3-beta', '1.2.3+build', ' 1.2.3', '1.2.3 '])(
    'rejects %j and names it in the error (protocol versions have no prerelease, build or padding)',
    (text) => {
      expect(() => parseVersion(text)).toThrow(SemverError);
      expect(() => parseVersion(text)).toThrow(JSON.stringify(text));
    },
  );

  it('rejects a non-string value', () => {
    expect(() => parseVersion(1 as unknown as string)).toThrow(SemverError);
    expect(() => parseVersion(undefined as unknown as string)).toThrow(SemverError);
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.2.0', '1.10.0', -1],
    ['1.0.2', '1.0.10', -1],
    ['1.1.0', '1.0.9', 1],
  ])('%s vs %s is %d', (a, b, expected) => {
    expect(compareVersions(parseVersion(a), parseVersion(b))).toBe(expected);
  });
});

describe('satisfies', () => {
  it.each([
    ['1.0.0', '^1.0.0', true],
    ['1.9.9', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.9.9', '^1.0.0', false],
    ['1.2.3', '^1.2.4', false],
    ['1.2.4', '^1.2.4', true],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
  ])('caret: %s in %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it.each([
    ['1.0.0', '>=1.0.0', true],
    ['0.9.9', '>=1.0.0', false],
    ['1.0.0', '>1.0.0', false],
    ['1.0.1', '>1.0.0', true],
    ['1.0.0', '<=1.0.0', true],
    ['1.0.1', '<=1.0.0', false],
    ['0.9.9', '<1.0.0', true],
    ['1.0.0', '<1.0.0', false],
    ['1.2.3', '=1.2.3', true],
    ['1.2.4', '=1.2.3', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
  ])('comparator: %s in %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it('a space means AND', () => {
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.2.0 <2.0.0')).toBe(false);
    expect(satisfies('1.1.0', '>=1.2.0 <2.0.0')).toBe(false);
  });

  it('|| means OR, and binds looser than the space', () => {
    expect(satisfies('1.4.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('2.4.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false);
    expect(satisfies('1.0.0', '>=1.0.0 <1.1.0 || >=2.0.0')).toBe(true);
    expect(satisfies('1.5.0', '>=1.0.0 <1.1.0 || >=2.0.0')).toBe(false);
  });

  it('tolerates extra spaces around operators and groups', () => {
    expect(satisfies('1.5.0', '  >=1.2.0   <2.0.0  ')).toBe(true);
    expect(satisfies('2.5.0', '^1.0.0  ||   ^2.0.0')).toBe(true);
  });

  it('throws on a malformed version, naming it', () => {
    expect(() => satisfies('1.x', '^1.0.0')).toThrow('"1.x"');
  });
});

describe('parseRange rejects what it does not support, loudly', () => {
  it.each(['', '   ', '*', 'x', '1.x', '~1.2.3', '1.2.3 - 2.0.0', '>=1.0.0 ||', '|| ^1.0.0', '^', '>=', '>=1', '^1.0', '^1.0.0-beta', 'latest', '^1.0.0 &&  ^2'])(
    '%j',
    (range) => {
      expect(() => parseRange(range)).toThrow(SemverError);
      expect(() => parseRange(range)).toThrow(/range/i);
    },
  );

  it('a non-string range', () => {
    expect(() => parseRange(undefined as unknown as string)).toThrow(SemverError);
  });
});
