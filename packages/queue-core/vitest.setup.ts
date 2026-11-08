// Runs before every test file (vitest.config.ts setupFiles). Not part of src/, so never compiled into dist or published.
//
// RetryScheduler.deps normally finds and runs the real `orch`, which would schedule a REAL job in the orchestrator of whoever runs the tests (a developer
// machine has orch on its PATH). Here it is replaced by a guard (src/orchGuard.ts): nothing is ever looked up or executed, and a test that reaches the scheduler
// without having injected its own deps or spied on scheduleRetry FAILS, naming itself, instead of silently depending on the machine.
import { afterEach, beforeEach, expect } from 'vitest';
import { armOrchGuard, takeOrchGuardCalls, ORCH_GUARD_HINT } from './src/orchGuard.js';

beforeEach(() => {
  armOrchGuard();
});

afterEach(() => {
  expect(takeOrchGuardCalls(), ORCH_GUARD_HINT).toEqual([]);
});
