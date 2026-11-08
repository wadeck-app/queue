/**
 * The history and event-log writes of a push are not fatal: a history folder that cannot be written (here: a regular file where the folder should be)
 * used to fail the push with HTTP 500 before anything was recorded (logTrigger ran before the WAL write). The push goes on, the failure is said once per cause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService, type QueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin } from '../actions/ActionPlugin.js';
import { Wal } from '../storage/Wal.js';
import { waitFor } from '../waitFor.testUtil.js';

let configDir: string;
let projectDir: string;
let registryDir: string;
let runs: string[];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-logfail-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-logfail-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-logfail-registry-'));
  runs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [configDir, projectDir, registryDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const plugin: ActionPlugin = {
  name: 'record',
  validate: () => undefined,
  run: (config) => {
    runs.push(String(config['tag'] ?? ''));
    return Promise.resolve({ success: true });
  },
};

const SUBSCRIBERS = [
  'subscribers:',
  '  onA:',
  '    - { type: action, name: one, action: record, with: { tag: one } }',
  '    - { type: action, name: filtered, action: record, when: "payload.n=2", with: { tag: never } }',
  '',
].join('\n');

function start(): QueueService {
  writeFileSync(join(configDir, 'subscribers.yml'), SUBSCRIBERS);
  return createQueueService(configDir, { registryDir, actions: createActionRegistry([plugin]) });
}

const push = (service: QueueService, event = 'onA') => service.commands.push({ event, payload: { n: 1 }, cwd: projectDir, protocol: '1.3.0' } as never);

/** A regular file where the folder is expected: every write below it fails (ENOTDIR). */
const breakFolder = (name: 'history' | 'logs'): void => writeFileSync(join(configDir, name), 'not a folder');

const said = (service: QueueService): string[] => vi.mocked(service.eventLogger.logDiagnostic).mock.calls.map((call) => call[0].message);

describe('a history that cannot be written does not fail the push', () => {
  it('on* event: the push answers queued, the WAL entry is recorded, the subscriber runs, and the failure is said once per cause', async () => {
    breakFolder('history');
    const service = start();
    vi.spyOn(service.eventLogger, 'logDiagnostic');
    const first = await push(service);
    const second = await push(service);

    expect(first).toMatchObject({ status: 'queued', subscriberCount: 1 });
    expect(second).toMatchObject({ status: 'queued', subscriberCount: 1 });
    await waitFor('both deliveries', () => runs.length === 2 && service.isIdle());
    expect(new Wal(join(configDir, 'wal.ndjson')).readAll()).toHaveLength(2);
    const historyWarnings = said(service).filter((message) => message.includes('history record'));
    expect(historyWarnings.length).toBeGreaterThanOrEqual(1);
    expect(historyWarnings[0]).toContain('Check that nothing locks the logs and history folders');
    // one sentence per cause: the second push (same failure) did not repeat it
    expect(new Set(historyWarnings).size).toBe(historyWarnings.length);
  });

  it('before* event: the chain still runs and answers dispatched', async () => {
    breakFolder('history');
    writeFileSync(join(configDir, 'subscribers.yml'), ['subscribers:', '  beforeA:', '    - { type: action, name: gate, action: record, with: { tag: gate } }', ''].join('\n'));
    const service = createQueueService(configDir, { registryDir, actions: createActionRegistry([plugin]) });
    vi.spyOn(service.eventLogger, 'logDiagnostic');
    const response = await push(service, 'beforeA');
    expect(response.status).toBe('dispatched');
  });

  it('a daemon log that throws on the record of a filtered subscriber does not fail the push either', async () => {
    const service = start();
    vi.spyOn(service.eventLogger, 'logDiagnostic');
    vi.spyOn(service.eventLogger, 'logFilterMiss').mockImplementation(() => {
      throw new Error('EBUSY: locked');
    });
    const response = await push(service);
    expect(response).toMatchObject({ status: 'queued', subscriberCount: 1 });
    expect(said(service).some((message) => message.includes('filter log record') && message.includes('EBUSY'))).toBe(true);
  });

  it('with the daemon log broken too: still queued, the cause goes to stderr', async () => {
    breakFolder('history');
    breakFolder('logs');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const service = start();
    const response = await push(service);
    expect(response).toMatchObject({ status: 'queued', subscriberCount: 1 });
    await waitFor('the delivery', () => runs.length === 1 && service.isIdle());
    // the daemon log is what cannot be written: its own fallback says so on stderr, and the push is not affected
    const stderr = write.mock.calls.map(([text]) => String(text)).join('');
    expect(stderr).toContain('[queue] EventLogger: could not write');
  });
});
