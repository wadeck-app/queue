/**
 * Integration test for `queue relay webhook` commands.
 * Runs the bundled CLI against a fake relay REST server.
 *
 * This test:
 * 1. Builds the CLI bundle (if not already built)
 * 2. Starts a fake relay REST server on an ephemeral port
 * 3. Writes a relay.yml with the fake relay URL
 * 4. Runs the bundled CLI with various webhook commands
 * 5. Verifies the Authorization header, output, and exit codes
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { execFileSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir, platform } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');

interface FakeRelayRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('relayRead integration', () => {
  let server: Server;
  let port: number;
  let requests: FakeRelayRequest[] = [];
  let tempDir: string;
  let bundlePath: string;

  beforeAll(async () => {
    // Build the CLI bundle exactly like the other integration tests (no shell, no hard-coded absolute path)
    execFileSync(process.execPath, ['--import', 'tsx/esm', 'ci/scripts/bundle.ts'], {
      cwd: rootDir,
      stdio: 'inherit',
      env: { ...process.env, BUNDLE_VERSION: '0.0.0-test-integration' },
      timeout: 60_000,
      windowsHide: true,
    });

    bundlePath = join(rootDir, 'dist-bundle/queue.cjs');
    if (!existsSync(bundlePath)) {
      throw new Error(`Bundle not found at ${bundlePath}`);
    }
  }, 90_000);

  beforeEach((ctx) => {
    requests = [];

    return new Promise<void>((resolve) => {
      // Create fake relay server
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Collect request data
        const method = req.method || 'GET';
        const path = req.url || '';
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key] = value;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });

        req.on('end', () => {
          requests.push({ method, path, headers, body });

          // Handle /api/webhook-configs
          if (path === '/api/webhook-configs' && method === 'GET') {
            if (headers.authorization === 'Bearer test-relay-token') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: true,
                  serverTime: '2026-10-14T10:00:00Z',
                  configs: [
                    {
                      id: 'cfg-github-1',
                      source: 'github',
                      name: 'GitHub Push Events',
                      createdAt: '2026-10-01T10:00:00Z',
                      webhookUrl: '/webhook/github/cfg-github-1',
                      stats: {
                        verified24h: 42,
                        rejected24h: 2,
                        lastDeliveryAt: '2026-10-14T14:30:00Z',
                        lastVerifiedAt: '2026-10-14T14:30:00Z',
                      },
                    },
                  ],
                })
              );
            } else {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            }
            return;
          }

          // Handle /api/webhook-history
          if (path.startsWith('/api/webhook-history') && method === 'GET') {
            if (headers.authorization !== 'Bearer test-relay-token') {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
              return;
            }

            // Extract query params
            const queryStart = path.indexOf('?');
            const queryStr = queryStart !== -1 ? path.substring(queryStart + 1) : '';
            const params = new URLSearchParams(queryStr);

            const limit = parseInt(params.get('limit') || '20', 10);

            // Return deliveries
            const allDeliveries = [
              {
                receivedAt: '2026-10-14T14:35:00Z',
                source: 'github',
                webhookConfigId: 'cfg-github-1',
                eventType: 'push',
                deliveryId: 'del-1',
                verified: true,
                payload: {
                  repository: { full_name: 'org/repo' },
                  sender: { login: 'alice' },
                  ref: 'refs/heads/main',
                  commits: [{ id: '1' }, { id: '2' }],
                },
              },
              {
                receivedAt: '2026-10-14T14:30:00Z',
                source: 'github',
                webhookConfigId: 'cfg-github-1',
                eventType: 'pull_request',
                deliveryId: 'del-2',
                verified: true,
                payload: {
                  action: 'opened',
                  pull_request: { number: 42, title: 'Add feature' },
                },
              },
            ];

            const entries = allDeliveries.slice(0, limit);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: true,
                serverTime: '2026-10-14T10:00:00Z',
                entries,
              })
            );
            return;
          }

          // Default 404
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        });
      });

      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    return new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  afterAll(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Asynchronous on purpose: the fake relay runs in THIS process, so a blocking spawnSync would freeze it
  // and the CLI would wait for an answer that can never come
  function runCli(args: string[], env: Record<string, string> = {}): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const fullEnv: NodeJS.ProcessEnv = {
      ...process.env,
      QUEUE_CONFIG_DIR: tempDir,
      QUEUE_RELAY_TOKEN: 'test-relay-token',
      ...env,
    };

    // Remove NODE_OPTIONS to avoid interference from test harness
    delete fullEnv['NODE_OPTIONS'];

    // No shell: arguments are passed as an array, and both output streams are always returned
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bundlePath, ...args], { cwd: tempDir, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI did not finish within 30s: ${args.join(' ')}`)); }, 30_000);
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    });
  }

  it('builds the CLI bundle successfully', async () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it('`queue relay webhook list` returns table with correct Authorization header', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    writeFileSync(
      join(tempDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${port}/relay-ws\nplugins: []\n`
    );
    mkdirSync(join(tempDir, '_secrets_'), { recursive: true });
    writeFileSync(
      join(tempDir, '_secrets_', '.env.local'),
      'QUEUE_RELAY_TOKEN=test-relay-token\n'
    );

    const result = await runCli(['relay', 'webhook', 'list']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cfg-github-1');
    expect(result.stdout).toContain('GitHub Push Events');
    expect(result.stdout).toContain('42');
    expect(result.stdout).toContain('2');

    // Check that Authorization header was sent
    const configReq = requests.find((r) => r.path === '/api/webhook-configs');
    expect(configReq).toBeDefined();
    expect(configReq?.headers.authorization).toBe('Bearer test-relay-token');
  });

  it('`queue relay webhook list --json` outputs JSON array', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    writeFileSync(
      join(tempDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${port}/relay-ws\nplugins: []\n`
    );
    mkdirSync(join(tempDir, '_secrets_'), { recursive: true });
    writeFileSync(
      join(tempDir, '_secrets_', '.env.local'),
      'QUEUE_RELAY_TOKEN=test-relay-token\n'
    );

    const result = await runCli(['relay', 'webhook', 'list', '--json']);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].id).toBe('cfg-github-1');
  });

  it('`queue relay webhook history` returns lines with default limit 20', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    writeFileSync(
      join(tempDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${port}/relay-ws\nplugins: []\n`
    );
    mkdirSync(join(tempDir, '_secrets_'), { recursive: true });
    writeFileSync(
      join(tempDir, '_secrets_', '.env.local'),
      'QUEUE_RELAY_TOKEN=test-relay-token\n'
    );

    const result = await runCli(['relay', 'webhook', 'history']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2026-10-14');
    expect(result.stdout).toContain('push');
    expect(result.stdout).toContain('VERIFIED');

    // Check that listDeliveries was called with limit=20
    const historyReq = requests.find((r) => r.path.startsWith('/api/webhook-history'));
    expect(historyReq).toBeDefined();
    expect(historyReq?.path).toContain('limit=20');
  });

  it('`queue relay webhook history --limit 2 --event push` filters correctly', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    writeFileSync(
      join(tempDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${port}/relay-ws\nplugins: []\n`
    );
    mkdirSync(join(tempDir, '_secrets_'), { recursive: true });
    writeFileSync(
      join(tempDir, '_secrets_', '.env.local'),
      'QUEUE_RELAY_TOKEN=test-relay-token\n'
    );

    const result = await runCli(['relay', 'webhook', 'history', '--limit', '2', '--event', 'push']);

    expect(result.exitCode).toBe(0);

    // Check that the request had correct query params
    const historyReq = requests.find((r) => r.path.startsWith('/api/webhook-history'));
    expect(historyReq?.path).toContain('limit=2');
    expect(historyReq?.path).toContain('eventType=push');
  });

  it('`queue relay webhook history --payload` includes full JSON payloads', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    writeFileSync(
      join(tempDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${port}/relay-ws\nplugins: []\n`
    );
    mkdirSync(join(tempDir, '_secrets_'), { recursive: true });
    writeFileSync(
      join(tempDir, '_secrets_', '.env.local'),
      'QUEUE_RELAY_TOKEN=test-relay-token\n'
    );

    const result = await runCli(['relay', 'webhook', 'history', '--payload', '--limit', '1']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('org/repo');
    expect(result.stdout).toContain('alice');
  });

  it('`queue relay webhook history --json` outputs JSON array', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    writeFileSync(
      join(tempDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${port}/relay-ws\nplugins: []\n`
    );
    mkdirSync(join(tempDir, '_secrets_'), { recursive: true });
    writeFileSync(
      join(tempDir, '_secrets_', '.env.local'),
      'QUEUE_RELAY_TOKEN=test-relay-token\n'
    );

    const result = await runCli(['relay', 'webhook', 'history', '--json']);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].eventType).toBe('push');
  });

  it('returns exit 1 with error message on HTTP 401', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
    writeFileSync(
      join(tempDir, 'relay.yml'),
      `relayUrl: ws://127.0.0.1:${port}/relay-ws\nplugins: []\n`
    );
    mkdirSync(join(tempDir, '_secrets_'), { recursive: true });
    writeFileSync(
      join(tempDir, '_secrets_', '.env.local'),
      'QUEUE_RELAY_TOKEN=test-relay-token\n'
    );

    // Use wrong token to trigger 401
    const result = await runCli(['relay', 'webhook', 'list'], { QUEUE_RELAY_TOKEN: 'wrong-token' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('[fail]');
    expect(result.stderr).toContain('refused the token');
    expect(result.stderr).toContain('HTTP 401');
    // Token should never appear in error message
    expect(result.stderr).not.toContain('wrong-token');
  });
});
