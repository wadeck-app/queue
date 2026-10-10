import { describe, it, expect } from 'vitest';
import { PayloadFilter } from './PayloadFilter.js';
import type { EventEnvelope } from '../types.js';

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'test-id',
    timestamp: '2026-01-01T00:00:00.000Z',
    event: 'test.event',
    payload: { exitCode: 0 },
    meta: { cwd: '/tmp/project', projectName: 'agent-fleet' },
    ...overrides,
  };
}

describe('PayloadFilter', () => {
  it('dot-notation string match', () => {
    const envelope = makeEnvelope();
    expect(PayloadFilter.matches('meta.projectName=agent-fleet', envelope)).toBe(true);
  });

  it('dot-notation string miss', () => {
    const envelope = makeEnvelope();
    expect(PayloadFilter.matches('meta.projectName=other-project', envelope)).toBe(false);
  });

  it('dot-notation numeric match', () => {
    const envelope = makeEnvelope({ payload: { exitCode: 1 } });
    expect(PayloadFilter.matches('payload.exitCode=1', envelope)).toBe(true);
  });

  it('dot-notation numeric miss', () => {
    const envelope = makeEnvelope({ payload: { exitCode: 0 } });
    expect(PayloadFilter.matches('payload.exitCode=1', envelope)).toBe(false);
  });

  it('JSONPath match', () => {
    const envelope = makeEnvelope();
    expect(PayloadFilter.matches('$.meta.projectName', envelope)).toBe(true);
  });

  it('JSONPath miss on empty result', () => {
    const envelope = makeEnvelope();
    expect(PayloadFilter.matches('$.meta.nonExistentField', envelope)).toBe(false);
  });
});

describe('PayloadFilter.evaluate', () => {
  it('match carries no reason', () => {
    expect(PayloadFilter.evaluate('meta.projectName=agent-fleet', makeEnvelope())).toEqual({ matched: true });
  });

  it('value mismatch reports path, expected and actual', () => {
    const result = PayloadFilter.evaluate('meta.projectName=other-project', makeEnvelope());
    expect(result).toEqual({
      matched: false,
      reason: 'value mismatch',
      path: 'meta.projectName',
      expected: 'other-project',
      actual: 'agent-fleet',
    });
  });

  it('numeric mismatch reports the actual number', () => {
    const result = PayloadFilter.evaluate('payload.exitCode=1', makeEnvelope({ payload: { exitCode: 0 } }));
    expect(result).toMatchObject({ matched: false, reason: 'value mismatch', expected: '1', actual: '0' });
  });

  it('unknown path reports the path that was looked up and no actual value', () => {
    const result = PayloadFilter.evaluate('payload.typoField=1', makeEnvelope());
    expect(result).toEqual({
      matched: false,
      reason: 'path not found in envelope',
      path: 'payload.typoField',
      expected: '1',
    });
  });

  it("filter without '=' explains the expected syntax", () => {
    const result = PayloadFilter.evaluate('payload.exitCode', makeEnvelope());
    expect(result.matched).toBe(false);
    expect(result.reason).toContain("no '=' found");
    expect(result.reason).toContain('payload.exitCode=1');
  });

  it('JSONPath matching nothing reports the expression', () => {
    const result = PayloadFilter.evaluate('$.meta.nonExistentField', makeEnvelope());
    expect(result).toMatchObject({
      matched: false,
      reason: 'JSONPath matched nothing',
      path: '$.meta.nonExistentField',
    });
  });

  it('JSONPath matching a falsy value is reported as a miss with the value', () => {
    const result = PayloadFilter.evaluate('$.payload.exitCode', makeEnvelope({ payload: { exitCode: 0 } }));
    expect(result).toMatchObject({
      matched: false,
      reason: 'JSONPath matched a falsy value',
      actual: '0',
    });
  });
});
