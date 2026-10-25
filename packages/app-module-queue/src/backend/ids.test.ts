import { describe, it, expect } from 'vitest';
import { shortId } from './ids.js';

describe('shortId', () => {
  it('keeps the first 8 characters of a uuid', () => {
    expect(shortId('0945157b-49f9-4f01-840e-9ae1f0c9224a')).toBe('0945157b');
  });

  it('leaves a shorter id as it is', () => {
    expect(shortId('f1')).toBe('f1');
  });
});
