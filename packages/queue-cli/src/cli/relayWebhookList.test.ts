import { describe, it, expect, beforeEach, vi } from 'vitest';
import { relayWebhookList } from './relayWebhookList.js';
import type { RelayApiClient } from './relayWebhookList.js';

interface MockIO {
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
}

describe('relayWebhookList', () => {
  let mockClient: RelayApiClient;
  let io: MockIO;

  beforeEach(() => {
    mockClient = {
      listWebhookConfigs: vi.fn(),
      listDeliveries: vi.fn(),
    };
    io = {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    };
  });

  it('prints a table of configured webhooks', async () => {
    (mockClient.listWebhookConfigs as any).mockResolvedValue([
      {
        id: 'cfg-1',
        source: 'github',
        name: 'My Webhook',
        createdAt: '2026-10-01T10:00:00Z',
        webhookUrl: '/webhook/github/cfg-1',
        stats: {
          verified24h: 42,
          rejected24h: 5,
          lastDeliveryAt: '2026-10-14T14:30:00Z',
          lastVerifiedAt: '2026-10-14T14:25:00Z',
        },
      },
    ]);

    const exitCode = await relayWebhookList(mockClient, io, {});

    expect(exitCode).toBe(0);
    const output = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
    expect(output).toContain('cfg-1');
    expect(output).toContain('github');
    expect(output).toContain('My Webhook');
    expect(output).toContain('42');
    expect(output).toContain('5');
    expect(output).toContain('2026-10-14');
    expect(output).toContain('1 webhook');
  });

  it('formats null timestamps as "never"', async () => {
    (mockClient.listWebhookConfigs as any).mockResolvedValue([
      {
        id: 'cfg-1',
        source: 'github',
        name: 'Unused Webhook',
        createdAt: '2026-10-01T10:00:00Z',
        webhookUrl: '/webhook/github/cfg-1',
        stats: {
          verified24h: 0,
          rejected24h: 0,
          lastDeliveryAt: null,
          lastVerifiedAt: null,
        },
      },
    ]);

    const exitCode = await relayWebhookList(mockClient, io, {});

    expect(exitCode).toBe(0);
    const output = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
    expect(output).toContain('never');
  });

  it('returns empty list message when no webhooks configured', async () => {
    (mockClient.listWebhookConfigs as any).mockResolvedValue([]);

    const exitCode = await relayWebhookList(mockClient, io, {});

    expect(exitCode).toBe(0);
    const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
    expect(stderrOutput).toContain('[info]');
    expect(stderrOutput).toContain('No webhook configured');
    expect(stderrOutput).toContain('/webhook/github');
  });

  it('outputs JSON when --json flag is set', async () => {
    (mockClient.listWebhookConfigs as any).mockResolvedValue([
      {
        id: 'cfg-1',
        source: 'github',
        name: 'My Webhook',
        createdAt: '2026-10-01T10:00:00Z',
        webhookUrl: '/webhook/github/cfg-1',
        stats: {
          verified24h: 42,
          rejected24h: 5,
          lastDeliveryAt: '2026-10-14T14:30:00Z',
          lastVerifiedAt: '2026-10-14T14:25:00Z',
        },
      },
    ]);

    const exitCode = await relayWebhookList(mockClient, io, { json: true });

    expect(exitCode).toBe(0);
    const output = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('cfg-1');
  });

  it('returns exit code 1 on API error', async () => {
    const error = new Error('Connection failed');
    (error as any).kind = 'network';
    (error as any).message = 'Cannot reach the relay';
    (mockClient.listWebhookConfigs as any).mockRejectedValue(error);

    const exitCode = await relayWebhookList(mockClient, io, {});

    expect(exitCode).toBe(1);
    const stderrOutput = (io.stderr.write as any).mock.calls.map((c: any) => c[0]).join('');
    expect(stderrOutput).toContain('[fail]');
    expect(stderrOutput).toContain('Cannot reach the relay');
  });

  it('prints the full webhook URL (origin + path, never truncated) and the full id to paste into GitHub', async () => {
    const id = 'fb47bebb-ad6d-4320-8dcd-34ca496a240c';
    (mockClient.listWebhookConfigs as any).mockResolvedValue([
      { id, source: 'github', name: 'wadeck-app', createdAt: '2026-10-14T21:30:05.230Z', webhookUrl: `/webhook/github/${id}`, stats: { verified24h: 0, rejected24h: 0, lastDeliveryAt: null, lastVerifiedAt: null } },
    ]);

    const exitCode = await relayWebhookList(mockClient, io, { origin: 'https://assistant.wadeck.ch' });

    expect(exitCode).toBe(0);
    const output = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
    expect(output).toContain(`https://assistant.wadeck.ch/webhook/github/${id}`);
    expect(output).toContain(id);
    expect(output).toContain('wadeck-app');
    expect(output).toContain('never');
  });

  it('does not crash and says so when the relay reports no statistics for a webhook', async () => {
    (mockClient.listWebhookConfigs as any).mockResolvedValue([
      { id: 'cfg-9', source: 'github', name: 'no-stats', createdAt: '2026-10-14T21:30:05Z', webhookUrl: '/webhook/github/cfg-9' },
    ]);

    const exitCode = await relayWebhookList(mockClient, io, {});

    expect(exitCode).toBe(0);
    const output = (io.stdout.write as any).mock.calls.map((c: any) => c[0]).join('');
    expect(output).toContain('cfg-9');
    expect(output).toContain('statistics not reported by this relay');
    expect(output).toContain('1 webhook');
    expect((io.stderr.write as any).mock.calls.length).toBe(0);
  });
});
