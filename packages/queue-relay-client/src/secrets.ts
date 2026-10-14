import { readFileSync as fsReadFileSync, existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';

/**
 * Parse .env.local format (KEY=VALUE).
 * - Ignores blank lines and lines starting with #
 * - Strips optional 'export ' prefix
 * - Strips one pair of matching single or double quotes from value
 * - Ignores lines without =
 * - No variable expansion
 * - No multiline values
 */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    // Ignore blank lines and comments
    if (!line || line.startsWith('#')) continue;

    // Find the = separator
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue; // Ignore malformed lines

    // Extract key (and strip 'export ' prefix if present)
    let key = line.slice(0, eqIdx).trim();
    if (key.startsWith('export ')) {
      key = key.slice(7).trim();
    }

    // Extract value and strip one pair of matching quotes
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export interface ResolveRelayTokenDeps {
  configDir: string;
  relayYmlToken?: string;
  env?: Record<string, string>;
  readFile?: (path: string, encoding: BufferEncoding) => string;
  exists?: (path: string) => boolean;
}

export interface ResolveRelayTokenResult {
  token: string;
  source: 'env' | 'secrets' | 'relay.yml';
}

/**
 * Resolve the relay token from multiple sources with priority:
 * 1. env var QUEUE_RELAY_TOKEN (non-empty)
 * 2. <secretsDir>/.env.local key QUEUE_RELAY_TOKEN
 *    - secretsDir = env QUEUE_SECRETS_DIR ?? <configDir>/_secrets_
 * 3. relayYmlToken from relay.yml (deprecated, discouraged)
 *
 * Legacy check: if <configDir>/.env.local exists but secretsDir/.env.local does not,
 * throw an error with actionable message.
 *
 * If no token found anywhere, throw error naming both recommended locations.
 */
export function resolveRelayToken(deps: ResolveRelayTokenDeps): ResolveRelayTokenResult {
  const {
    configDir,
    relayYmlToken,
    env = process.env,
    readFile = fsReadFileSync,
    exists = fsExistsSync,
  } = deps;

  // (1) Check env var QUEUE_RELAY_TOKEN (non-empty)
  const envToken = env['QUEUE_RELAY_TOKEN'];
  if (envToken && envToken.trim()) {
    return { token: envToken.trim(), source: 'env' };
  }

  // Determine secrets directory
  const secretsDir = env['QUEUE_SECRETS_DIR'] ?? path.join(configDir, '_secrets_');
  const secretsEnvFile = path.join(secretsDir, '.env.local');

  // (2) Check <secretsDir>/.env.local for QUEUE_RELAY_TOKEN
  let secretsFileLacksToken = false;
  if (exists(secretsEnvFile)) {
    try {
      const content = readFile(secretsEnvFile, 'utf8');
      const parsed = parseDotEnv(content);
      const token = parsed['QUEUE_RELAY_TOKEN'];
      if (token && token.trim()) {
        return { token: token.trim(), source: 'secrets' };
      }
      secretsFileLacksToken = true;
    } catch (err) {
      // If the file exists but is unreadable (e.g., EACCES), throw with details
      const error = err as any;
      throw new Error(
        `[queue-relay-client] Failed to read ${secretsEnvFile}: ${error.code ?? 'unknown error'} (${error.message})`
      );
    }
  }

  // Legacy location check: .env.local in <configDir> (not in _secrets_)
  const legacyEnvFile = path.join(configDir, '.env.local');
  if (exists(legacyEnvFile)) {
    throw new Error(
      `[queue-relay-client] .env.local found at the legacy location (${legacyEnvFile}): ` +
      `it must live under _secrets_/ -> move it to ${secretsEnvFile}`
    );
  }

  // (3) Fall back to relay.yml token (deprecated)
  if (relayYmlToken && relayYmlToken.trim()) {
    return { token: relayYmlToken.trim(), source: 'relay.yml' };
  }

  // No token found
  const lacksTokenNote = secretsFileLacksToken ? ` ${secretsEnvFile} exists but has no QUEUE_RELAY_TOKEN line.` : '';
  throw new Error(
    `[queue-relay-client] No relay token found.${lacksTokenNote} Put it in ${secretsEnvFile} as QUEUE_RELAY_TOKEN=<token> ` +
    `(recommended; the folder is gitignored and protected), or export QUEUE_RELAY_TOKEN. ` +
    `A "token:" entry in relay.yml still works but is deprecated (plaintext).`
  );
}
