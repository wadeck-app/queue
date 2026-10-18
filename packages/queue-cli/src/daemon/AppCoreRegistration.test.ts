import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerWithAppCore } from './AppCoreRegistration.js';

let configDir: string;
let logs: { source: string; message: string }[];
const logDiagnostic = (entry: { source: string; message: string }) => logs.push(entry);
const originalFetch = global.fetch;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-core-registration-'));
  logs = [];
  process.env['APP_CORE_CONFIG_DIR'] = configDir;
  // queue-cli's vitest config points APP_CORE_PORT at an unused port to keep tests away from a real
  // app-core; these tests mock fetch and assert the default port, so they start from a clean variable.
  delete process.env['APP_CORE_PORT'];
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  delete process.env['APP_CORE_CONFIG_DIR'];
  delete process.env['APP_CORE_PORT'];
  global.fetch = originalFetch;
});

describe('registerWithAppCore', () => {
  it('posts to /api/modules/register with the default port and does not fall back on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    await registerWithAppCore('queue', '/abs/path/manifest.json', logDiagnostic);

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4850/api/modules/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'queue', source: { type: 'file', path: '/abs/path/manifest.json' } }),
    });
    expect(existsSync(join(configDir, 'modules', 'queue.json'))).toBe(false);
    expect(logs).toEqual([]);
  });

  it('respects APP_CORE_PORT override', async () => {
    process.env['APP_CORE_PORT'] = '9999';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    await registerWithAppCore('queue', '/abs/path/manifest.json', logDiagnostic);

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9999/api/modules/register', expect.anything());
  });

  it('logs once (no retry) when app-core responds with a non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = fetchMock as unknown as typeof fetch;

    await registerWithAppCore('queue', '/abs/path/manifest.json', logDiagnostic);

    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('500');
    expect(existsSync(join(configDir, 'modules', 'queue.json'))).toBe(false);
  });

  it('falls back to writing the config-dir pickup file when app-core is unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await registerWithAppCore('queue', '/abs/path/manifest.json', logDiagnostic);

    const written = JSON.parse(readFileSync(join(configDir, 'modules', 'queue.json'), 'utf-8'));
    expect(written).toEqual({ id: 'queue', source: { type: 'file', path: '/abs/path/manifest.json' } });
    expect(logs).toEqual([]);
  });

  it('logs once (no retry) when both app-core and the fallback file write fail', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = fetchMock as unknown as typeof fetch;
    // A regular file where a directory is expected makes mkdirSync(recursive) throw ENOTDIR --
    // a real filesystem failure, not a contrived error path.
    const blockingFile = join(configDir, 'blocking-file');
    writeFileSync(blockingFile, 'not a directory');
    process.env['APP_CORE_CONFIG_DIR'] = blockingFile;

    await registerWithAppCore('queue', '/abs/path/manifest.json', logDiagnostic);

    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('could not register module "queue"');
  });
});
