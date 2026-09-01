import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { runQueueCommand } from './QueueIndex.js';
import { getErrorMessage } from '../errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function withArgv(args: string[], fn: () => Promise<void>): Promise<void> {
  const orig = process.argv;
  process.argv = ['node', 'queue.cjs', ...args];
  return fn().finally(() => { process.argv = orig; });
}

describe('queue cli self-check output', () => {
  it('writes [ok] lines to stderr (Go launcher compat)', async () => {
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    // Suppress stdout noise in tests
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const origEnv = process.env['QUEUE_CONFIG_DIR'];
    process.env['QUEUE_CONFIG_DIR'] = tmpdir();
    try {
      await withArgv(['cli', 'self-check'], runQueueCommand);
    } catch (e) {
      // process.exit throws via mock — expected
      if (!(e instanceof Error) || getErrorMessage(e) !== 'process.exit called') throw e;
    } finally {
      if (origEnv === undefined) {
        delete process.env['QUEUE_CONFIG_DIR'];
      } else {
        process.env['QUEUE_CONFIG_DIR'] = origEnv;
      }
    }

    const combined = stderrLines.join('');
    expect(combined).toMatch(/\[ok\]/);
    // Exit 0 means all checks passed
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it('quiet mode (CLI_SELF_CHECK_QUIET=1) suppresses stderr output', async () => {
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const origEnv = process.env['QUEUE_CONFIG_DIR'];
    const origQuiet = process.env['CLI_SELF_CHECK_QUIET'];
    process.env['QUEUE_CONFIG_DIR'] = tmpdir();
    process.env['CLI_SELF_CHECK_QUIET'] = '1';
    try {
      await withArgv(['cli', 'self-check'], () => runQueueCommand());
    } catch (e) {
      if (!(e instanceof Error) || getErrorMessage(e) !== 'process.exit called') throw e;
    } finally {
      if (origEnv === undefined) {
        delete process.env['QUEUE_CONFIG_DIR'];
      } else {
        process.env['QUEUE_CONFIG_DIR'] = origEnv;
      }
      if (origQuiet === undefined) {
        delete process.env['CLI_SELF_CHECK_QUIET'];
      } else {
        process.env['CLI_SELF_CHECK_QUIET'] = origQuiet;
      }
    }

    expect(stderrLines.join('')).toBe('');
  });
});
