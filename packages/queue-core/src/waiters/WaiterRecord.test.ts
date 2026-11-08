import { describe, it, expect } from 'vitest';
import { parseWaiterRecord, validateWaiterInput, WAITER_LIMITS, WAITER_RECORD_VERSION, type WaiterRecord } from './WaiterRecord.js';

function record(overrides: Partial<WaiterRecord> = {}): WaiterRecord {
  return {
    v: WAITER_RECORD_VERSION,
    id: 'f3a9c2d4e5b6478890abcdef12345678',
    name: 'w-agent-wake.ab12cd34',
    events: ['onTaskDone'],
    whens: ['payload.taskId=abc'],
    label: 'task abc',
    contact: { kind: 'none' },
    pid: 4242,
    cwd: '/project',
    since: '2026-11-08T10:00:00.000Z',
    startedAt: '2026-11-08T10:00:05.000Z',
    ...overrides,
  };
}
const file = 'waiter-w-agent-wake.ab12cd34.json';

describe('parseWaiterRecord', () => {
  it('reads a valid record back', () => {
    const parsed = parseWaiterRecord(JSON.stringify(record()), file);
    expect(parsed).toEqual({ ok: true, record: record() });
  });

  it('ignores a field it does not know (a later release may add one)', () => {
    const parsed = parseWaiterRecord(JSON.stringify({ ...record(), future: 1 }), file);
    expect(parsed.ok).toBe(true);
  });

  it('refuses text that is not JSON, naming the file', () => {
    const parsed = parseWaiterRecord('{"v":1,', file);
    expect(parsed).toMatchObject({ ok: false, kind: 'malformed' });
    expect(!parsed.ok && parsed.problem).toContain(file);
  });

  it.each([['null', 'null'], ['a number', '3'], ['an array', '[]']])('refuses %s', (_label, text) => {
    expect(parseWaiterRecord(text, file)).toMatchObject({ ok: false, kind: 'malformed' });
  });

  it('an unknown version is its own kind (the reader says it once, a newer queue wrote it)', () => {
    const parsed = parseWaiterRecord(JSON.stringify({ ...record(), v: 2 }), file);
    expect(parsed).toMatchObject({ ok: false, kind: 'unknown-version' });
    expect(!parsed.ok && parsed.problem).toContain('queue');
  });

  it('refuses a record whose name is not the one in the file name', () => {
    const parsed = parseWaiterRecord(JSON.stringify(record({ name: 'other.name' })), file);
    expect(parsed).toMatchObject({ ok: false, kind: 'malformed' });
    expect(!parsed.ok && parsed.problem).toContain('other.name');
  });

  it.each([
    ['id', { id: '' }],
    ['id type', { id: 5 }],
    ['events not a list', { events: 'onX' }],
    ['no event', { events: [] }],
    ['event not a string', { events: [3] }],
    ['whens not a list', { whens: 'a=b' }],
    ['a when not a string', { whens: [1] }],
    ['label type', { label: 3 }],
    ['contact missing', { contact: undefined }],
    ['contact kind', { contact: { kind: 'http' } }],
    ['pid zero', { pid: 0 }],
    ['pid fraction', { pid: 1.5 }],
    ['pid string', { pid: '12' }],
    ['cwd type', { cwd: 1 }],
    ['since not a date', { since: 'yesterday' }],
    ['startedAt not a date', { startedAt: 'x' }],
    ['too many events', { events: Array.from({ length: WAITER_LIMITS.maxEvents + 1 }, (_, i) => `onE${i}`) }],
    ['too many whens', { whens: Array.from({ length: WAITER_LIMITS.maxWhens + 1 }, (_, i) => `a=${i}`) }],
    ['a long when', { whens: ['a=' + 'x'.repeat(WAITER_LIMITS.maxTextChars)] }],
    ['a long label', { label: 'x'.repeat(WAITER_LIMITS.maxLabelChars + 1) }],
  ])('refuses a record with a bad %s', (_label, patch) => {
    const parsed = parseWaiterRecord(JSON.stringify({ ...record(), ...patch }), file);
    expect(parsed).toMatchObject({ ok: false, kind: 'malformed' });
  });

  it('refuses text over the size limit without parsing it', () => {
    const parsed = parseWaiterRecord(' '.repeat(WAITER_LIMITS.maxFileBytes + 1), file);
    expect(parsed).toMatchObject({ ok: false, kind: 'oversize' });
  });

  it('accepts a pipe contact, which a later step writes', () => {
    expect(parseWaiterRecord(JSON.stringify(record({ contact: { kind: 'pipe' } })), file).ok).toBe(true);
  });
});

describe('validateWaiterInput', () => {
  const input = { name: 'a.b', events: ['onX'], whens: [] as string[], label: '', since: '2026-11-08T10:00:00.000Z', cwd: '/p' };

  it('accepts a normal input', () => {
    expect(validateWaiterInput(input)).toBeUndefined();
  });

  it('names the problem of a bad name', () => {
    expect(validateWaiterInput({ ...input, name: 'bad' })).toContain('<who>.<what>');
  });

  it('refuses no event, an invalid pattern, too many events', () => {
    expect(validateWaiterInput({ ...input, events: [] })).toContain('at least one event');
    expect(validateWaiterInput({ ...input, events: ['a..b'] })).toContain('empty segment');
    expect(validateWaiterInput({ ...input, events: Array.from({ length: 21 }, (_, i) => `onE${i}`) })).toContain('20');
  });

  it('refuses a filter or label over the limits, with the limit', () => {
    expect(validateWaiterInput({ ...input, whens: ['a=' + 'x'.repeat(500)] })).toContain('500');
    expect(validateWaiterInput({ ...input, label: 'x'.repeat(201) })).toContain('200');
  });
});
