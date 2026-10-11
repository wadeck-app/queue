import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage } from '../errors.js';

export interface AppCoreModuleSource { type: 'file'; path: string }
export interface AppCoreRegistrationPayload { id: string; source: AppCoreModuleSource }

const DEFAULT_APP_CORE_PORT = 4850;

function appCorePort(): number {
  const raw = process.env['APP_CORE_PORT'];
  return raw ? Number(raw) : DEFAULT_APP_CORE_PORT;
}

function appCoreConfigDir(): string {
  return process.env['APP_CORE_CONFIG_DIR'] ?? join(homedir(), '.config', 'app-core');
}

/**
 * Registers this daemon's app-module with a running app-core instance (POST /api/modules/register --
 * identical behavior to /update per app-core-owner, confirmed against their actual route handler).
 * On failure (app-core unreachable), falls back to writing the registration payload into app-core's
 * own config-dir pickup path (<configDir>/modules/<id>.json, confirmed real and read by app-core on
 * its own next startup). If both fail, logs once and gives up -- no retry, per Wadeck's choice; the
 * daemon still starts normally either way, this is best-effort.
 */
export async function registerWithAppCore(
  id: string,
  manifestPath: string,
  logDiagnostic: (entry: { source: string; message: string }) => void,
): Promise<void> {
  const payload: AppCoreRegistrationPayload = { id, source: { type: 'file', path: manifestPath } };
  const url = `http://127.0.0.1:${appCorePort()}/api/modules/register`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.ok) return;
    logDiagnostic({ source: 'AppCoreRegistration', message: `app-core responded ${response.status} to module registration for "${id}"` });
    return;
  } catch {
    // app-core unreachable -- fall back to the config-dir pickup file below.
  }

  try {
    const dir = join(appCoreConfigDir(), 'modules');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(payload));
  } catch (err) {
    logDiagnostic({
      source: 'AppCoreRegistration',
      message: `could not register module "${id}" with app-core (unreachable) or write fallback file: ${getErrorMessage(err)}`,
    });
  }
}
