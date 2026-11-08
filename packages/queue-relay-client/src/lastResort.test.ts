import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { installLastResortHandlers } from './lastResort.js';

function setup(logThrows = false): { proc: EventEmitter; logs: string[]; exits: number[] } {
  const proc = new EventEmitter();
  const logs: string[] = [];
  const exits: number[] = [];
  installLastResortHandlers({
    proc: proc as unknown as NodeJS.Process,
    log: (line) => {
      if (logThrows) {
        throw new Error('disk full');
      }
      logs.push(line);
    },
    exit: (code) => exits.push(code),
  });
  return { proc, logs, exits };
}

describe('installLastResortHandlers', () => {
  it('logs the cause of an uncaught exception, then exits with 1', () => {
    const { proc, logs, exits } = setup();
    proc.emit('uncaughtException', new Error('boom in a listener'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('uncaught exception');
    expect(logs[0]).toContain('boom in a listener');
    expect(logs[0]).toContain('queue relay start');
    expect(exits).toEqual([1]);
  });

  it('logs the cause of an unhandled rejection (also a non-Error reason), then exits with 1', () => {
    const { proc, logs, exits } = setup();
    proc.emit('unhandledRejection', 'plain string reason');
    expect(logs[0]).toContain('unhandled promise rejection');
    expect(logs[0]).toContain('plain string reason');
    expect(exits).toEqual([1]);
  });

  it('exits even when writing the log fails, and only once for several failures', () => {
    const { proc, exits } = setup(true);
    expect(() => proc.emit('uncaughtException', new Error('first'))).toThrow('disk full');
    proc.emit('uncaughtException', new Error('second'));
    expect(exits).toEqual([1]);
  });
});
