import { describe, it, expect } from 'vitest';
import { RetryScheduler, takeOrchGuardCalls } from '@wadeck-app/queue-core';

// vitest.setup.ts arms the guard before each test and fails the test that leaves a record: this test takes the record itself, which proves the setup file is
// loaded for this package (otherwise the real lookup would run, and on a machine without orch nothing would be recorded either way, so the record is what is asserted).
describe('the guard against the real orchestrator is armed in this package', () => {
  it('an attempt to find or run orch is recorded and never executed', () => {
    expect(RetryScheduler.deps.findOrch()).toBeNull();
    expect(() => RetryScheduler.deps.runSync('orch', ['add', '--once', 'x'])).toThrow(/test guard: a test tried to run orch for real/);
    expect(takeOrchGuardCalls()).toEqual(['findOrch', 'runSync orch add --once x']);
  });
});
