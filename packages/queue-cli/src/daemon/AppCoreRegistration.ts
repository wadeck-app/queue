import { registerModule, describeRegistration, describeRegistrationFailure } from '@wadeck-app/app-core-sdk/register';

export const APP_CORE_MODULE_ID = 'queue';

/**
 * Tells a running app-core where queue's app-module lives (POST /api/modules/register, which also
 * reloads a module it already knows -- the same call for a first registration and for an update).
 * Everything app-core answers is logged, including a refusal with its own reason; app-core being
 * absent is a normal state (the SDK answers `deferred` / `skipped`), not an error. Best-effort: never
 * throws, so neither the daemon start nor `queue cli update` can be broken by it.
 */
export async function registerWithAppCore(
  manifestPath: string,
  logDiagnostic: (entry: { source: string; message: string }) => void,
): Promise<void> {
  try {
    const outcome = await registerModule({ id: APP_CORE_MODULE_ID, manifestPath });
    logDiagnostic({ source: 'AppCoreRegistration', message: describeRegistration(outcome, APP_CORE_MODULE_ID) });
  } catch (err) {
    logDiagnostic({ source: 'AppCoreRegistration', message: describeRegistrationFailure(err) });
  }
}
