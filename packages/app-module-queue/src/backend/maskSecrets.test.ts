import { describe, it, expect } from 'vitest';
import { maskUrl, maskCommand } from './maskSecrets.js';

describe('maskUrl', () => {
  it('keeps the origin and a short word as first path segment, hides the rest of the path', () => {
    expect(maskUrl('https://hooks.slack.com/services/T000/B000/XXXXXXXX')).toBe('https://hooks.slack.com/services/***');
  });

  it('hides a first path segment that is not a plain word (a bot token)', () => {
    expect(maskUrl('https://api.telegram.org/bot123456:AAH-secret/sendMessage')).toBe('https://api.telegram.org/***');
  });

  it('keeps a url without secret as it is', () => {
    expect(maskUrl('https://example.test/hook')).toBe('https://example.test/hook');
    expect(maskUrl('http://localhost:8080/')).toBe('http://localhost:8080/');
  });

  it('removes the userinfo and the fragment, and masks the values of the query but keeps its keys', () => {
    const masked = maskUrl('https://user:pw0rd@example.test/hook?token=abc123&mode=x#frag');
    expect(masked).toBe('https://example.test/hook?token=***&mode=***');
    expect(masked).not.toContain('pw0rd');
  });

  it('masks the whole value when it is not a parsable url, without leaking it', () => {
    expect(maskUrl('not a url secret-123')).toBe('***');
  });

  it('keeps {{ }} placeholders readable in a url that does not parse as absolute', () => {
    expect(maskUrl('{{ hookUrl }}')).toBe('{{ hookUrl }}');
  });
});

describe('maskCommand', () => {
  it('leaves a command without secret unchanged', () => {
    expect(maskCommand('echo foo --bar baz')).toBe('echo foo --bar baz');
  });

  it('masks the value of a curl header, quoted or not', () => {
    expect(maskCommand('curl -H "Authorization: Bearer abc.def" https://example.test/x')).toBe('curl -H "Authorization: ***" https://example.test/x');
    expect(maskCommand("curl --header 'X-Api-Key: s3cr3t' https://example.test/x")).toBe("curl --header 'X-Api-Key: ***' https://example.test/x");
  });

  it('masks a bearer token and basic credentials wherever they are', () => {
    expect(maskCommand('tool --auth "Bearer abc123"')).not.toContain('abc123');
    expect(maskCommand('curl -u admin:hunter2 https://example.test')).not.toContain('hunter2');
    expect(maskCommand('curl --user admin:hunter2 https://example.test')).not.toContain('hunter2');
  });

  it('masks the value of a secret-looking option, in the --name=value and --name value forms', () => {
    expect(maskCommand('deploy --token=abc123 --region eu')).toBe('deploy --token=*** --region eu');
    expect(maskCommand('deploy --api-key abc123 --region eu')).toBe('deploy --api-key *** --region eu');
    expect(maskCommand('deploy --password "a b c"')).toBe('deploy --password ***');
  });

  it('masks the value of a secret-looking NAME=value assignment', () => {
    expect(maskCommand('API_TOKEN=abc123 run')).toBe('API_TOKEN=*** run');
  });

  it('masks userinfo and query values of a url inside the command', () => {
    const masked = maskCommand('curl https://user:pw0rd@example.test/hook?token=abc123');
    expect(masked).not.toContain('pw0rd');
    expect(masked).not.toContain('abc123');
  });

  it('masks well-known token shapes', () => {
    expect(maskCommand('git push https://x/ ghp_abcdefghijklmnopqrstuvwxyz0123456789')).not.toContain('ghp_abc');
    expect(maskCommand('notify xoxb-1234-5678-abcdef')).not.toContain('xoxb-1234');
  });
});
