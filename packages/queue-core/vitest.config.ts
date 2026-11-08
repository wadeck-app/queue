import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    // The tests of the leak guard every package uses (test-support/) run with this package: the CI job of queue-core runs on the three platforms
    include: ['src/**/*.test.ts', '../../test-support/**/*.test.ts'],
    // Replaces the real orch lookup by a guard that fails a test reaching it (see the file)
    setupFiles: ['./vitest.setup.ts'],
    // Timeouts are guards against a test that HANGS, never a performance limit: no test may fail because the machine is slow.
    // Normal runs end long before these.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Gives the run a private temp dir and fails it when a test leaves a queue-* entry in it (test-support/tempLeakGuard.ts)
    globalSetup: ['../../test-support/leakGuard.globalSetup.ts'],
  },
});
