import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { createQueueService, type QueueService } from './QueueService.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionContext, ActionPlugin, ActionResult } from '../actions/ActionPlugin.js';
import { RetryScheduler } from '../dispatch/RetryScheduler.js';
import { readCatalog } from '../catalog/EventCatalog.js';
import { Wal, type WalEntry } from '../storage/Wal.js';
import { HistoryReader } from '../storage/HistoryReader.js';
import { listDlqEntries } from '../operations.js';
import { waitFor } from '../waitFor.testUtil.js';
import { HISTORY_MAX_AGE_DAYS } from '../storage/LogRetention.js';
import type { EventEnvelope } from '../types.js';

// The reserved `queue.` namespace (push protocol 1.5.0), `meta.origin` and the lazy `$eventRef` of the events the daemon builds, against the real service.

let configDir: string;
let projectDir: string;
let registryDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-ns-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-ns-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-ns-registry-'));
  // A failed dispatch would call orch to schedule a retry: nothing here needs a real one
  vi.spyOn(RetryScheduler, 'scheduleRetry').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [configDir, projectDir, registryDir]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

const wal = (): WalEntry[] => new Wal(join(configDir, 'wal.ndjson')).readAll();
const history = (): HistoryReader => new HistoryReader(join(configDir, 'history'));

/** Registers `projectDir` with this subscribers.yml; returns the project id. */
async function projectWith(yml: string): Promise<string> {
  const project = await addProject(registryDir, { name: 'app', path: projectDir });
  writeFileSync(join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml'), yml);
  return project.id;
}

/** A plugin `sink` that records every envelope it runs for and answers `behave(call)` (success by default). */
function sinkPlugin(behave: (call: number) => ActionResult = () => ({ success: true })): { plugin: ActionPlugin; seen: EventEnvelope[] } {
  const seen: EventEnvelope[] = [];
  const plugin: ActionPlugin = {
    name: 'sink',
    validate: () => undefined,
    run: (_config, envelope) => {
      seen.push(envelope);
      return Promise.resolve(behave(seen.length));
    },
  };
  return { plugin, seen };
}

function serviceWith(plugin: ActionPlugin): QueueService {
  return createQueueService(configDir, { registryDir, actions: createActionRegistry([plugin]) });
}

describe('the queue. namespace is reserved on every external entry', () => {
  it.each([
    ['queue.dlq.added'],
    ['queue.dlq.removed'],
    ['queue.anything'],
  ])('wire push of %s is rejected with an actionable reason, nothing is recorded or queued', async (event) => {
    const service = createQueueService(configDir);
    const response = await service.commands.push({ event, payload: {}, cwd: projectDir });
    expect(response.status).toBe('rejected');
    expect(response.eventId).toBeUndefined();
    expect(response.reason).toContain(`'${event}'`);
    expect(response.reason).toContain("'queue.' namespace");
    expect(response.reason).toContain('Fix:');
    expect(response.reason).toContain('was not recorded');
    expect(history().read({})).toEqual([]);
    expect(wal()).toEqual([]);
  });

  it('the rejection does not depend on the protocol the client claims', async () => {
    const service = createQueueService(configDir);
    for (const protocol of [undefined, '1.0.0', '1.4.0', '1.5.0']) {
      const response = await service.commands.push({ event: 'queue.x', payload: {}, cwd: projectDir, ...(protocol !== undefined && { protocol }) });
      expect(response.status, `protocol ${String(protocol)}`).toBe('rejected');
    }
  });

  it('a name that merely contains queue, or has no dot after it, is not reserved', async () => {
    const service = createQueueService(configDir);
    for (const event of ['queue', 'queuex.done', 'myapp.queue.done', 'Queue.x', 'onQueue.x']) {
      const response = await service.commands.push({ event, payload: {}, cwd: projectDir });
      expect(response.status, event).toBe('queued');
    }
  });

  it('a name that mixes the namespace with a before prefix is refused too', async () => {
    const service = createQueueService(configDir);
    expect((await service.commands.push({ event: 'queue.beforeX', payload: {}, cwd: projectDir })).status).toBe('rejected');
  });

  it('the emit action refuses a with.event in the namespace at load time (the subscriber fails for good with the reason)', async () => {
    const id = await projectWith(['subscribers:', '  onTicket:', '    - type: action', '      name: wake', '      action: emit', '      with:', '        event: queue.dlq.added', ''].join('\n'));
    const { plugin } = sinkPlugin();
    const service = serviceWith(plugin);
    await service.commands.push({ event: 'onTicket', payload: {}, cwd: projectDir });
    await waitFor('the subscriber to be given up', () => service.isIdle() && listDlqEntries(configDir).length === 1);
    const [entry] = listDlqEntries(configDir);
    expect(entry!.subscriberId).toBe(`${id}/wake`);
    expect(entry!.lastError).toContain("'with.event'");
    expect(entry!.lastError).toContain("'queue.' namespace");
    // and the emit action emitted nothing: the only queue.dlq.added is the daemon's own report of this very failure
    expect(history().read({ event: 'queue.dlq.added' }).map((e) => (e.payload as { entryId: string }).entryId)).toEqual([entry!.id]);
    expect(history().read({ event: 'queue.dlq.removed' })).toEqual([]);
  });

  it('an action whose context pushes a queue. event gets a permanent failure naming the action (runtime check of emitFrom)', async () => {
    let outcome: Awaited<ReturnType<ActionContext['push']>> | undefined;
    const sneaky: ActionPlugin = {
      name: 'sneaky',
      validate: () => undefined,
      run: async (_config, _envelope, context) => {
        outcome = await context.push({ event: 'queue.dlq.added', payload: { original: { $eventRef: 'whatever' } } });
        return { success: outcome.success, ...(outcome.error !== undefined && { error: outcome.error }), ...(outcome.permanent === true && { permanent: true as const }) };
      },
    };
    await projectWith(['subscribers:', '  onTicket:', '    - type: action', '      name: s', '      action: sneaky', ''].join('\n'));
    const service = serviceWith(sneaky);
    await service.commands.push({ event: 'onTicket', payload: {}, cwd: projectDir });
    await waitFor('the action to run', () => outcome !== undefined && service.isIdle());
    expect(outcome).toMatchObject({ success: false, permanent: true });
    expect(outcome!.error).toContain("'queue.' namespace");
    expect(outcome!.error).toContain('an action cannot produce it');
    // the action pushed nothing; the one event is the daemon's own report of the failed action (its payload carries no payload of the pushed one)
    const reports = history().read({ event: 'queue.dlq.added' });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.payload).toMatchObject({ event: 'onTicket', reason: 'permanent-failure' });
    expect(reports[0]!.causedBy).toBeDefined();
  });

  describe('register-events', () => {
    it('refuses the source "queue" from the wire and stores nothing', () => {
      const service = createQueueService(configDir);
      const response = service.commands['register-events']({ source: 'queue', events: [{ name: 'myapp.thing', description: 'd' }] });
      expect(response.status).toBe('rejected');
      expect(response.reason).toContain("source 'queue' is reserved");
      expect(response.reason).toContain('Fix:');
      expect(readCatalog(configDir).sources).toEqual([]);
    });

    it('refuses an event name in the namespace from another source, naming the index, and stores nothing (all or nothing)', () => {
      const service = createQueueService(configDir);
      const response = service.commands['register-events']({ source: 'myapp', events: [{ name: 'myapp.ok', description: 'd' }, { name: 'queue.dlq.added', description: 'd' }] });
      expect(response.status).toBe('rejected');
      expect(response.reason).toContain('events[1].name');
      expect(response.reason).toContain("'queue.' namespace");
      expect(readCatalog(configDir).sources).toEqual([]);
    });

    it('still registers a source and events that only contain the word queue', () => {
      const service = createQueueService(configDir);
      expect(service.commands['register-events']({ source: 'queueing', events: [{ name: 'queueing.done', description: 'd' }] })).toMatchObject({ status: 'registered', count: 1 });
    });
  });

  describe('replay of a queue.* trigger', () => {
    it('the helper behind `queue replay` and the dashboard names the event and says what to do instead', async () => {
      const { replayReservedProblem } = await import('../reservedEvents.js');
      expect(replayReservedProblem('onTicket', 'ev-1')).toBeUndefined();
      const problem = replayReservedProblem('queue.dlq.added', 'ev-1');
      expect(problem).toContain('ev-1');
      expect(problem).toContain("'queue.dlq.added'");
      expect(problem).toContain('cannot be replayed');
      expect(problem).toContain('Fix:');
    });

    it('and the push a replay would send is refused by the daemon anyway (defence in depth)', async () => {
      const service = createQueueService(configDir);
      const response = await service.commands.push({ event: 'queue.dlq.added', payload: {}, cwd: projectDir, replayOf: 'ev-1' });
      expect(response.status).toBe('rejected');
    });
  });
});

describe('meta.origin: set by the daemon only, carried unchanged', () => {
  const SUBSCRIBE = (event: string): string => ['subscribers:', `  ${event}:`, '    - type: action', '      name: sink', '      action: sink', ''].join('\n');

  it('a client cannot set it: an origin sent in the body or in a meta is ignored, on a normal event and on a claim of the daemon\'s name', async () => {
    await projectWith(SUBSCRIBE('onTicket'));
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);
    await service.commands.push({ event: 'onTicket', payload: {}, cwd: projectDir, origin: 'queue', meta: { origin: 'queue' } } as never);
    await waitFor('the subscriber to run', () => seen.length === 1 && service.isIdle());
    expect(seen[0]!.meta).not.toHaveProperty('origin');
    expect(wal()[0]!.meta).not.toHaveProperty('origin');
  });

  it('an event emitted by an action does not get it either', async () => {
    await projectWith(['subscribers:', '  onTicket:', '    - type: action', '      name: wake', '      action: emit', '      with:', '        event: agent.message', '  agent.message:', '    - type: action', '      name: sink', '      action: sink', ''].join('\n'));
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);
    await service.commands.push({ event: 'onTicket', payload: {}, cwd: projectDir });
    await waitFor('the emitted event to arrive', () => seen.length === 1 && service.isIdle());
    expect(seen[0]!.event).toBe('agent.message');
    expect(seen[0]!.meta).not.toHaveProperty('origin');
  });

  it('pushDaemonEvent files a queue. event with meta.origin "queue" (envelope, WAL), and refuses any other name', async () => {
    await projectWith(SUBSCRIBE('queue.dlq.added'));
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);
    const response = await service.pushDaemonEvent({ event: 'queue.dlq.added', payload: { n: 1 }, cwd: projectDir });
    expect(response.status).toBe('queued');
    await waitFor('the subscriber to run', () => seen.length === 1 && service.isIdle());
    expect(seen[0]!.meta.origin).toBe('queue');
    expect(wal()[0]!.meta.origin).toBe('queue');

    const refused = await service.pushDaemonEvent({ event: 'onTicket', payload: {}, cwd: projectDir });
    expect(refused.status).toBe('rejected');
    expect(refused.reason).toContain("must be named 'queue....'");
  });

  it('the origin survives retry, the DLQ and dlq-replay unchanged', async () => {
    await projectWith(SUBSCRIBE('queue.dlq.added'));
    // 1st run: transient failure (stays in the WAL, retried by hand); 2nd: permanent (goes to the DLQ); 3rd (dlq-replay): success
    const { plugin, seen } = sinkPlugin((call) => (call === 1 ? { success: false, error: 'later' } : call === 2 ? { success: false, error: 'never', permanent: true } : { success: true }));
    const service = serviceWith(plugin);
    await service.pushDaemonEvent({ event: 'queue.dlq.added', payload: { n: 1 }, cwd: projectDir });
    await waitFor('the first run', () => seen.length === 1 && service.isIdle());
    const failed = wal().find((entry) => entry.status === 'failed')!;
    expect(failed.meta.origin).toBe('queue');

    expect(await service.commands.retry({ eventId: failed.id })).toEqual({ status: 'ok' });
    await waitFor('the retry', () => seen.length === 2 && service.isIdle());
    expect(seen[1]!.meta.origin).toBe('queue');

    const [entry] = listDlqEntries(configDir);
    expect(entry!.meta.origin).toBe('queue');
    expect(await service.commands['dlq-replay']({ id: entry!.id })).toEqual({ status: 'ok' });
    await waitFor('the replay', () => seen.length === 3 && service.isIdle());
    expect(seen[2]!.meta.origin).toBe('queue');
  });
});

describe('lazy $eventRef through the real service (history lookup, WAL, dispatchers)', () => {
  /** The base event is pushed by a client first; returns its first-push id. */
  async function pushBase(service: QueueService, payload: unknown): Promise<string> {
    const response = await service.commands.push({ event: 'onTask.failed', payload, cwd: projectDir });
    expect(response.status).toBe('queued');
    return response.eventId!;
  }

  const EMIT_FROM_DLQ = [
    'subscribers:',
    '  queue.dlq.added:',
    '    - type: action',
    '      name: relay',
    '      action: emit',
    '      with:',
    '        event: task.problem',
    '        payload:',
    '          taskId: "{{ payload.original.taskId }}"',
    '          ref: "{{ payload.original }}"',
    '  task.problem:',
    '    - type: action',
    '      name: sink',
    '      action: sink',
    '',
  ].join('\n');

  it('an emit template on queue.dlq.added reads the field of the base event, and a terminal ref renders the reference JSON', async () => {
    await projectWith(EMIT_FROM_DLQ);
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);
    const baseId = await pushBase(service, { taskId: 'T-42', secret: 'S' });

    await service.pushDaemonEvent({ event: 'queue.dlq.added', payload: { entryId: 'x', original: { $eventRef: baseId } }, cwd: projectDir });
    await waitFor('the emitted event to arrive', () => seen.length === 1 && service.isIdle());

    expect(seen[0]!.payload).toEqual({ taskId: 'T-42', ref: JSON.stringify({ $eventRef: baseId }) });
    // the reference event itself carries no copy of the base payload
    expect(JSON.stringify(history().read({ event: 'queue.dlq.added' })[0]!.payload)).not.toContain('T-42');
  });

  it('the same subscriber on a FORGED event (a wire push cannot use the name; a normal event with the same payload shape) reads nothing of the base event', async () => {
    await projectWith(EMIT_FROM_DLQ.replace('queue.dlq.added:', 'onForged:'));
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);
    const baseId = await pushBase(service, { taskId: 'T-42' });

    await service.commands.push({ event: 'onForged', payload: { original: { $eventRef: baseId } }, cwd: projectDir });
    await waitFor('the emitted event to arrive', () => seen.length === 1 && service.isIdle());

    expect(seen[0]!.payload).toEqual({ taskId: '', ref: JSON.stringify({ $eventRef: baseId }) });
  });

  it('a forged origin on a normal event does not make it resolvable either', async () => {
    await projectWith(EMIT_FROM_DLQ.replace('queue.dlq.added:', 'onForged:'));
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);
    const baseId = await pushBase(service, { taskId: 'T-42' });

    await service.commands.push({ event: 'onForged', payload: { original: { $eventRef: baseId } }, cwd: projectDir, origin: 'queue', meta: { origin: 'queue' } } as never);
    await waitFor('the emitted event to arrive', () => seen.length === 1 && service.isIdle());

    expect(seen[0]!.payload).toMatchObject({ taskId: '' });
  });

  it('a base event that is gone: the delivery fails for good, naming the field, the reference and the real limits (and no payload value)', async () => {
    await projectWith(EMIT_FROM_DLQ);
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);

    await service.pushDaemonEvent({ event: 'queue.dlq.added', payload: { original: { $eventRef: 'no-such-event' }, reason: 'SENSITIVE' }, cwd: projectDir });
    await waitFor('the delivery to be given up', () => service.isIdle() && listDlqEntries(configDir).length === 1);

    const [entry] = listDlqEntries(configDir);
    expect(seen).toEqual([]);
    expect(entry!.lastError).toContain('with.payload.taskId');
    expect(entry!.lastError).toContain('no-such-event');
    expect(entry!.lastError).toContain(`${HISTORY_MAX_AGE_DAYS} days`);
    expect(entry!.lastError).toContain('queue history --event-id no-such-event');
    expect(entry!.lastError).not.toContain('SENSITIVE');
  });

  it('a cli subscriber on queue.dlq.added receives the base field as a real argument (child process)', async () => {
    const out = join(projectDir, 'argv.json');
    const script = join(projectDir, 'write-argv.js');
    writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));");
    const command = `"${process.execPath}" "${script}" "${out}" {{ payload.original.taskId }} "{{ payload.original.title }}"`;
    await projectWith(['subscribers:', '  queue.dlq.added:', '    - type: cli', '      name: show', `      command: ${JSON.stringify(command)}`, ''].join('\n'));
    const service = createQueueService(configDir, { registryDir });
    const baseId = await pushBase(service, { taskId: 'T-42', title: 'Two words' });

    await service.pushDaemonEvent({ event: 'queue.dlq.added', payload: { original: { $eventRef: baseId } }, cwd: projectDir });
    await waitFor('the child process to write its arguments', () => existsSync(out) && service.isIdle());

    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['T-42', 'Two words']);
  });

  it('the same cli subscriber on a forged normal event gets empty arguments, and the child starts', async () => {
    const out = join(projectDir, 'argv.json');
    const script = join(projectDir, 'write-argv.js');
    writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));");
    const command = `"${process.execPath}" "${script}" "${out}" "[{{ payload.original.taskId }}]"`;
    await projectWith(['subscribers:', '  onForged:', '    - type: cli', '      name: show', `      command: ${JSON.stringify(command)}`, ''].join('\n'));
    const service = createQueueService(configDir, { registryDir });
    const baseId = await pushBase(service, { taskId: 'T-42' });

    await service.commands.push({ event: 'onForged', payload: { original: { $eventRef: baseId } }, cwd: projectDir });
    await waitFor('the child process to write its arguments', () => existsSync(out) && service.isIdle());

    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['[]']);
  });

  it('a before* event is never resolvable (the synchronous dispatcher gets the resolver but the policy refuses by name)', async () => {
    await projectWith(['subscribers:', '  beforeThing:', '    - type: action', '      name: sink', '      action: sink', ''].join('\n'));
    const { plugin, seen } = sinkPlugin();
    const service = serviceWith(plugin);
    const response = await service.commands.push({ event: 'beforeThing', payload: { original: { $eventRef: 'x' } }, cwd: projectDir });
    expect(response.status).toBe('dispatched');
    expect(seen[0]!.meta).not.toHaveProperty('origin');
  });
});
