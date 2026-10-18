import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventLogger, getErrorMessage, getQueueConfigDir } from '@wadeck-app/queue-core';
import { startDaemon } from './QueueDaemon.js';

const configDir = getQueueConfigDir();

// Bundle layout: app-module/manifest.json sits next to queue-daemon.cjs (see ci/scripts/bundle.ts).
// TSC dev layout: sibling packages/app-module-queue/manifest.json, three levels up from
// packages/queue-cli/dist/daemon/daemon-entry.js.
const bundleManifest = fileURLToPath(new URL('./app-module/manifest.json', import.meta.url));
const devManifest = fileURLToPath(new URL('../../../app-module-queue/manifest.json', import.meta.url));
const manifestPath = existsSync(bundleManifest) ? bundleManifest : devManifest;

startDaemon(configDir, { appCoreModule: { manifestPath } }).catch((err: unknown) => {
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
