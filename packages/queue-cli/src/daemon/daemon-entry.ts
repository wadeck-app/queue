import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLogger, getErrorMessage, getQueueConfigDir } from '@wadeck-app/queue-core';
import { startDaemon } from './QueueDaemon.js';

// Defined by the bundler (ci/scripts/bundle.ts); a run from the TypeScript build says so instead of pretending to be a release
declare const __QUEUE_CLI_VERSION__: string;
const version = typeof __QUEUE_CLI_VERSION__ !== 'undefined' ? __QUEUE_CLI_VERSION__ : 'unbundled-dev';

const configDir = getQueueConfigDir();

// Bundle layout: app-module/manifest.json sits next to queue-daemon.cjs (see ci/scripts/bundle.ts).
// TSC dev layout: the PACKAGED manifest of the sibling packages/app-module-queue/dist-module (run `npm run bundle`
// there first), three levels up from packages/queue-cli/dist/daemon/daemon-entry.js. The source manifest.json of the
// module is not registrable: app-core refuses it (no version, no backendEntryPath).
const bundleManifest = fileURLToPath(new URL('./app-module/manifest.json', import.meta.url));
const devManifest = fileURLToPath(new URL('../../../app-module-queue/dist-module/manifest.json', import.meta.url));
const manifestPath = existsSync(bundleManifest) ? bundleManifest : devManifest;

startDaemon(configDir, { appCoreModule: { manifestPath }, version }).catch((err: unknown) => {
  const message = `Failed to start: ${getErrorMessage(err)}`;
  // The daemon is spawned with stdio:'ignore', so stderr alone would lose the startup failure
  try {
    new EventLogger(join(configDir, 'logs')).logDiagnostic({ source: 'daemon-entry', message });
  } catch (logErr: unknown) {
    process.stderr.write(`[queue-daemon] Could not write startup failure to ${configDir}/logs: ${getErrorMessage(logErr)}\n`);
  }
  process.stderr.write(`[queue-daemon] ${message}\n`);
  process.exit(1);
});
