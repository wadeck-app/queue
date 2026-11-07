import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
    // Builds the bundled CLI once per run into a directory of its own (the integration tests used to rebuild the shared dist-bundle/ each,
    // which cannot run in parallel) and gives the run its own app-core pickup directory.
    globalSetup: ['./vitest.globalSetup.ts'],
    // Test files run in parallel. What made that unsafe was shared global state, all of it now per run or per test:
    //  - ports: the daemons ask for QUEUE_DAEMON_PORT / QUEUE_RELAY_PORT, which createIsolatedCliEnv sets to free ports allocated per environment
    //    (no test uses 47910/47911, so a real daemon or another session's run on this machine cannot collide);
    //  - the bundle: built once per run by vitest.globalSetup.ts (QUEUE_TEST_BUNDLE_DIR), builds of concurrent runs are serialised by a lock;
    //  - config/home/npm/app-core directories: one throwaway tree per environment (createIsolatedCliEnv).
    // Do not add a test that binds a fixed port, writes to a fixed temp file name or to the real ~/.config: use createIsolatedCliEnv / mkdtemp.
    fileParallelism: true,
    // Timeouts are guards against a test that HANGS, never a performance limit: no test may fail because the machine is slow
    // (starting git or node processes takes seconds on a loaded Windows machine). Normal runs end long before these.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // Daemons started by the integration tests re-register the "queue" module with app-core on every start. Without this they would reach a
    // REAL app-core on the developer's machine (port 4850). Port 1 is never listening, so registration falls back to a pickup file, whose
    // directory is APP_CORE_CONFIG_DIR: a throwaway one per run (vitest.globalSetup.ts) or per environment (createIsolatedCliEnv).
    env: {
      APP_CORE_PORT: '1',
    },
  },
});
