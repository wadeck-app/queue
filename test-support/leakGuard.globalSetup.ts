// vitest `globalSetup` of every package: gives the run a private temp dir and fails the run when tests leave `queue-*` entries in it (see tempLeakGuard.ts).
//
// Must be the LAST entry of `globalSetup` of a package: the ones before it (queue-cli builds the test bundle and takes a build lock that concurrent runs
// share) still see the real temp dir, and remove what they create themselves.
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { formatLeakMessage, startLeakGuard, sweepStaleRunRoots } from './tempLeakGuard.js';

export default function setup(): () => void {
  const realTmp = tmpdir();
  sweepStaleRunRoots(realTmp);
  const run = startLeakGuard(realTmp);
  return () => {
    const leaks = run.finish();
    if (leaks.length > 0) {
      // Vitest only prints an error thrown by a teardown ("error during close") and exits 0: the exit code is set here
      process.exitCode = 1;
      throw new Error(formatLeakMessage(run.root, leaks, basename(process.cwd())));
    }
  };
}
