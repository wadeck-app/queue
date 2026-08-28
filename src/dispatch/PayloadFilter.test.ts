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
