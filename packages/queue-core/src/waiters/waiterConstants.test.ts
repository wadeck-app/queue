import { describe, it, expect } from 'vitest';
import { WAITER_HEARTBEAT_MS, WAITER_STALE_AFTER_MS, ANONYMOUS_WAITER_PREFIX, anonymousWaiterName, isAnonymousWaiterName } from './WaiterLiveness.js';

// The one definition of what a list calls stale and anonymous: `queue waiters` and the dashboard import it from here
describe('waiter display constants', () => {
  it('a heartbeat is stale after two periods', () => {
    expect(WAITER_STALE_AFTER_MS).toBe(2 * WAITER_HEARTBEAT_MS);
    expect(WAITER_STALE_AFTER_MS).toBe(30_000);
  });

  it('an unnamed wait is called anon.<pid> and recognised by the prefix', () => {
    expect(ANONYMOUS_WAITER_PREFIX).toBe('anon.');
    expect(anonymousWaiterName(4242)).toBe('anon.4242');
    expect(isAnonymousWaiterName('anon.4242')).toBe(true);
    expect(isAnonymousWaiterName('w-agent-wake.ab12cd34')).toBe(false);
    expect(isAnonymousWaiterName('xanon.1')).toBe(false);
  });
});
