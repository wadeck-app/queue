import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
    // Refuses a test that reaches the real orch (see vitest.setup.ts)
    setupFiles: ['./src/backend/vitest.setup.ts'],
    // Timeouts are guards against a test that HANGS, never a performance limit: no test may fail because the machine is slow.
    // Normal runs end long before these.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
