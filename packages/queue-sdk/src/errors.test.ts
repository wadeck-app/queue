import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './errors.js';

describe('getErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(getErrorMessage(new TypeError('boom'))).toBe('boom');
  });

  it('stringifies anything else', () => {
    expect(getErrorMessage('text')).toBe('text');
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});
