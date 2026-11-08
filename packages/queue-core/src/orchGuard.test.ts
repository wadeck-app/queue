import { describe, it, expect } from 'vitest';
import { RetryScheduler } from './dispatch/RetryScheduler.js';
import { takeOrchGuardCalls } from './orchGuard.js';
import { walEntry } from './queueEntries.testUtil.js';

// The vitest setup (vitest.setup.ts) arms the guard before each test and fails the test that leaves a record: these tests take the record themselves, which is
// what proves a real `orch add` is detected and never executed.
describe('the guard against the real orchestrator', () => {
  it('records the lookup of orch and does not find it: the scheduler throws its "orch not found" error and nothing was run', () => {
    expect(() => RetryScheduler.scheduleRetry(walEntry('w1', { attempts: 1 }), true)).toThrow(/orch not found/);
    expect(takeOrchGuardCalls()).toEqual(['findOrch']);
  });

  it('records an orch add that gets as far as running orch, and refuses to run it', () => {
    const { deps } = RetryScheduler;
    const guarded = deps.runSync;
    expect(() => guarded('orch', ['add', '--once', 'x'])).toThrow(/test guard: a test tried to run orch for real/);
    expect(() => deps.runAsync('orch', ['add'], () => undefined)).toThrow(/test guard/);
    expect(takeOrchGuardCalls()).toEqual(['runSync orch add --once x', 'runAsync orch add']);
  });

  it('the record is cleared by taking it', () => {
    RetryScheduler.deps.findOrch();
    expect(takeOrchGuardCalls()).toEqual(['findOrch']);
    expect(takeOrchGuardCalls()).toEqual([]);
  });
});
