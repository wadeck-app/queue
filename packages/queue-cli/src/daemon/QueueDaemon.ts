import { createDaemon } from '@wadeck-app/singleton-daemon-kit';
import type { ShutdownReason } from '@wadeck-app/singleton-daemon-kit';
import { createQueueService, getErrorMessage } from '@wadeck-app/queue-core';
import { registerWithAppCore } from './AppCoreRegistration.js';

export const DAEMON_PORT = 47910;
export const IDLE_TIMEOUT_MS = 60_000;
const IDLE_CHECK_INTERVAL_MS = 10_000;

export interface AppCoreModuleOptions { id: string; manifestPath: string; }

/**
 * Hosts the queue as the singleton background daemon: owns the port, the idle shutdown and the
 * app-core registration; the queue logic itself is queue-core's createQueueService.
 */
export async function startDaemon(configDir: string, options?: { appCoreModule?: AppCoreModuleOptions }): Promise<void> {
  let idleCountdown: ReturnType<typeof setTimeout> | null = null;
  let daemonHandle: Awaited<ReturnType<typeof createDaemon>> | null = null;

  const service = createQueueService(configDir, { onActivity: resetIdleCountdown });

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
    port: DAEMON_PORT,
    idleTimeout: null,
    commands: service.commands,
    hooks: {
      onStart: (_port: number) => {
        service.onStart();

        // Re-register with app-core on every start/restart (unconditional, idempotent --
        // confirmed with app-core-owner: /register always reloads the manifest fresh).
        // Best-effort: never blocks or fails daemon startup.
        if (options?.appCoreModule) {
          const { id, manifestPath } = options.appCoreModule;
          registerWithAppCore(id, manifestPath, entry => service.eventLogger.logDiagnostic(entry)).catch((err: unknown) => {
            service.eventLogger.logDiagnostic({ source: 'QueueDaemon.onStart', message: `app-core registration failed: ${getErrorMessage(err)}` });
          });
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
