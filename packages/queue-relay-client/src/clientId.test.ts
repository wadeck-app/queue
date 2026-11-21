import { describe, it, expect } from 'vitest';
import { clientIdentity, RELAY_CLIENT_MAX_LENGTH } from './clientId.js';

describe('clientIdentity', () => {
  it('names the program, its version, the host and the platform, and the User-Agent is the program and its version', () => {
    expect(clientIdentity('2026.11.21-314-e480bf1c', 'MacBook-Pro.local', 'darwin')).toEqual({
      userAgent: 'queue-cli/2026.11.21-314-e480bf1c',
      client: 'queue-cli/2026.11.21-314-e480bf1c host=MacBook-Pro os=darwin',
    });
  });

  it('keeps only the first label of a fully qualified host name', () => {
    expect(clientIdentity('1.0.0', 'wadeck-pc.home.example.org', 'win32').client).toBe('queue-cli/1.0.0 host=wadeck-pc os=win32');
  });

  it('drops the os when it does not fit whole, never the host', () => {
    const host = 'h'.repeat(RELAY_CLIENT_MAX_LENGTH - 'queue-cli/1.0.0 host='.length);
    const { client } = clientIdentity('1.0.0', host, 'darwin');
    expect(client).toBe(`queue-cli/1.0.0 host=${host}`);
    expect(client).toHaveLength(RELAY_CLIENT_MAX_LENGTH);
  });

  it('cuts a host name too long for the clip, and never exceeds it', () => {
    const { client } = clientIdentity('2026.11.21-314-e480bf1c', 'x'.repeat(200), 'darwin');
    expect(client).toHaveLength(RELAY_CLIENT_MAX_LENGTH);
    expect(client.startsWith('queue-cli/2026.11.21-314-e480bf1c host=xxx')).toBe(true);
  });

  it('removes control characters from every part', () => {
    const { client, userAgent } = clientIdentity('1.0\n.0', 'ho\u0000st\r\n', 'li\tnux');
    expect(client).toBe('queue-cli/1.0.0 host=host os=linux');
    expect(userAgent).toBe('queue-cli/1.0.0');
  });

  it('an empty host name leaves out the host rather than sending "host="', () => {
    expect(clientIdentity('1.0.0', '', 'linux').client).toBe('queue-cli/1.0.0 os=linux');
  });
});
