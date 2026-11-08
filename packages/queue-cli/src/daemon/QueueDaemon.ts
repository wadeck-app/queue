import { createDaemon } from '@wadeck-app/singleton-daemon-kit';
import type { ShutdownReason } from '@wadeck-app/singleton-daemon-kit';
import { defaultRegistryDir } from '@wadeck-app/project-sdk';
import { createQueueService, getErrorMessage, getQueueProtocolInfo, resolveQueueDaemonPort } from '@wadeck-app/queue-core';
import { registerWithAppCore } from './AppCoreRegistration.js';
import { IdleShutdown } from './IdleShutdown.js';
import { createBuiltinActionRegistry } from '../actions/builtinActions.js';

export const IDLE_TIMEOUT_MS = 60_000;
const IDLE_CHECK_INTERVAL_MS = 10_000;

export interface AppCoreModuleOptions { manifestPath: string; }

/**
 * Hosts the queue as the singleton background daemon: owns the port, the idle shutdown and the
 * app-core registration; the queue logic itself is queue-core's createQueueService.
 */
export async function startDaemon(configDir: string, options?: { appCoreModule?: AppCoreModuleOptions; port?: number; version?: string }): Promise<void> {
  // explicit option (tests: 0 = any free one) > QUEUE_DAEMON_PORT > 47910; an invalid QUEUE_DAEMON_PORT throws before anything starts, never falls back
  const port = resolveQueueDaemonPort(options?.port);
  let daemonHandle: Awaited<ReturnType<typeof createDaemon>> | null = null;

  // The action plugins this build ships (emit, plus the ones in builtinActions.ts): a type: action subscriber naming any other fails alone, to the DLQ, with the list of the available ones
  const service = createQueueService(configDir, { onActivity: () => idleShutdown.noteActivity(), registryDir: defaultRegistryDir(process.env), actions: createBuiltinActionRegistry() });

  // Every command counts as activity, not only a push, and the stop re-checks that the service is still idle when the countdown fires
  const idleShutdown = new IdleShutdown({
    isIdle: () => service.isIdle(),
    stop: () => daemonHandle?.stop('idle' as ShutdownReason),
    onStopError: (err) => service.eventLogger.logDiagnostic({ source: 'QueueDaemon.idleShutdown', message: `idle stop failed: ${getErrorMessage(err)}` }),
    timeoutMs: IDLE_TIMEOUT_MS,
    checkIntervalMs: IDLE_CHECK_INTERVAL_MS,
  });
  idleShutdown.start();

  daemonHandle = await createDaemon({
    configDir,
    port,
    idleTimeout: null,
    // GET /version reports the queue release, not the daemon library's own default
    ...(options?.version !== undefined && { appVersion: options.version }),
    // GET /version tells the SDK clients which push protocol this daemon speaks and which client versions it accepts
    versionExtra: () => ({ queueProtocol: getQueueProtocolInfo() }),
    commands: idleShutdown.wrap(service.commands),
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
        idleShutdown.dispose();
        service.onShutdown();
      },
    },
  });
}
