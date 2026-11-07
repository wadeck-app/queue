// Where the integration tests find the bundled CLI (queue.cjs, queue-daemon.cjs, queue-relay-daemon.cjs, queue-updater.cjs, app-module/).
// vitest.globalSetup.ts builds it ONCE per vitest run into a directory of its own and exports the path in this variable; the test files
// no longer rebuild dist-bundle/ (parallel files, or two runs on the same checkout, would overwrite each other's files while a daemon loads them).
import { join } from 'node:path';

export const TEST_BUNDLE_DIR_ENV = 'QUEUE_TEST_BUNDLE_DIR';

/** Directory of the bundle built for this test run. Throws when the run did not go through vitest.globalSetup.ts. */
export function testBundleDir(): string {
  const dir = process.env[TEST_BUNDLE_DIR_ENV];
  if (dir === undefined || dir === '') {
    throw new Error(
      `${TEST_BUNDLE_DIR_ENV} is not set: the test bundle is built by vitest.globalSetup.ts. ` +
      'Fix: run the tests through vitest from packages/queue-cli (npx vitest run), which loads vitest.config.ts and its globalSetup.',
    );
  }
  return dir;
}

/** Absolute path of a file of the test bundle, e.g. testBundleFile('queue.cjs'). */
export function testBundleFile(name: string): string {
  return join(testBundleDir(), name);
}
