import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUEUE_DAEMON_PORT, DEFAULT_RELAY_DAEMON_PORT, InvalidPortEnvError, assertPortEnvValid, readPortEnv, resolveQueueDaemonPort, resolveRelayDaemonPort,
} from './daemonPorts.js';

describe('daemon ports', () => {
  it('keeps the documented defaults', () => {
    expect(DEFAULT_QUEUE_DAEMON_PORT).toBe(47910);
    expect(DEFAULT_RELAY_DAEMON_PORT).toBe(47911);
    expect(resolveQueueDaemonPort(undefined, {})).toBe(47910);
    expect(resolveRelayDaemonPort(undefined, {})).toBe(47911);
  });

  it('precedence: explicit option > environment > default', () => {
    const env = { QUEUE_DAEMON_PORT: '50001', QUEUE_RELAY_PORT: '50002' };
    expect(resolveQueueDaemonPort(undefined, env)).toBe(50001);
    expect(resolveRelayDaemonPort(undefined, env)).toBe(50002);
    expect(resolveQueueDaemonPort(0, env)).toBe(0);
    expect(resolveRelayDaemonPort(51000, env)).toBe(51000);
  });

  it('accepts the bounds', () => {
    expect(readPortEnv('P', { P: '1024' })).toBe(1024);
    expect(readPortEnv('P', { P: '65535' })).toBe(65535);
  });

  it.each(['1023', '65536', '0', '-1', '12.5', 'abc', '', ' 5000', '5000 ', '0x1F90', '1e4'])('refuses %j naming the variable and the value', (value) => {
    expect(() => readPortEnv('QUEUE_DAEMON_PORT', { QUEUE_DAEMON_PORT: value })).toThrow(InvalidPortEnvError);
    expect(() => resolveQueueDaemonPort(undefined, { QUEUE_DAEMON_PORT: value })).toThrow(`QUEUE_DAEMON_PORT=${JSON.stringify(value)}`);
  });

  it('assertPortEnvValid reports the first invalid variable and ignores the unset ones', () => {
    expect(() => assertPortEnvValid(['QUEUE_DAEMON_PORT', 'QUEUE_RELAY_PORT'], {})).not.toThrow();
    expect(() => assertPortEnvValid(['QUEUE_DAEMON_PORT', 'QUEUE_RELAY_PORT'], { QUEUE_RELAY_PORT: 'x' })).toThrow(/QUEUE_RELAY_PORT="x"/);
  });
});
