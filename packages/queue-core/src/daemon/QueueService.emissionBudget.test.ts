import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createQueueService } from './QueueService.js';
import { MAX_ACTION_EMISSIONS_PER_ROOT } from '../actions/EmissionBudget.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { HistoryReader } from '../storage/HistoryReader.js';
import { listDlqEntries } from '../operations.js';
import { waitFor } from '../waitFor.testUtil.js';

// The hop cap bounds the depth of a chain, not its width: three emitters of the event they listen to made 364 events for one push.
// A budget per root event (the first push of the chain) bounds the total.
let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-budget-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-budget-project-'));
  vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const emitter = (name: string, to: string): string => `    - { type: action, name: ${name}, action: emit, with: { event: ${to} } }`;

function diagnostics(): Array<Record<string, unknown>> {
  const day = new Date().toISOString().slice(0, 10);
  return readFileSync(join(configDir, 'logs', `${day}.ndjson`), 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('per-root emission budget', () => {
  it('3 emitters of the event they listen to stop at the cap, with ONE diagnostic naming the root event, the subscriber and the cap', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), ['subscribers:', '  on.x:', emitter('e1', 'on.x'), emitter('e2', 'on.x'), emitter('e3', 'on.x'), ''].join('\n'));
    const service = createQueueService(configDir);

    const response = await service.commands.push({ event: 'on.x', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    await waitFor('the fan-out to stop', () => service.isIdle());

    // the root plus exactly the budget: without a budget the chain made 364 events
    const triggers = new HistoryReader(join(configDir, 'history')).read({ event: 'on.x' });
    expect(triggers).toHaveLength(1 + MAX_ACTION_EMISSIONS_PER_ROOT);
    const said = diagnostics().filter((record) => String(record['message']).includes('emission budget'));
    expect(said).toHaveLength(1);
    const message = String(said[0]!['message']);
    expect(message).toContain(response.eventId);
    expect(message).toMatch(/subscriber e\d/);
    expect(message).toContain(String(MAX_ACTION_EMISSIONS_PER_ROOT));
    // the refused emissions are permanent failures: in the DLQ at the first attempt
    const refused = listDlqEntries(configDir).filter((row) => /emission budget/.test(row.lastError));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((row) => row.attempts === 1)).toBe(true);
  });

  it('a normal chain (depth 5, width 1) is not affected', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), [
      'subscribers:', '  c0:', emitter('s0', 'c1'), '  c1:', emitter('s1', 'c2'), '  c2:', emitter('s2', 'c3'), '  c3:', emitter('s3', 'c4'), '  c4:', emitter('s4', 'c5'), '',
    ].join('\n'));
    const service = createQueueService(configDir);

    await service.commands.push({ event: 'c0', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    await waitFor('the chain to finish', () => service.isIdle());

    expect(new HistoryReader(join(configDir, 'history')).read({ event: 'c5' })).toHaveLength(1);
    expect(listDlqEntries(configDir)).toEqual([]);
    expect(diagnostics().some((record) => String(record['message']).includes('emission budget'))).toBe(false);
  });

  it('two separate pushes each get their own budget', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), ['subscribers:', '  r:', emitter('e1', 'leaf'), emitter('e2', 'leaf'), ''].join('\n'));
    const service = createQueueService(configDir);

    for (let i = 0; i < 2; i++) {
      await service.commands.push({ event: 'r', payload: {}, cwd: projectDir, protocol: '1.3.0' } as never);
    }
    await waitFor('the dispatches to finish', () => service.isIdle());

    expect(new HistoryReader(join(configDir, 'history')).read({ event: 'leaf' })).toHaveLength(4);
    expect(listDlqEntries(configDir)).toEqual([]);
  });
});
