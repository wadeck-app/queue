import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
    // Daemons started by the integration tests re-register the "queue" module with app-core on every
    // start. Without this they would reach a REAL app-core on the developer's machine (port 4850) or
    // write its ~/.config/app-core/modules/queue.json pointing at a test bundle. Port 1 is never
    // listening, so registration falls back to a pickup file inside a throwaway directory.
    env: {
      APP_CORE_PORT: '1',
      APP_CORE_CONFIG_DIR: join(tmpdir(), 'queue-cli-tests-app-core'),
    },
  },
});
