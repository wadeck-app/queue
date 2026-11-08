import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ANONYMOUS_WAITER_PREFIX, WAITER_STALE_AFTER_MS } from '@wadeck-app/queue-core';
import { getWaiters, isAnonymous } from './waiters.js';
import { registerFixtureWait } from './waitersFixture.testUtil.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The stale limit and the anonymous prefix are defined once, in queue-core (`queue waiters` imports them from there too). These tests fail when a copy comes back.
const sourceOf = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

describe('constants shared with queue-core', () => {
  it('the page flags a heartbeat stale exactly at the queue-core limit', () => {
    const configDir = makeTempDir('queue-waiter-const-');
    try {
      const NOW = Date.now();
      registerFixtureWait(configDir, { name: 'edge.ok', at: NOW - WAITER_STALE_AFTER_MS });
      registerFixtureWait(configDir, { name: 'edge.late', at: NOW - WAITER_STALE_AFTER_MS - 1 });
      const byName = new Map(getWaiters(configDir, { now: () => NOW, isAlive: () => true }).waiters.map((w) => [w.name, w.stale]));
      expect(byName.get('edge.ok')).toBe(false);
      expect(byName.get('edge.late')).toBe(true);
    } finally {
      removeTempDir(configDir);
    }
  });

  it('an anonymous wait is recognised by the queue-core prefix', () => {
    expect(isAnonymous(`${ANONYMOUS_WAITER_PREFIX}7`)).toBe(true);
    expect(isAnonymous('a.b')).toBe(false);
  });

  it.each(['waiters.ts', 'waiterHistory.ts', 'waitersQuery.ts'])('%s defines neither the stale limit nor the anonymous prefix itself', (file) => {
    const text = sourceOf(file).split('\n').filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*')).join('\n');
    expect(text).not.toMatch(/['"`]anon\./);
    expect(text).not.toMatch(/\*\s*WAITER_HEARTBEAT_MS/);
    expect(text).not.toMatch(/(const|let)\s+(STALE_AFTER_MS|ANONYMOUS_PREFIX)\s*=/);
  });
});
