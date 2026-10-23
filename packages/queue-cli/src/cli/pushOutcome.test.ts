import { describe, it, expect } from 'vitest';
import { pushFailure } from './pushOutcome.js';

describe('pushFailure (the stderr line when a push did not go through, or null when it did)', () => {
  it.each(['queued', 'dispatched'] as const)('is null for %s', (status) => {
    expect(pushFailure({ status }, 'Event')).toBeNull();
  });

  it('keeps the existing wording for an aborted event and an aborted replay', () => {
    expect(pushFailure({ status: 'aborted', reason: 'hook rejected' }, 'Event')).toBe('[queue] Event aborted: hook rejected');
    expect(pushFailure({ status: 'aborted' }, 'Replay')).toBe('[queue] Replay aborted: unknown reason');
  });

  it('says a rejected push was not recorded, why, which clients the daemon accepts, and what to update', () => {
    const line = pushFailure({ status: 'rejected', reason: 'push protocol 2.0.0 is not accepted by this daemon (it accepts ^1.0.0): update the client', supported: '^1.0.0' }, 'Event');
    expect(line).toContain('[queue] Event rejected (nothing was recorded)');
    expect(line).toContain('push protocol 2.0.0 is not accepted');
    expect(line).toContain('^1.0.0');
    expect(line).toMatch(/update queue-cli/i);
  });

  it('still explains a rejected push whose daemon gave no reason', () => {
    expect(pushFailure({ status: 'rejected' }, 'Replay')).toContain('[queue] Replay rejected (nothing was recorded): unknown reason');
  });
});
