import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
    // Replaces the real orch lookup by a guard that fails a test reaching it (see the file)
    setupFiles: ['./vitest.setup.ts'],
    // Timeouts are guards against a test that HANGS, never a performance limit: no test may fail because the machine is slow.
    // Normal runs end long before these.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
