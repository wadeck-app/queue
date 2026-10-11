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
});
