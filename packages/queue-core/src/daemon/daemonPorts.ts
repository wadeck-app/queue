// The ports the queue daemon and the relay daemon ask for when they START. Everything that LOCATES a daemon reads
// <configDir>/config.port instead (the port the daemon really bound, which can differ from the one asked for).

/** Port the queue daemon asks for when nothing else is configured. */
export const DEFAULT_QUEUE_DAEMON_PORT = 47910;
/** Port the relay daemon asks for when nothing else is configured. */
export const DEFAULT_RELAY_DAEMON_PORT = 47911;

/** Environment variable that overrides DEFAULT_QUEUE_DAEMON_PORT (integer 1024-65535). */
export const QUEUE_DAEMON_PORT_ENV = 'QUEUE_DAEMON_PORT';
/** Environment variable that overrides DEFAULT_RELAY_DAEMON_PORT (integer 1024-65535). */
export const QUEUE_RELAY_PORT_ENV = 'QUEUE_RELAY_PORT';

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** A port environment variable that is set but is not an integer in 1024-65535. Never swallowed: the daemon refuses to start. */
export class InvalidPortEnvError extends Error {
  constructor(readonly variable: string, readonly value: string) {
    super(
      `${variable}=${JSON.stringify(value)} is not a valid port: expected an integer between ${MIN_PORT} and ${MAX_PORT}. ` +
      `Fix: set ${variable} to such a number, or unset it to use the default port.`,
    );
    this.name = 'InvalidPortEnvError';
  }
}

/** The port named by the environment variable, undefined when it is not set. A set but invalid value (including the empty string) throws InvalidPortEnvError. */
export function readPortEnv(variable: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[variable];
  if (raw === undefined) {
    return undefined;
  }
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new InvalidPortEnvError(variable, raw);
  }
  return port;
}

/** Port the queue daemon asks for: explicit option (0 = any free port, for tests) > QUEUE_DAEMON_PORT > 47910. */
export function resolveQueueDaemonPort(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  return explicit ?? readPortEnv(QUEUE_DAEMON_PORT_ENV, env) ?? DEFAULT_QUEUE_DAEMON_PORT;
}

/** Port the relay daemon asks for: explicit option (0 = any free port, for tests) > QUEUE_RELAY_PORT > 47911. */
export function resolveRelayDaemonPort(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  return explicit ?? readPortEnv(QUEUE_RELAY_PORT_ENV, env) ?? DEFAULT_RELAY_DAEMON_PORT;
}

/** Validates both port variables at once (what a CLI command checks before it spawns a daemon); throws InvalidPortEnvError for the first invalid one. */
export function assertPortEnvValid(variables: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  for (const variable of variables) {
    readPortEnv(variable, env);
  }
}
