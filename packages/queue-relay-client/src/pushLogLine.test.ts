import { describe, it, expect } from 'vitest';
import { pushLogLine } from './pushLogLine.js';

const args = { event: 'on.github.push', deliveryId: 'del-1', configDir: '/cfg' };

describe('pushLogLine (the relay log line for the answer of the queue daemon)', () => {
  it.each(['queued', 'dispatched'] as const)('keeps the success line for %s', (status) => {
    expect(pushLogLine({ ...args, result: { status } })).toBe(`[relay] Pushed "on.github.push" (delivery del-1) -> ${status}.`);
  });

  it('says an aborted push was not delivered, why, and where to look', () => {
    const line = pushLogLine({ ...args, result: { status: 'aborted', reason: 'subscribers.yml syntax error' } });
    expect(line).toContain('ABORTED by the queue daemon: subscribers.yml syntax error');
    expect(line).toContain('del-1');
    expect(line).toContain('/cfg/logs');
    expect(line).not.toContain('Pushed');
  });

  it('gives a placeholder when an aborted push has no reason', () => {
    expect(pushLogLine({ ...args, result: { status: 'aborted' } })).toContain('no reason given');
  });

  it('says a rejected push (protocol not accepted) was not recorded, why, and to update the relay', () => {
    const line = pushLogLine({ ...args, result: { status: 'rejected', reason: 'push protocol 2.0.0 is not accepted', supported: '^1.0.0' } });
    expect(line).toContain('REJECTED by the queue daemon');
    expect(line).toContain('push protocol 2.0.0 is not accepted');
    expect(line).toContain('^1.0.0');
    expect(line).toContain('del-1');
    expect(line).toMatch(/update/i);
    expect(line).not.toContain('Pushed');
  });
});
