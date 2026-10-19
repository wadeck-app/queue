import { describe, it, expect } from 'vitest';
import { isRecord } from './isRecord.js';

describe('isRecord', () => {
  it('accepts objects, including empty ones and class instances', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(new Error('x'))).toBe(true);
  });

  it('rejects null, arrays and primitives', () => {
    for (const value of [null, undefined, [], [1], 'text', 0, true, () => 1]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});
