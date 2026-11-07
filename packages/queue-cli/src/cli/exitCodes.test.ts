import { describe, it, expect } from 'vitest';
import { usageText } from './QueueIndex.js';
import { COMMAND_EXIT_CODES, documentedCodes, exitCodesHelp } from './exitCodes.js';

/**
 * The global help is the user's contract. It is built from the same table the exit-code integration test runs against
 * (exitCodes.integration.test.ts), so a documented code that the CLI does not return fails there, and an undocumented command fails here.
 */
describe('global help: exit codes', () => {
  const help = usageText();

  it('prints the section built from the table, one line per command with every code and its meaning', () => {
    expect(help).toContain(exitCodesHelp());
    for (const entry of COMMAND_EXIT_CODES) {
      for (const [code, meaning] of Object.entries(entry.codes)) {
        expect(help, `queue ${entry.command}`).toContain(`${code} ${meaning}`);
      }
    }
  });

  it('no longer claims an exit code 2 for "daemon not running" (no command returns it)', () => {
    expect(help).not.toMatch(/^\s*2\s+daemon not running/m);
    expect(help).toContain('no command exits 2 because "the daemon is not running"');
    const status = COMMAND_EXIT_CODES.find((entry) => entry.command === 'status')!;
    expect(Object.keys(status.codes).map(Number)).toEqual([0, 1]);
  });

  it('documents the exit codes that are not 0/1: wait 2 and 4, wait ci 0 to 4, events 4', () => {
    expect(documentedCodes('wait')).toEqual([0, 2, 4]);
    expect(documentedCodes('wait ci')).toEqual([0, 1, 2, 3, 4]);
    expect(documentedCodes('events')).toEqual([0, 1, 4]);
  });

  it('every command of the usage list has an entry in the table (a new command cannot be undocumented)', () => {
    const usageBlock = help.slice(help.indexOf('Usage:'), help.indexOf('History options:'));
    const commands = new Set([...usageBlock.matchAll(/^ {2}queue (\S+)/gm)].map((match) => match[1]!));
    expect(commands.size).toBeGreaterThan(10);
    const documented = new Set(COMMAND_EXIT_CODES.map((entry) => entry.command.split(' ')[0]!));
    const undocumented = [...commands].filter((command) => !documented.has(command));
    expect(undocumented, `commands without exit codes in exitCodes.ts: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('every command documents 0 (success), except "unknown", which only fails', () => {
    for (const entry of COMMAND_EXIT_CODES.filter((candidate) => candidate.command !== 'unknown')) {
      expect(documentedCodes(entry.command)).toContain(0 as never);
    }
  });
});

describe('global help: dlq clear', () => {
  it('says that clearing everything is what no --id does, and that --id without a value is an error', () => {
    expect(usageText()).toContain('Without --id the WHOLE DLQ is cleared');
    expect(usageText()).toContain('--id without a value is an error');
  });
});

describe('global help: JSON output', () => {
  const help = usageText();

  it('lists every field of `status --json`, for a running and for a stopped daemon', () => {
    const section = help.slice(help.indexOf('Status --json fields:'), help.indexOf('History --json shapes:'));
    const [running, stopped] = section.split('Daemon not running');
    expect(stopped).toBeDefined();
    for (const field of ['daemonRunning', 'pendingCount', 'dlqCount', 'uptimeSec', 'pid', 'orchAvailable', 'projectId', 'daemonVersion', 'port', 'cliVersion', 'source']) {
      expect(running, `running: ${field}`).toContain(field);
    }
    for (const field of ['daemonRunning', 'pendingCount', 'dlqCount', 'projectId', 'cliVersion', 'source']) {
      expect(stopped, `not running: ${field}`).toContain(field);
    }
    // what a stopped daemon cannot give is not promised
    for (const field of ['uptimeSec', 'pid', 'orchAvailable', 'daemonVersion']) {
      expect(stopped, `not running: ${field}`).not.toContain(field);
    }
    expect(stopped).toContain('queue-files');
  });

  it('describes the three shapes of `history --json` and the --event-id and --project flags', () => {
    const section = help.slice(help.indexOf('History --json shapes:'), help.indexOf('Exit codes'));
    expect(section).toContain('{ "entries": [...], "total": N, "limit": N, "offset": N }');
    expect(section).toContain('--event-id <id> --json');
    expect(section).toContain('--follow --json');
    expect(section).toContain('NDJSON');
    expect(section).toContain('--project <name|alias|id>');
    expect(section).toContain('cannot be combined');
  });
});
