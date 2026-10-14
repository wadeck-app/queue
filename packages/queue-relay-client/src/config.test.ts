import { describe, it, expect, afterEach } from 'vitest';
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

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it('returns null when relay.yml does not exist', () => {
    configDir = makeTmpDir();
    expect(loadRelayConfig(configDir)).toBeNull();
  });

  it('parses a valid relay.yml', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
token: test-token
plugins:
  - module: "@wadeck-app/plugin-github"
    subscriptions:
      - eventType: [pull_request, push]
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config).not.toBeNull();
    expect(config?.relayUrl).toBe('wss://relay.example.com/relay-ws');
    expect(config?.plugins).toHaveLength(1);
    expect(config?.plugins[0]?.module).toBe('@wadeck-app/plugin-github');
    expect(config?.plugins[0]?.subscriptions[0]?.eventType).toEqual(['pull_request', 'push']);
  });

  it('throws with a fix hint on invalid YAML', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), 'relayUrl: [unterminated', 'utf-8');
    expect(() => loadRelayConfig(configDir)).toThrow(/Failed to parse YAML/);
  });

  it('throws with a schema hint when relayUrl is missing', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), 'token: test-token\n', 'utf-8');
    expect(() => loadRelayConfig(configDir)).toThrow(/Invalid relay.yml/);
  });

  it('parses payloadMatch with string values', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: wss://relay.example.com/relay-ws
token: test-token
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
token: test-token
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
token: test-token
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
token: test-token
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
token: test-token
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('wss://relay.example.com/relay-ws');
  });

  it('accepts ws:// URL with localhost hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://localhost:1234/relay-ws
token: test-token
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('ws://localhost:1234/relay-ws');
  });

  it('accepts ws:// URL with 127.0.0.1 hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://127.0.0.1:1/relay-ws
token: test-token
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('ws://127.0.0.1:1/relay-ws');
  });

  it('accepts ws:// URL with [::1] hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://[::1]:1/relay-ws
token: test-token
`, 'utf-8');

    const config = loadRelayConfig(configDir);
    expect(config?.relayUrl).toBe('ws://[::1]:1/relay-ws');
  });

  it('rejects ws:// URL with non-localhost hostname', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: ws://relay.example.com/relay-ws
token: test-token
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: ws:\/\/relay\.example\.com\/relay-ws/
    );
  });

  it('rejects https:// URL', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: https://relay.example.com/relay-ws
token: test-token
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: https:\/\/relay\.example\.com\/relay-ws/
    );
  });

  it('rejects http:// URL with localhost', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: http://localhost/relay-ws
token: test-token
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: http:\/\/localhost\/relay-ws/
    );
  });

  it('rejects invalid URL', () => {
    configDir = makeTmpDir();
    writeFileSync(join(configDir, 'relay.yml'), `
relayUrl: not a url
token: test-token
`, 'utf-8');

    expect(() => loadRelayConfig(configDir)).toThrow(
      /relayUrl must use wss:\/\/ \(the relay token is sent as the first message and would travel in clear over ws:\/\/\); ws:\/\/ is only accepted for localhost\. Got: not a url/
    );
  });
});
