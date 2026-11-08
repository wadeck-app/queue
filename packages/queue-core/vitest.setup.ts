// Runs before every test file (vitest.config.ts setupFiles). Not part of src/, so never compiled into dist or published.
//
// RetryScheduler.deps normally finds and runs the real `orch`, which would schedule a REAL job in the orchestrator of whoever runs the tests (a developer
// machine has orch on its PATH). Here it is replaced by a guard: nothing is ever looked up or executed, and a test that reaches the scheduler without having
// injected its own deps or spied on scheduleRetry FAILS, naming itself, instead of silently depending on the machine.
import { afterEach, beforeEach, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RetryScheduler, type SchedulerDeps } from './src/dispatch/RetryScheduler.js';

let reached: string[] = [];

const guardDeps: SchedulerDeps = {
  findOrch: () => {
    reached.push('findOrch');
    return null;
  },
  runSync: (file, args) => {
    reached.push(`runSync ${file} ${args.join(' ')}`);
    throw new Error('test guard: a test tried to run orch for real');
  },
  runAsync: (file, args) => {
    reached.push(`runAsync ${file} ${args.join(' ')}`);
    throw new Error('test guard: a test tried to run orch for real');
  },
  randomSuffix: () => randomUUID().slice(0, 8),
};

beforeEach(() => {
  reached = [];
  RetryScheduler.deps = guardDeps;
});

afterEach(() => {
  const calls = reached;
  reached = [];
  RetryScheduler.deps = guardDeps;
  expect(calls, 'this test reached the real RetryScheduler (orch lookup or call). Fix: vi.spyOn(RetryScheduler, "scheduleRetry") or assign RetryScheduler.deps = fakeDeps in the test').toEqual([]);
});
