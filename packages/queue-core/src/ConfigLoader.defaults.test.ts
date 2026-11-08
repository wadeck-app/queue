import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from './ConfigLoader.js';
import type { ResolvedSubscriber } from './types.js';

// The retry defaults are a contract (guiding-principles.md): 5 tries, 30 s timeout, exponential backoff. A change breaks every subscriber that does not say otherwise.
describe('ConfigLoader resolves retries, timeout and backoff', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'queue-defaults-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

  const load = (fields: string[]): ResolvedSubscriber => {
    writeFileSync(join(dir, 'subscribers.yml'), ['subscribers:', '  onX:', '    - type: cli', '      name: s', '      command: echo hi', ...fields.map((f) => `      ${f}`), ''].join('\n'));
    return [...new ConfigLoader(dir).load(undefined).values()].flat()[0]!;
  };

  it('defaults: 5 retries, 30000 ms, exponential', () => {
    const sub = load([]);
    expect(sub.retries).toBe(5);
    expect(sub.timeoutMs).toBe(30_000);
    expect(sub.backoff).toBe('exponential');
  });

  it('keeps what the subscriber says: retries, timeout and linear backoff', () => {
    const sub = load(['retries: 9', 'timeout: 2m', 'backoff: linear']);
    expect(sub.retries).toBe(9);
    expect(sub.timeoutMs).toBe(120_000);
    expect(sub.backoff).toBe('linear');
  });

  it('retries: 0 means no retry, it is not replaced by the default', () => {
    expect(load(['retries: 0']).retries).toBe(0);
  });

  it('an explicit exponential stays exponential', () => {
    expect(load(['backoff: exponential']).backoff).toBe('exponential');
  });

  it('an unknown backoff is refused at load, naming the file', () => {
    expect(() => load(['backoff: fibonacci'])).toThrow(/subscribers\.yml/);
  });
});
