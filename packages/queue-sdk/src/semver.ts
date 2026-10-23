import { getErrorMessage } from './errors.js';
// Minimal SemVer for protocol versions. Supported: MAJOR.MINOR.PATCH (no prerelease, no build metadata) and ranges made of
// comparators (>=, >, <=, <, =, or a bare version), caret (^), a space for AND and "||" for OR. Anything else is a loud
// SemverError that quotes the offending text: a range that is silently misread would accept or reject the wrong clients.

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

type Operator = '>=' | '>' | '<=' | '<' | '=';

interface Comparator {
  operator: Operator;
  version: Version;
}

/** OR of ANDs: the version must satisfy every comparator of at least one inner list. */
export type Range = Comparator[][];

export class SemverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemverError';
  }
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMPARATOR = /^(>=|<=|>|<|=|\^)?(.*)$/;

export function parseVersion(text: string): Version {
  if (typeof text !== 'string') {
    throw new SemverError(`Invalid version ${JSON.stringify(text)}: expected a string MAJOR.MINOR.PATCH`);
  }
  const match = VERSION.exec(text);
  if (!match) {
    throw new SemverError(`Invalid version ${JSON.stringify(text)}: expected MAJOR.MINOR.PATCH with digits only (no prerelease, no build metadata, no padding)`);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new SemverError(`Invalid version ${JSON.stringify(text)}: a number is too large`);
  }
  return { major, minor, patch };
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1;
    }
  }
  return 0;
}

// ^1.2.3 := >=1.2.3 <2.0.0, ^0.2.3 := >=0.2.3 <0.3.0, ^0.0.3 := >=0.0.3 <0.0.4
function caret(version: Version): Comparator[] {
  const upper: Version =
    version.major > 0
      ? { major: version.major + 1, minor: 0, patch: 0 }
      : version.minor > 0
        ? { major: 0, minor: version.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: version.patch + 1 };
  return [
    { operator: '>=', version },
    { operator: '<', version: upper },
  ];
}

function parseComparator(token: string, range: string): Comparator[] {
  const [, operator = '', versionText = ''] = COMPARATOR.exec(token) ?? [];
  let version: Version;
  try {
    version = parseVersion(versionText);
  } catch (error) {
    const reason = getErrorMessage(error);
    throw new SemverError(`Invalid range ${JSON.stringify(range)}: token ${JSON.stringify(token)} is not supported (${reason})`);
  }
  if (operator === '^') {
    return caret(version);
  }
  return [{ operator: (operator || '=') as Operator, version }];
}

export function parseRange(range: string): Range {
  if (typeof range !== 'string') {
    throw new SemverError(`Invalid range ${JSON.stringify(range)}: expected a string`);
  }
  if (range.trim() === '') {
    throw new SemverError(`Invalid range ${JSON.stringify(range)}: empty`);
  }
  return range.split('||').map((alternative) => {
    const tokens = alternative.trim().split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0) {
      throw new SemverError(`Invalid range ${JSON.stringify(range)}: an alternative around "||" is empty`);
    }
    return tokens.flatMap((token) => parseComparator(token, range));
  });
}

function holds({ operator, version }: Comparator, candidate: Version): boolean {
  const order = compareVersions(candidate, version);
  switch (operator) {
    case '>=':
      return order >= 0;
    case '>':
      return order > 0;
    case '<=':
      return order <= 0;
    case '<':
      return order < 0;
    case '=':
      return order === 0;
  }
}

export function satisfies(version: string, range: string): boolean {
  const candidate = parseVersion(version);
  return parseRange(range).some((alternative) => alternative.every((comparator) => holds(comparator, candidate)));
}
