import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ANONYMOUS_WAITER_PREFIX, WAITER_STALE_AFTER_MS, type LiveWaiter } from '@wadeck-app/queue-core';
import { anonymousWaitName, isAnonymousWaitName } from './waitSession.js';
import { liveWaiterView } from './waitersView.js';

// The stale limit and the anonymous prefix are defined once, in queue-core (the dashboard module imports them from there too). These tests fail when a copy comes back.
const sourceOf = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

function waiter(lastSeenMs: number): LiveWaiter {
  return { v: 1, id: 'i', name: 'a.b', events: ['x'], whens: [], label: '', contact: { kind: 'none' }, pid: 1, cwd: '/', since: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:00.000Z', lastSeenMs };
}

describe('constants shared with queue-core', () => {
  it('a wait is stale exactly after the queue-core limit', () => {
    const now = 1_000_000;
    expect(liveWaiterView(waiter(now - WAITER_STALE_AFTER_MS), now).stale).toBe(false);
    expect(liveWaiterView(waiter(now - WAITER_STALE_AFTER_MS - 1), now).stale).toBe(true);
  });

  it('an unnamed wait gets the queue-core prefix', () => {
    expect(anonymousWaitName(undefined, 7)).toBe(`${ANONYMOUS_WAITER_PREFIX}7`);
    expect(isAnonymousWaitName(`${ANONYMOUS_WAITER_PREFIX}7`)).toBe(true);
    expect(isAnonymousWaitName('a.b')).toBe(false);
  });

  it.each(['waitSession.ts', 'waitersView.ts', 'waitersCli.ts', 'waitCli.ts'])('%s defines neither the stale limit nor the anonymous prefix itself', (file) => {
    const code = sourceOf(file).split('\n').filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*'));
    const text = code.join('\n');
    expect(text).not.toMatch(/['"`]anon\./);
    expect(text).not.toMatch(/\*\s*WAITER_HEARTBEAT_MS/);
    expect(text).not.toMatch(/(const|let)\s+(STALE_AFTER_MS|ANONYMOUS_PREFIX)\b/);
  });
});
