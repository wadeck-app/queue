/**
 * The message when the queue daemon does not come up in 5 s: it says where the log is, shows its tail and what to do
 * (it used to say only "Failed to start daemon within 5s", the daemon being spawned with no output).
 */
import { describe, it, expect } from 'vitest';
import { daemonStartFailureMessage } from './daemonStartFailure.js';

describe('daemonStartFailureMessage', () => {
  it('shows the tail of the daemon log, the full log path and the foreground command', () => {
    const text = daemonStartFailureMessage({
      configDir: '/cfg',
      daemonScript: '/app/queue-daemon.cjs',
      tail: { file: '/cfg/logs/2026-11-08.ndjson', present: true, lines: ['[daemon-entry] Failed to start: EADDRINUSE', 'second line'] },
    });

    expect(text).toContain('[fail] daemon failed to start within 5s.');
    expect(text).toContain('Log output:');
    expect(text).toContain('  | [daemon-entry] Failed to start: EADDRINUSE');
    expect(text).toContain('  | second line');
    expect(text).toContain('Full log: /cfg/logs/2026-11-08.ndjson');
    expect(text).toContain('Fix: ');
    expect(text).toContain('QUEUE_CONFIG_DIR=/cfg node /app/queue-daemon.cjs');
  });

  it('no log for today: says the process died before logging and where it looked', () => {
    const text = daemonStartFailureMessage({
      configDir: '/cfg',
      daemonScript: '/app/queue-daemon.cjs',
      tail: { file: '/cfg/logs/2026-11-08.ndjson', present: false, lines: [] },
    });

    expect(text).toContain('No log was written (/cfg/logs/2026-11-08.ndjson): the process died before logging.');
    expect(text).not.toContain('Log output:');
    expect(text).toContain('QUEUE_CONFIG_DIR=/cfg node /app/queue-daemon.cjs');
  });

  it('a log that cannot be read is said, not hidden', () => {
    const text = daemonStartFailureMessage({ configDir: '/cfg', daemonScript: '/app/queue-daemon.cjs', tail: new Error('EACCES: permission denied') });

    expect(text).toContain('The daemon log could not be read: EACCES: permission denied');
    expect(text).toContain('QUEUE_CONFIG_DIR=/cfg node /app/queue-daemon.cjs');
  });
});
