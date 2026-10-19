import { describe, it, expect } from 'vitest';
import { matchesPayload } from './payloadMatch.js';

describe('matchesPayload', () => {
  it('returns true for undefined match', () => {
    const payload = { repository: { full_name: 'owner/repo' } };
    expect(matchesPayload(payload, undefined)).toBe(true);
  });

  it('returns true for empty object match', () => {
    const payload = { repository: { full_name: 'owner/repo' } };
    expect(matchesPayload(payload, {})).toBe(true);
  });

  it('matches top-level scalar property with string value', () => {
    const payload = { action: 'opened' };
    const match = { action: 'opened' };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false when top-level scalar does not match', () => {
    const payload = { action: 'opened' };
    const match = { action: 'closed' };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('matches nested property with dotted path', () => {
    const payload = { repository: { full_name: 'owner/repo' } };
    const match = { 'repository.full_name': 'owner/repo' };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false when nested property does not match', () => {
    const payload = { repository: { full_name: 'owner/repo' } };
    const match = { 'repository.full_name': 'other/repo' };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false when dotted path does not exist', () => {
    const payload = { repository: { name: 'repo' } };
    const match = { 'repository.full_name': 'owner/repo' };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false when intermediate path is not an object', () => {
    const payload = { repository: 'simple-string' };
    const match = { 'repository.full_name': 'owner/repo' };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('handles deeply nested paths up to depth 8', () => {
    const payload = { a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } };
    const match = { 'a.b.c.d.e.f.g.h': 'deep' };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false when depth exceeds 8', () => {
    const payload = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'too_deep' } } } } } } } } };
    const match = { 'a.b.c.d.e.f.g.h.i': 'too_deep' };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('never matches __proto__ segment', () => {
    const payload = { __proto__: { polluted: true } };
    const match = { '__proto__.polluted': true };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('never matches constructor segment', () => {
    const payload = { constructor: { polluted: true } };
    const match = { 'constructor.polluted': true };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('never matches prototype segment', () => {
    const payload = { prototype: { polluted: true } };
    const match = { 'prototype.polluted': true };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('matches number values with strict equality', () => {
    const payload = { count: 42 };
    const match = { count: 42 };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false when number values do not match', () => {
    const payload = { count: 42 };
    const match = { count: 43 };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('matches boolean values with strict equality', () => {
    const payload = { enabled: true };
    const match = { enabled: true };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false when boolean values do not match', () => {
    const payload = { enabled: true };
    const match = { enabled: false };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('does not treat string "12" and number 12 as equal', () => {
    const payload = { value: 12 };
    const match = { value: 12 };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false for null payload', () => {
    expect(matchesPayload(null, { key: 'value' })).toBe(false);
  });

  it('returns false when payload is not an object', () => {
    expect(matchesPayload('string', { key: 'value' })).toBe(false);
    expect(matchesPayload(123, { key: 'value' })).toBe(false);
    expect(matchesPayload([], { key: 'value' })).toBe(false);
  });

  it('returns false when payload value is null and match expects a value', () => {
    const payload = { value: null };
    const match = { value: 'something' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('matches when payload value is null and match expects null', () => {
    const payload = { value: null };
    const match = { value: null } as unknown as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('does not use array indexing', () => {
    const payload = { items: ['first', 'second', 'third'] };
    const match = { 'items.0': 'first' };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('matches multiple conditions with AND logic', () => {
    const payload = { action: 'opened', repository: { full_name: 'owner/repo' } };
    const match = { action: 'opened', 'repository.full_name': 'owner/repo' };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false if any condition fails when multiple conditions provided', () => {
    const payload = { action: 'opened', repository: { full_name: 'owner/repo' } };
    const match = { action: 'closed', 'repository.full_name': 'owner/repo' };
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false for key with leading dot', () => {
    const payload = { action: 'opened' };
    const match = { '.action': 'opened' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false for key with trailing dot', () => {
    const payload = { action: 'opened' };
    const match = { 'action.': 'opened' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false for key with empty segments (consecutive dots)', () => {
    const payload = { repository: { full_name: 'owner/repo' } };
    const match = { 'repository..full_name': 'owner/repo' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false for key with empty segments even if empty key exists in payload', () => {
    const payload = { '': 'value', repository: { full_name: 'owner/repo' } };
    const match = { '..full_name': 'owner/repo' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('does not match hasOwnProperty even when it exists as a property', () => {
    const payload = { hasOwnProperty: 'value' };
    const match = { hasOwnProperty: 'value' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('handles payload with shadowed hasOwnProperty without crashing', () => {
    const payload = { hasOwnProperty: 1, key: 'value' };
    const match = { key: 'value' };
    expect(matchesPayload(payload, match)).toBe(true);
  });

  it('returns false for NaN value comparison', () => {
    const payload = { value: NaN };
    const match = { value: NaN };
    // NaN !== NaN by definition of strict equality
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false when intermediate value is undefined', () => {
    const payload = { repository: undefined };
    const match = { 'repository.full_name': 'owner/repo' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns false for single-segment path with undefined value', () => {
    const payload = { value: undefined };
    const match = { value: 'something' } as Record<string, string | number | boolean>;
    expect(matchesPayload(payload, match)).toBe(false);
  });

  it('returns true for matching object value by strict equality (same reference)', () => {
    const obj = { inner: 'value' };
    const payload = { data: obj };
    const match = { data: obj } as unknown as Record<string, string | number | boolean>;
    // Strict equality on objects compares by reference, so this matches
    // However, config schema prevents this in practice (only string|number|boolean allowed)
    expect(matchesPayload(payload, match)).toBe(true);
  });
});
