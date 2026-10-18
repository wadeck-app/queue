import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isOnDemand, liveWaiterCount } from '@wadeck-app/queue-relay-client';
import { RelayOnDemand, isRelaySourcedEvent } from './relayOnDemand.js';

let relayDir: string;
let stderr: string[];

beforeEach(() => {
  relayDir = mkdtempSync(join(tmpdir(), 'relay-on-demand-cli-'));
  stderr = [];
});

afterEach(() => {
  rmSync(relayDir, { recursive: true, force: true });
});

function onDemand(options: { running?: boolean | 'rejects'; startCode?: number } = {}) {
  const startRelay = vi.fn(async () => options.startCode ?? 0);
  const isRunning = vi.fn(async () => {
    if (options.running === 'rejects') throw new Error('ECONNREFUSED');
    return options.running ?? false;
  });
  const subject = new RelayOnDemand({ relayDir, isRunning, startRelay, io: { stderr: { write: (s: string) => { stderr.push(s); } } } });
  return { subject, startRelay, isRunning };
}

describe('isRelaySourcedEvent', () => {
  it.each(['on.github.workflow_run', 'on.github.push', 'on.slack.message'])('%s comes from the relay', (name) => {
    expect(isRelaySourcedEvent(name)).toBe(true);
  });

  it.each(['onStatusChange', 'onTaskCreated', 'before.commit', 'test.event', 'on.github', 'ci'])('%s does not need the relay', (name) => {
    expect(isRelaySourcedEvent(name)).toBe(false);
  });
});

describe('RelayOnDemand', () => {
  it('registers this process as a waiter on begin and removes it on end', () => {
    const { subject } = onDemand();
    subject.begin();
    expect(liveWaiterCount(relayDir)).toBe(1);
    subject.end();
    expect(liveWaiterCount(relayDir)).toBe(0);
    expect(() => subject.end()).not.toThrow();
  });

  it('does not touch a relay that is already running (it was started by hand or by another wait)', async () => {
    const { subject, startRelay } = onDemand({ running: true });
    expect(await subject.ensureRunning()).toBe(true);
    expect(startRelay).not.toHaveBeenCalled();
    expect(isOnDemand(relayDir)).toBe(false);
  });

  it('starts the relay when it is down, marks it on-demand, and says it will stop by itself', async () => {
    const { subject, startRelay } = onDemand({ running: false });
    expect(await subject.ensureRunning()).toBe(true);
    expect(startRelay).toHaveBeenCalledTimes(1);
    expect(isOnDemand(relayDir)).toBe(true);
    expect(stderr.join('')).toContain('starting it for this wait');
    expect(stderr.join('')).toContain('stops by itself');
  });

  it('treats a relay that cannot be reached as down', async () => {
    const { subject, startRelay } = onDemand({ running: 'rejects' });
    expect(await subject.ensureRunning()).toBe(true);
    expect(startRelay).toHaveBeenCalledTimes(1);
  });

  it('reports failure and marks nothing when the relay cannot start (relayStart already explained why)', async () => {
    const { subject } = onDemand({ running: false, startCode: 1 });
    expect(await subject.ensureRunning()).toBe(false);
    expect(isOnDemand(relayDir)).toBe(false);
  });

  it('leaves no waiter file behind after begin/ensureRunning/end', async () => {
    const { subject } = onDemand({ running: false });
    subject.begin();
    await subject.ensureRunning();
    subject.end();
    expect(existsSync(join(relayDir, 'waiters', String(process.pid)))).toBe(false);
  });
});
