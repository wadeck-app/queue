// Runs before every test file (vitest.config.ts setupFiles). Not part of src/, so never compiled or published.
//
// This package's tests can start a queue daemon in the test process, whose RetryScheduler would find and run the real `orch` of whoever runs the tests (a developer
// machine has it on its PATH) and schedule a REAL job. The guard (queue-core, src/orchGuard.ts) replaces the scheduler's dependencies: nothing is looked up or
// executed, and a test that reaches the scheduler without injecting its own deps or spying on scheduleRetry FAILS, naming itself.
import { afterEach, beforeEach, expect } from 'vitest';
import { armOrchGuard, takeOrchGuardCalls, ORCH_GUARD_HINT } from '@wadeck-app/queue-core';

beforeEach(() => {
  armOrchGuard();
});

afterEach(() => {
  expect(takeOrchGuardCalls(), ORCH_GUARD_HINT).toEqual([]);
});
