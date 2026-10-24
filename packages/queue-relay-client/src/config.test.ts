import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRelayConfig } from './config.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-relay-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadRelayConfig', () => {
  let configDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Save original env and set test token
    originalEnv = {};
    ['QUEUE_RELAY_TOKEN', 'QUEUE_SECRETS_DIR'].forEach((key) => {
      originalEnv[key] = process.env[key];
    });
    process.env['QUEUE_RELAY_TOKEN'] = 'test-token-env';
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    // Restore original env
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it('returns null when relay.yml does not exist', () => {
    configDir = makeTmpDir();
    expect(loadRelayConfig(configDir)).toBeNull();
  });

  it('parses a valid relay.yml without token (resolved from env)', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [pull_request, push]
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config).not.toBeNull();
    expect(config?.relayUrl).toBe('wss://relay.example.com/relay-ws');
    expect(config?.token).toBe('test-token-env');
    expect(config?.tokenSource).toBe('env');
    expect(config?.plugins).toHaveLength(1);
    expect(config?.plugins[0]?.module).toBe('@wadeck-app/plugin-github');
    expect(config?.plugins[0]?.subscriptions[0]?.eventType).toEqual(['pull_request', 'push']);
  });

  it('still parses relay.yml with token field (backward compat, warns deprecated)', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
token: test-token-yaml
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [pull_request, push]
`, 'utf-8');

    // Clear env token to fall back to relay.yml
    delete process.env['QUEUE_RELAY_TOKEN'];

    const config = loadRelayConfig(configDir);
    expect(config).not.toBeNull();
    expect(config?.token).toBe('test-token-yaml');
    expect(config?.tokenSource).toBe('relay.yml');
  });

  it('throws with a fix hint on invalid YAML', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), 'relayUrl: [unterminated', 'utf-8');
    expect(() => loadRelayConfig(configDir)).toThrow(/Failed to parse YAML/);
  });

  it('throws with a schema hint when relayUrl is missing', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), 'plugins: []\n', 'utf-8');
    expect(() => loadRelayConfig(configDir)).toThrow(/Invalid relay.yml/);
  });

  it('throws when token cannot be resolved', () => {
    configDir = makeTmpDir();
    delete process.env['QUEUE_RELAY_TOKEN'];
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
plugins: []
`, 'utf-8');
    expect(() => loadRelayConfig(configDir)).toThrow(/No relay token found/);
  });

  it('parses payloadMatch with string values', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [push]
        payloadMatch:
          action: opened
          repository.full_name: "owner/repo"
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.plugins[0]?.subscriptions[0]?.payloadMatch).toEqual({
      action: 'opened',
      'repository.full_name': 'owner/repo',
    });
  });

  it('parses payloadMatch with number values', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [push]
        payloadMatch:
          pull_request.number: 42
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.plugins[0]?.subscriptions[0]?.payloadMatch).toEqual({
      'pull_request.number': 42,
    });
  });

  it('parses payloadMatch with boolean values', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [push]
        payloadMatch:
          pull_request.draft: false
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.plugins[0]?.subscriptions[0]?.payloadMatch).toEqual({
      'pull_request.draft': false,
    });
  });

  it('rejects payloadMatch with empty key', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [push]
        payloadMatch:
          "": "value"
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(/Invalid relay.yml/);
  });

  it('accepts wss:// URL for any hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('wss://relay.example.com/relay-ws');
  });

  it('accepts ws:// URL with localhost hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://localhost:1234/relay-ws
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('ws://localhost:1234/relay-ws');
  });

  it('accepts ws:// URL with 127.0.0.1 hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://127.0.0.1:1/relay-ws
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('ws://127.0.0.1:1/relay-ws');
  });

  it('accepts ws:// URL with [::1] hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://[::1]:1/relay-ws
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('ws://[::1]:1/relay-ws');
  });

  it('rejects ws:// URL with non-localhost hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://relay.example.com/relay-ws
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: ws:\/\/relay\.example\.com\/relay-ws/
    );
  });

  it('rejects https:// URL', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: https://relay.example.com/relay-ws
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: https:\/\/relay\.example\.com\/relay-ws/
    );
  });

  it('rejects http:// URL with localhost', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: http://localhost/relay-ws
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: http:\/\/localhost\/relay-ws/
    );
  });

  it('rejects invalid URL', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: not a url
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: not a url/
    );
  });
});
