/**
 * The exit codes of the `queue` commands, written once: the global help prints them (exitCodesHelp) and the exit-code table test
 * (exitCodes.integration.test.ts) runs the real CLI and compares what each command returns with what is documented here.
 * A code that is not listed for a command must not exist, and a listed code must be reachable.
 */

export interface CommandExitCodes {
  /** The command as typed after `queue`, e.g. "push" or "wait ci". */
  command: string;
  /** Exit code -> when the command returns it. 0 is always present. */
  codes: Readonly<Record<number, string>>;
}

export const COMMAND_EXIT_CODES: readonly CommandExitCodes[] = [
  { command: 'push', codes: { 0: 'queued (a warning says when nobody listens), or the result of a before* event', 1: 'invalid arguments or project, daemon did not start, push rejected or aborted' } },
  { command: 'retry', codes: { 0: 'retry enqueued', 1: 'usage, unknown WAL id, or refused (already delivered, in the DLQ, subscriber gone)' } },
  { command: 'replay', codes: { 0: 'replayed', 1: 'usage, unknown eventId, no payload recorded, push refused' } },
  { command: 'status', codes: { 0: 'reported, also when the daemon is not running (read daemonRunning)', 1: 'unknown --project, or the queue files cannot be read' } },
  { command: 'list-subscribers', codes: { 0: 'listed', 1: 'daemon did not start' } },
  { command: 'dlq', codes: { 0: 'listed, replayed, or cleared (clear without --id clears all)', 1: 'usage (--id without a value, unknown argument), unknown id, replay refused' } },
  { command: 'sub', codes: { 0: 'listed, added, edited or removed', 1: 'invalid arguments, unreadable or invalid subscribers.yml, change refused' } },
  { command: 'start', codes: { 0: 'started, or already running', 1: 'invalid QUEUE_DAEMON_PORT, or did not start within 5s' } },
  { command: 'stop', codes: { 0: 'stopped, or was not running', 1: 'was running and is still running' } },
  { command: 'relay', codes: { 0: 'started, stopped, status reported (also when not running), or listed', 1: 'invalid relay.yml or port, did not start or stop, request failed' } },
  { command: 'logs', codes: { 0: 'printed' } },
  { command: 'history', codes: { 0: 'printed (also when nothing matches)', 1: 'invalid flags, unknown project, unknown --event-id' } },
  { command: 'events', codes: { 0: 'listed, shown or registered', 1: 'declaration rejected, unreadable file, old daemon', 4: 'invalid usage, unknown event name' } },
  { command: 'waiters', codes: { 0: 'listed (also when nobody waits or nothing was recorded)', 1: 'invalid flags, or the waiters folder cannot be read' } },
  { command: 'wait', codes: { 0: 'matched', 2: 'timeout', 4: 'invalid usage (including an invalid or taken --name), or --strict on an undeclared event' } },
  { command: 'wait ci', codes: { 0: 'CI passed', 1: 'CI failed', 2: 'timeout', 3: 'no run seen, or the relay is not running', 4: 'invalid usage (including an invalid or taken --name)' } },
  { command: 'unknown', codes: { 1: 'not a queue command (any other word after queue): the usage is printed' } },
  { command: 'cli', codes: { 0: 'done', 1: 'self-check failed, update refused (dev build) or failed, unknown subcommand' } },
];

/** The codes a command documents, sorted. Throws for a command that is not in the table, so a new command cannot slip by undocumented. */
export function documentedCodes(command: string): number[] {
  const entry = COMMAND_EXIT_CODES.find((candidate) => candidate.command === command);
  if (entry === undefined) {
    throw new Error(`No exit codes documented for "queue ${command}": add it to COMMAND_EXIT_CODES (exitCodes.ts).`);
  }
  return Object.keys(entry.codes).map(Number).sort((a, b) => a - b);
}

/** The "Exit codes" section of the global help. */
export function exitCodesHelp(): string {
  const width = Math.max(...COMMAND_EXIT_CODES.map((entry) => entry.command.length)) + 1;
  const lines = COMMAND_EXIT_CODES.map((entry) => {
    const codes = Object.entries(entry.codes).map(([code, meaning]) => `${code} ${meaning}`).join(' | ');
    return `  ${entry.command.padEnd(width)} ${codes}`;
  });
  return [
    'Exit codes (an error always prints its reason on stderr; no command exits 2 because "the daemon is not running"):',
    ...lines,
    '',
  ].join('\n');
}
