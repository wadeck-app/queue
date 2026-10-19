/**
 * Unit tests for relayStop function.
 * Tests all three branches: (a) not running, (b) running but quit fails, (c) success.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { relayStop } from './relayStop.js';
import type { RelayCommands } from '@wadeck-app/queue-relay-client';
import type { DaemonClient } from '@wadeck-app/singleton-daemon-kit';

// Minimal mock implementation of DaemonClient
function createMockClient(overrides?: Partial<DaemonClient<RelayCommands>>): DaemonClient<RelayCommands> {
  return {
    isRunning: vi.fn().mockResolvedValue(true),
    send: vi.fn(),
    ...overrides,
  } as unknown as DaemonClient<RelayCommands>;
}

describe('relayStop', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relay-stop-test-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('(a) relay not running', () => {
    it('returns 0 and writes [ok] relay client was not running to stderr', async () => {
      const client = createMockClient({ isRunning: vi.fn().mockResolvedValue(false) });
      const stderr: string[] = [];
      const io = { stdout: { write: () => undefined }, stderr: { write: (s: string) => { stderr.push(s); } } };

      const exitCode = await relayStop(client, tmpDir, io);

      expect(exitCode).toBe(0);
      expect(stderr.join('')).toContain('[ok] relay client was not running');
    });
  });

  describe('(b) running but quit throws', () => {
    it('returns 1, prints [fail] with error message, and includes actionable hint', async () => {
      const client = createMockClient({
        isRunning: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const stderr: string[] = [];
      const io = { stdout: { write: () => undefined }, stderr: { write: (s: string) => { stderr.push(s); } } };

      const exitCode = await relayStop(client, tmpDir, io);

      expect(exitCode).toBe(1);
      const output = stderr.join('');
      expect(output).toContain('[fail] relay client did not stop');
      expect(output).toContain('Connection refused');
      // Should mention log path as hint
      expect(output).toContain('relay.log');
    });

    it('handles race condition: daemon exits after isRunning check but before quit', async () => {
      // Simulate: first isRunning() returns true, but quit() fails and second
      // isRunning() returns false (daemon exited in between)
      const isRunningFn = vi.fn()
        .mockResolvedValueOnce(true) // Initial check: running
        .mockResolvedValueOnce(false); // After quit fails: no longer running
      const client = createMockClient({
        isRunning: isRunningFn,
        send: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const stderr: string[] = [];
      const io = { stdout: { write: () => undefined }, stderr: { write: (s: string) => { stderr.push(s); } } };

      const exitCode = await relayStop(client, tmpDir, io);

      // Should be treated as idempotent success (case a), not hard failure (case b)
      expect(exitCode).toBe(0);
      const output = stderr.join('');
      expect(output).toContain('[ok] relay client was not running');
    });
  });

  describe('(c) success', () => {
    it('returns 0 and writes [ok] relay client stopped to stdout', async () => {
      const client = createMockClient({
        isRunning: vi.fn().mockResolvedValue(true),
        send: vi.fn().mockResolvedValue(undefined),
      });
      const stdout: string[] = [];
      const io = { stdout: { write: (s: string) => { stdout.push(s); } }, stderr: { write: () => undefined } };

      const exitCode = await relayStop(client, tmpDir, io);

      expect(exitCode).toBe(0);
      expect(stdout.join('')).toContain('[ok] relay client stopped');
    });
  });
});
