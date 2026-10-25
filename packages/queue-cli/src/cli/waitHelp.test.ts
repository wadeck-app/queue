import { describe, it, expect } from 'vitest';
import { WAIT_HELP } from './waitCli.js';
import { WAIT_DEFAULT_TIMEOUT } from './eventWaitArgs.js';

describe('the default timeout of queue wait', () => {
  it('is 30 minutes, for an event and for the CI of a commit alike', () => {
    expect(WAIT_DEFAULT_TIMEOUT).toBe('30m');
    const timeoutLines = WAIT_HELP.split('\n').filter((line) => line.includes('--timeout <d>') && line.includes('Give up after this long'));
    expect(timeoutLines).toHaveLength(2);
    for (const line of timeoutLines) {
      expect(line).toContain('(default 30m)');
    }
    expect(WAIT_HELP).not.toContain('(default 15m)');
  });
});
