import { createDaemon } from '@wadeck-app/singleton-daemon-kit';
import type { ShutdownReason } from '@wadeck-app/singleton-daemon-kit';
import { defaultRegistryDir } from '@wadeck-app/project-sdk';
import { createQueueService, getErrorMessage, getQueueProtocolInfo } from '@wadeck-app/queue-core';
import { registerWithAppCore } from './AppCoreRegistration.js';

export const DAEMON_PORT = 47910;
export const IDLE_TIMEOUT_MS = 60_000;
const IDLE_CHECK_INTERVAL_MS = 10_000;

export interface AppCoreModuleOptions { manifestPath: string; }

/**
 * Hosts the queue as the singleton background daemon: owns the port, the idle shutdown and the
 * app-core registration; the queue logic itself is queue-core's createQueueService.
 */
export async function startDaemon(configDir: string, options?: { appCoreModule?: AppCoreModuleOptions; port?: number; version?: string }): Promise<void> {
  let idleCountdown: ReturnType<typeof setTimeout> | null = null;
  let daemonHandle: Awaited<ReturnType<typeof createDaemon>> | null = null;

  const service = createQueueService(configDir, { onActivity: resetIdleCountdown, registryDir: defaultRegistryDir(process.env) });

  function resetIdleCountdown(): void {
    if (idleCountdown) {
      clearTimeout(idleCountdown);
      idleCountdown = null;
    }
  }

  function maybeStartIdleCountdown(): void {
    if (service.isIdle()) {
      if (!idleCountdown) {
        idleCountdown = setTimeout(() => {
          daemonHandle?.stop('idle' as ShutdownReason).catch((err: unknown) => {
            service.eventLogger.logDiagnostic({ source: 'QueueDaemon.idleShutdown', message: `idle stop failed: ${getErrorMessage(err)}` });
          });
        }, IDLE_TIMEOUT_MS);
      }
    } else {
      resetIdleCountdown();
    }
  }

  const idleCheckInterval = setInterval(maybeStartIdleCountdown, IDLE_CHECK_INTERVAL_MS);

  daemonHandle = await createDaemon({
    configDir,
    // only tests pass a port (0 = any free one): the real daemon always uses the fixed one
    port: options?.port ?? DAEMON_PORT,
    idleTimeout: null,
    // GET /version reports the queue release, not the daemon library's own default
    ...(options?.version !== undefined && { appVersion: options.version }),
    // GET /version tells the SDK clients which push protocol this daemon speaks and which client versions it accepts
    versionExtra: () => ({ queueProtocol: getQueueProtocolInfo() }),
    commands: service.commands,
    hooks: {
      onStart: (_port: number) => {
        service.onStart();

        // Re-register with app-core on every start/restart (unconditional, idempotent --
        // confirmed with app-core-owner: /register always reloads the manifest fresh).
        // Best-effort: never blocks or fails daemon startup.
        if (options?.appCoreModule) {
          registerWithAppCore(options.appCoreModule.manifestPath, entry => service.eventLogger.logDiagnostic(entry));
        }
      },
      onShutdown: (_reason: ShutdownReason) => {
        clearInterval(idleCheckInterval);
        resetIdleCountdown();
        service.onShutdown();
      },
    },
  });
}
