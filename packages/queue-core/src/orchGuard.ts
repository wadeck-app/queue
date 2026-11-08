import { randomUUID } from 'node:crypto';
import { RetryScheduler, type SchedulerDeps } from './dispatch/RetryScheduler.js';

/**
 * Test guard against the real orchestrator. `RetryScheduler.deps` normally finds and runs the real `orch`, which would schedule a REAL job in the orchestrator of
 * whoever runs the tests (a developer machine has orch on its PATH). While armed, nothing is looked up or executed, and every attempt is recorded so that
 * the vitest setup of each package can FAIL the test that reached the scheduler without having injected its own deps or spied on scheduleRetry.
 * Used by the vitest.setup.ts of every package that can start a daemon in the test process; never by production code.
 */
export const ORCH_GUARD_HINT = 'this test reached the real RetryScheduler (orch lookup or call). Fix: vi.spyOn(RetryScheduler, "scheduleRetry") or assign RetryScheduler.deps = fakeDeps in the test';

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

/** Installs the guard and forgets what was recorded: call before each test. */
export function armOrchGuard(): void {
  reached = [];
  RetryScheduler.deps = guardDeps;
}

/** What the test reached since the guard was armed (empty when it stayed away from the scheduler); re-installs the guard and clears the record. */
export function takeOrchGuardCalls(): string[] {
  const calls = reached;
  armOrchGuard();
  return calls;
}
