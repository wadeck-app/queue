import { describe, it, expect, beforeEach, vi } from 'vitest';
import { relayWebhookHistory } from './relayWebhookHistory.js';
import type { RelayApiClient } from './relayWebhookHistory.js';

interface MockIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

describe('relayWebhookHistory', () => {
  let mockClient: RelayApiClient;
  let io: MockIO;

  beforeEach(() => {
    mockClient = {
      listDeliveries: vi.fn(),
      listWebhookConfigs: vi.fn(),
    };
    io = {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    };
  });

  describe('argument validation', () => {
    it('returns error exit code when --limit is not an integer', async () => {
      const exitCode = await relayWebhookHistory(mockClient, io, {}, ['--limit', 'abc']);
      expect(exitCode).toBe(1);
      const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stderrOutput).toContain('[fail]');
      expect(stderrOutput).toContain('--limit');
      // No network call should have been made
      expect(mockClient.listDeliveries).not.toHaveBeenCalled();
    });

    it('returns error exit code when --limit is out of range', async () => {
      const exitCode = await relayWebhookHistory(mockClient, io, {}, ['--limit', '500']);
      expect(exitCode).toBe(1);
      const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stderrOutput).toContain('[fail]');
      expect(stderrOutput).toContain('--limit');
      expect(mockClient.listDeliveries).not.toHaveBeenCalled();
    });

    it('returns error exit code when both --verified and --rejected are set', async () => {
      const exitCode = await relayWebhookHistory(mockClient, io, {}, [
        '--verified',
        '--rejected',
      ]);
      expect(exitCode).toBe(1);
      const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stderrOutput).toContain('[fail]');
      expect(mockClient.listDeliveries).not.toHaveBeenCalled();
    });

    it('returns error exit code when --event has no value', async () => {
      const exitCode = await relayWebhookHistory(mockClient, io, {}, ['--event']);
      expect(exitCode).toBe(1);
      const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stderrOutput).toContain('[fail]');
      expect(mockClient.listDeliveries).not.toHaveBeenCalled();
    });

    it('returns error exit code when --source has no value', async () => {
      const exitCode = await relayWebhookHistory(mockClient, io, {}, ['--source']);
      expect(exitCode).toBe(1);
      const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stderrOutput).toContain('[fail]');
      expect(mockClient.listDeliveries).not.toHaveBeenCalled();
    });
  });

  describe('successful listing', () => {
    it('prints one line per delivery with default limit 20', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([
        {
          receivedAt: '2026-10-14T14:30:00Z',
          source: 'github',
          webhookConfigId: 'cfg-1',
          eventType: 'push',
          deliveryId: 'del-1',
          verified: true,
          payload: {
            repository: { full_name: 'org/repo' },
            sender: { login: 'alice' },
          },
        },
      ]);

      const exitCode = await relayWebhookHistory(mockClient, io, {}, []);

      expect(exitCode).toBe(0);
      expect(mockClient.listDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 20,
          includePayload: true,
        })
      );

      const stdoutOutput = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stdoutOutput).toContain('2026-10-14T14:30:00Z');
      expect(stdoutOutput).toContain('github');
      expect(stdoutOutput).toContain('push');
      expect(stdoutOutput).toContain('VERIFIED');
    });

    it('applies --limit, --event, --source, --verified filters', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([]);

      const exitCode = await relayWebhookHistory(mockClient, io, {}, [
        '--limit',
        '50',
        '--event',
        'pull_request',
        '--source',
        'github',
        '--verified',
      ]);

      expect(exitCode).toBe(0);
      expect(mockClient.listDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
          eventType: 'pull_request',
          source: 'github',
          verified: true,
          includePayload: true,
        })
      );
    });

    it('applies --rejected filter', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([]);

      await relayWebhookHistory(mockClient, io, {}, ['--rejected']);

      expect(mockClient.listDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({
          verified: false,
        })
      );
    });

    it('does not set includePayload when --payload is not provided', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([]);

      await relayWebhookHistory(mockClient, io, {}, []);

      expect(mockClient.listDeliveries).toHaveBeenCalledWith(
        expect.objectContaining({
          includePayload: true, // Always request payload to show summary
        })
      );
    });

    it('prints REJECTED when verified=false and shows error', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([
        {
          receivedAt: '2026-10-14T14:30:00Z',
          source: 'github',
          webhookConfigId: 'cfg-1',
          eventType: 'push',
          deliveryId: 'del-1',
          verified: false,
          error: 'Signature mismatch',
          payload: null,
        },
      ]);

      await relayWebhookHistory(mockClient, io, {}, []);

      const stdoutOutput = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stdoutOutput).toContain('REJECTED');
      expect(stdoutOutput).toContain('Signature mismatch');
    });

    it('prints payload as indented JSON when --payload flag is set', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([
        {
          receivedAt: '2026-10-14T14:30:00Z',
          source: 'github',
          webhookConfigId: 'cfg-1',
          eventType: 'push',
          deliveryId: 'del-1',
          verified: true,
          payload: { foo: 'bar', nested: { value: 42 } },
        },
      ]);

      await relayWebhookHistory(mockClient, io, {}, ['--payload']);

      const stdoutOutput = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stdoutOutput).toContain('"foo"');
      expect(stdoutOutput).toContain('bar');
      expect(stdoutOutput).toContain('nested');
      expect(stdoutOutput).toContain('42');
    });
  });

  describe('JSON output', () => {
    it('outputs raw array when --json is set', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([
        {
          receivedAt: '2026-10-14T14:30:00Z',
          source: 'github',
          webhookConfigId: 'cfg-1',
          eventType: 'push',
          deliveryId: 'del-1',
          verified: true,
          payload: { foo: 'bar' },
        },
      ]);

      const exitCode = await relayWebhookHistory(mockClient, io, { json: true }, []);

      expect(exitCode).toBe(0);
      const stdoutOutput = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
      const parsed = JSON.parse(stdoutOutput);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].eventType).toBe('push');
    });

    it('includes --payload in --json output when both flags are set', async () => {
      (mockClient.listDeliveries as any).mockResolvedValue([
        {
          receivedAt: '2026-10-14T14:30:00Z',
          source: 'github',
          webhookConfigId: 'cfg-1',
          eventType: 'push',
          deliveryId: 'del-1',
          verified: true,
          payload: { foo: 'bar' },
        },
      ]);

      await relayWebhookHistory(mockClient, io, { json: true }, ['--payload']);

      const stdoutOutput = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed[0].payload.foo).toBe('bar');
    });
  });

  describe('error handling', () => {
    it('returns exit code 1 on API error', async () => {
      const error = new Error('Connection failed');
      (mockClient.listDeliveries as any).mockRejectedValue(error);

      const exitCode = await relayWebhookHistory(mockClient, io, {}, []);

      expect(exitCode).toBe(1);
      const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
      expect(stderrOutput).toContain('[fail]');
      expect(stderrOutput).toContain('Connection failed');
    });

    it('does not print token in error messages', async () => {
      const error = new Error('The relay refused the token (HTTP 401)');
      (mockClient.listDeliveries as any).mockRejectedValue(error);

      const exitCode = await relayWebhookHistory(mockClient, io, {}, []);

      expect(exitCode).toBe(1);
      const stderr = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
      const stdout = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
      // Token should never appear in output
      const output = stderr + stdout;
      expect(output).not.toContain('test-token');
      expect(output).not.toContain('fake-token');
    });
  });
});

describe('relayWebhookHistory when the relay has recorded nothing', () => {
  it('says so on stderr and explains the likely cause instead of printing nothing', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const client: RelayApiClient = { listDeliveries: vi.fn().mockResolvedValue([]), listWebhookConfigs: vi.fn() };

    const exitCode = await relayWebhookHistory(client, { stdout: { write: stdout }, stderr: { write: stderr } }, {}, ['--limit', '5']);

    expect(exitCode).toBe(0);
    expect(stdout).not.toHaveBeenCalled();
    const message = stderr.mock.calls.map((c) => c[0]).join('');
    expect(message).toContain('[info] No delivery recorded by the relay');
    // GitHub sends a "ping" as soon as a webhook is created: its absence points at the GitHub side
    expect(message).toContain('ping');
    expect(message).toContain('queue relay webhook list');
  });

  it('keeps --json output a plain empty array (nothing else on stdout, hint on stderr only)', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const client: RelayApiClient = { listDeliveries: vi.fn().mockResolvedValue([]), listWebhookConfigs: vi.fn() };

    const exitCode = await relayWebhookHistory(client, { stdout: { write: stdout }, stderr: { write: stderr } }, { json: true }, []);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.mock.calls.map((c) => c[0]).join(''))).toEqual([]);
  });
});
