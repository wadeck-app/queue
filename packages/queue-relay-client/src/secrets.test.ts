import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseDotEnv, resolveRelayToken } from './secrets.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';

describe('secrets', () => {
  describe('parseDotEnv', () => {
    it('parses simple KEY=VALUE lines', () => {
      const result = parseDotEnv('FOO=bar\nBAZ=qux');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('ignores blank lines', () => {
      const result = parseDotEnv('FOO=bar\n\nBAZ=qux\n');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('ignores comment lines starting with #', () => {
      const result = parseDotEnv('FOO=bar\n# this is a comment\nBAZ=qux');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('strips optional export prefix', () => {
      const result = parseDotEnv('export FOO=bar\nBAZ=qux');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('strips matching single quotes from value', () => {
      const result = parseDotEnv("FOO='bar'\nBAZ='qux'");
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('strips matching double quotes from value', () => {
      const result = parseDotEnv('FOO="bar"\nBAZ="qux"');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('handles = inside the value', () => {
      const result = parseDotEnv('FOO=key=value\nBAZ=a=b=c');
      expect(result).toEqual({ FOO: 'key=value', BAZ: 'a=b=c' });
    });

    it('ignores malformed lines without =', () => {
      const result = parseDotEnv('FOO=bar\nmalformedline\nBAZ=qux');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('trims whitespace around keys and values', () => {
      const result = parseDotEnv('  FOO  =  bar  \n  BAZ  =  qux  ');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('does not expand variables', () => {
      const result = parseDotEnv('FOO=$BAR\nBAR=value');
      expect(result).toEqual({ FOO: '$BAR', BAR: 'value' });
    });

    it('handles no multiline values', () => {
      const result = parseDotEnv('FOO=bar\nBAZ=qux');
      expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });
  });

  describe('resolveRelayToken', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-relay-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('says the secrets file exists but has no QUEUE_RELAY_TOKEN line when it is missing from the file', async () => {
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      await fs.writeFile(path.join(secretsDir, '.env.local'), '# no token here\nOTHER_KEY=value\n');

      let message = '';
      try {
        resolveRelayToken({ configDir: tmpDir, env: {} });
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).toContain('No relay token found');
      expect(message).toContain(path.join(secretsDir, '.env.local'));
      expect(message).toContain('exists but has no QUEUE_RELAY_TOKEN line');
      expect(message).not.toContain('value');
    });

    it('returns QUEUE_RELAY_TOKEN from env when set (highest priority)', async () => {
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      await fs.writeFile(
        path.join(secretsDir, '.env.local'),
        'QUEUE_RELAY_TOKEN=from-file\n'
      );

      const result = resolveRelayToken({
        configDir: tmpDir,
        relayYmlToken: 'from-yaml',
        env: { QUEUE_RELAY_TOKEN: 'from-env' },
      });

      expect(result).toEqual({
        token: 'from-env',
        source: 'env',
      });
    });

    it('ignores empty QUEUE_RELAY_TOKEN env var and falls back to secrets file', async () => {
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      await fs.writeFile(
        path.join(secretsDir, '.env.local'),
        'QUEUE_RELAY_TOKEN=from-file\n'
      );

      const result = resolveRelayToken({
        configDir: tmpDir,
        relayYmlToken: 'from-yaml',
        env: { QUEUE_RELAY_TOKEN: '' },
      });

      expect(result).toEqual({
        token: 'from-file',
        source: 'secrets',
      });
    });

    it('reads QUEUE_RELAY_TOKEN from secrets file when env is not set', async () => {
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      await fs.writeFile(
        path.join(secretsDir, '.env.local'),
        'QUEUE_RELAY_TOKEN=from-file\n'
      );

      const result = resolveRelayToken({
        configDir: tmpDir,
        relayYmlToken: 'from-yaml',
        env: {},
      });

      expect(result).toEqual({
        token: 'from-file',
        source: 'secrets',
      });
    });

    it('respects QUEUE_SECRETS_DIR env var override', async () => {
      const customSecretsDir = path.join(tmpDir, 'custom-secrets');
      await fs.mkdir(customSecretsDir, { recursive: true });
      await fs.writeFile(
        path.join(customSecretsDir, '.env.local'),
        'QUEUE_RELAY_TOKEN=from-custom\n'
      );

      const result = resolveRelayToken({
        configDir: tmpDir,
        relayYmlToken: 'from-yaml',
        env: { QUEUE_SECRETS_DIR: customSecretsDir },
      });

      expect(result).toEqual({
        token: 'from-custom',
        source: 'secrets',
      });
    });

    it('falls back to relay.yml token when no env or secrets file', async () => {
      const result = resolveRelayToken({
        configDir: tmpDir,
        relayYmlToken: 'from-yaml',
        env: {},
      });

      expect(result).toEqual({
        token: 'from-yaml',
        source: 'relay.yml',
      });
    });

    it('throws error when no token found anywhere', async () => {
      const fn = () =>
        resolveRelayToken({
          configDir: tmpDir,
          relayYmlToken: undefined,
          env: {},
        });

      expect(fn).toThrow();
      try {
        fn();
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('No relay token found');
        expect(msg).toContain('_secrets_');
        expect(msg).toContain('.env.local');
        expect(msg).toContain('QUEUE_RELAY_TOKEN=');
      }
    });

    it('error message does not contain token value', async () => {
      const fn = () =>
        resolveRelayToken({
          configDir: tmpDir,
          relayYmlToken: undefined,
          env: {},
        });

      expect(fn).toThrow();
      try {
        fn();
      } catch (err) {
        const msg = (err as Error).message;
        // Ensure no actual token value is in the message (a real token would look like a long string)
        // The message should contain placeholder "<token>" not an actual token
        expect(msg).toContain('<token>');
      }
    });

    it('detects legacy .env.local next to _secrets_/ and throws', async () => {
      const legacyPath = path.join(tmpDir, '.env.local');
      await fs.writeFile(legacyPath, 'QUEUE_RELAY_TOKEN=legacy-token\n');

      expect(() =>
        resolveRelayToken({
          configDir: tmpDir,
          relayYmlToken: undefined,
          env: {},
        })
      ).toThrow(
        /\.env\.local found at the legacy location.*must live under _secrets_/
      );
    });

    it('legacy error message includes the exact path', async () => {
      const legacyPath = path.join(tmpDir, '.env.local');
      await fs.writeFile(legacyPath, 'QUEUE_RELAY_TOKEN=legacy-token\n');

      expect(() =>
        resolveRelayToken({
          configDir: tmpDir,
          relayYmlToken: undefined,
          env: {},
        })
      ).toThrow(legacyPath);
    });

    it('ignores legacy error if secrets file exists', async () => {
      const legacyPath = path.join(tmpDir, '.env.local');
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      await fs.writeFile(legacyPath, 'QUEUE_RELAY_TOKEN=legacy-token\n');
      await fs.writeFile(
        path.join(secretsDir, '.env.local'),
        'QUEUE_RELAY_TOKEN=new-token\n'
      );

      const result = resolveRelayToken({
        configDir: tmpDir,
        relayYmlToken: undefined,
        env: {},
      });

      expect(result).toEqual({
        token: 'new-token',
        source: 'secrets',
      });
    });

    it('throws when secrets file is unreadable (EACCES)', async () => {
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      const envFile = path.join(secretsDir, '.env.local');
      await fs.writeFile(envFile, 'QUEUE_RELAY_TOKEN=token\n');

      const mockReadFile = vi.fn(() => {
        const err = new Error('Permission denied') as any;
        err.code = 'EACCES';
        throw err;
      });

      expect(() =>
        resolveRelayToken({
          configDir: tmpDir,
          relayYmlToken: undefined,
          env: {},
          readFile: mockReadFile,
        })
      ).toThrow(/Permission denied/);
    });

    it('error message for unreadable file includes path and error code', async () => {
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      const envFile = path.join(secretsDir, '.env.local');
      await fs.writeFile(envFile, 'QUEUE_RELAY_TOKEN=token\n');

      const mockReadFile = vi.fn(() => {
        const err = new Error('Permission denied') as any;
        err.code = 'EACCES';
        throw err;
      });

      expect(() =>
        resolveRelayToken({
          configDir: tmpDir,
          relayYmlToken: undefined,
          env: {},
          readFile: mockReadFile,
        })
      ).toThrow(/EACCES/);
    });

    it('error for unreadable file does not contain token value', async () => {
      const secretsDir = path.join(tmpDir, '_secrets_');
      await fs.mkdir(secretsDir, { recursive: true });
      const envFile = path.join(secretsDir, '.env.local');
      await fs.writeFile(envFile, 'QUEUE_RELAY_TOKEN=super-secret-token-value\n');

      const mockReadFile = vi.fn(() => {
        const err = new Error('Permission denied') as any;
        err.code = 'EACCES';
        throw err;
      });

      const fn = () =>
        resolveRelayToken({
          configDir: tmpDir,
          relayYmlToken: undefined,
          env: {},
          readFile: mockReadFile,
        });

      expect(fn).toThrow();
      try {
        fn();
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain('super-secret-token-value');
      }
    });
  });
});
