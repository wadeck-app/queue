import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canResolveRef, EventRefError, RefResolver, type RefLookup } from './refResolver.js';
import { CliTransport } from './CliTransport.js';
import { AsyncDispatcher } from './AsyncDispatcher.js';
import { SyncDispatcher } from './SyncDispatcher.js';
import { ActionTransport } from './ActionTransport.js';
import { PayloadFilter } from './PayloadFilter.js';
import { CommandTemplateError, substituteToken, tokenizeTemplate } from './commandTemplate.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import { emitAction } from '../actions/emit.js';
import { ActionTemplateError, renderActionTemplate } from '../actions/renderActionTemplate.js';
import type { ActionContext, ActionPlugin } from '../actions/ActionPlugin.js';
import type { DispatchResult } from './DispatchResult.js';
import type { WalEntry } from '../storage/Wal.js';
import type { QueueLogWriter } from '../storage/EventLogger.js';
import type { HistoryWriter } from '../storage/HistoryLog.js';
import type { EventEnvelope, EventMeta, ResolvedSubscriber } from '../types.js';
import { HISTORY_MAX_AGE_DAYS, HISTORY_MAX_TOTAL_BYTES } from '../storage/LogRetention.js';

const IS_WINDOWS = process.platform === 'win32';
const NODE = process.execPath;

/** The envelope the daemon builds for a dead-letter fact; `meta` and `event` can be overridden to build a forged one. */
function dlqEnvelope(payload: unknown, overrides: { event?: string; meta?: EventMeta } = {}): EventEnvelope {
  return {
    id: 'evt-dlq',
    timestamp: '2026-01-01T00:00:00.000Z',
    event: overrides.event ?? 'queue.dlq.added',
    payload,
    meta: overrides.meta ?? { eventId: 'evt-dlq', origin: 'queue' },
  };
}

const REF = { $eventRef: 'base-1' };
const BASE_PAYLOAD = { taskId: 7, title: 'Fix it', nested: { k: 'deep' }, again: { $eventRef: 'base-2' } };

/** A history that holds `base-1` only, counting how often it is asked. */
function history(): { lookup: Mock<RefLookup>; resolver: RefResolver } {
  const lookup = vi.fn<RefLookup>((eventId) => (eventId === 'base-1' ? { payload: BASE_PAYLOAD } : undefined));
  return { lookup, resolver: new RefResolver(lookup) };
}

describe('canResolveRef: the one policy', () => {
  const daemonMeta: EventMeta = { origin: 'queue' };

  it.each([
    ['queue.dlq.added', ['original'], true],
    ['queue.dlq.removed', ['original'], true],
    ['queue.dlq.added', ['x'], false],
    ['queue.dlq.added', ['x', 'original'], false],
    ['queue.dlq.added', ['original', 'deeper'], false],
    ['queue.dlq.added', [], false],
    ['queue.dlq.other', ['original'], false],
    ['queue.dlq.added.more', ['original'], false],
    ['queue.custom', ['original'], false],
    ['onTicket', ['original'], false],
    ['Queue.dlq.added', ['original'], false],
  ] as const)('an event built by the daemon: %s at %j gives %s', (event, walked, expected) => {
    expect(canResolveRef({ event, meta: daemonMeta }, walked)).toBe(expected);
  });

  it.each([
    ['no origin', {}],
    ['another origin value', { origin: 'relay' } as unknown as EventMeta],
    ['a truthy non-string', { origin: true } as unknown as EventMeta],
  ])('refuses an envelope without meta.origin "queue" (%s), even for queue.dlq.added at original', (_label, meta) => {
    expect(canResolveRef({ event: 'queue.dlq.added', meta }, ['original'])).toBe(false);
  });
});

describe('RefResolver', () => {
  it('loads the base event lazily: nothing is read until a placeholder needs the reference', () => {
    const { lookup, resolver } = history();
    resolver.forEnvelope(dlqEnvelope({ original: REF }));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('answers the payload of the base event, one lookup per reference id and per dispatch', () => {
    const { lookup, resolver } = history();
    const resolve = resolver.forEnvelope(dlqEnvelope({ original: REF }));
    expect(resolve('base-1', ['original'])).toBe(BASE_PAYLOAD);
    expect(resolve('base-1', ['original'])).toBe(BASE_PAYLOAD);
    expect(lookup).toHaveBeenCalledTimes(1);
    // a second dispatch has its own memory
    resolver.forEnvelope(dlqEnvelope({ original: REF }))('base-1', ['original']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('keeps the object as data (never looks up) where the policy refuses', () => {
    const { lookup, resolver } = history();
    const forged = resolver.forEnvelope({ event: 'onTicket', meta: { origin: 'queue' } });
    const result = forged('base-1', ['original']);
    expect(typeof result).toBe('symbol');
    expect(resolver.forEnvelope(dlqEnvelope({}))('base-1', ['elsewhere'])).toBe(result);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a base event that is gone: a permanent error that names the reference and the REAL retention limits, never a value', () => {
    const { resolver } = history();
    const resolve = resolver.forEnvelope(dlqEnvelope({ original: { $eventRef: 'gone-9' } }));
    let caught: unknown;
    try {
      resolve('gone-9', ['original']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EventRefError);
    const error = caught as EventRefError;
    expect(error.permanent).toBe(true);
    expect(error.refId).toBe('gone-9');
    expect(error.message).toContain('gone-9');
    expect(error.message).toContain(`${HISTORY_MAX_AGE_DAYS} days`);
    expect(error.message).toContain(`${Math.round(HISTORY_MAX_TOTAL_BYTES / (1024 * 1024))} MB`);
    expect(error.message).toContain('queue history --event-id gone-9');
  });

  it('a null reference (legacy dead-letter entry) is a permanent error that says there is no base event', () => {
    const { lookup, resolver } = history();
    expect(() => resolver.forEnvelope(dlqEnvelope({ original: { $eventRef: null } }))(null, ['original'])).toThrow(/refers to no base event/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('an unreadable history is a retryable error (not permanent) with the reason', () => {
    const resolver = new RefResolver(() => { throw new Error('EACCES: history'); });
    let caught: unknown;
    try {
      resolver.forEnvelope(dlqEnvelope({}))('base-1', ['original']);
    } catch (err) {
      caught = err;
    }
    expect((caught as EventRefError).permanent).toBe(false);
    expect((caught as EventRefError).message).toContain('EACCES: history');
  });
});

describe('cli templates (substituteToken) with the resolver', () => {
  const render = (template: string, envelope: EventEnvelope, resolver: RefResolver): string[] =>
    tokenizeTemplate(template).map((token) => substituteToken(token, envelope.payload, { resolveRef: resolver.forEnvelope(envelope) }).text);

  it('{{ payload.original.taskId }} is a field of the base event', () => {
    const { resolver } = history();
    expect(render('{{ payload.original.taskId }} {{ original.nested.k }}', dlqEnvelope({ original: REF }), resolver)).toEqual(['7', 'deep']);
  });

  it('a terminal {{ payload.original }} renders the reference JSON as it is and loads nothing', () => {
    const { lookup, resolver } = history();
    expect(render('{{ payload.original }}', dlqEnvelope({ original: REF }), resolver)).toEqual(['{"$eventRef":"base-1"}']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('memoization: two placeholders of one dispatch read the history once', () => {
    const { lookup, resolver } = history();
    const envelope = dlqEnvelope({ original: REF });
    const resolveRef = resolver.forEnvelope(envelope);
    const [token] = tokenizeTemplate('{{ original.taskId }}-{{ original.title }}');
    expect(substituteToken(token!, envelope.payload, { resolveRef }).text).toBe('7-Fix it');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a base payload that holds a reference itself is not resolved twice', () => {
    const { lookup, resolver } = history();
    expect(render('{{ original.again.x }}|{{ original.again }}', dlqEnvelope({ original: REF }), resolver)).toEqual(['|{"$eventRef":"base-2"}']);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalledWith('base-2');
  });

  it('a field outside original is never resolved, even on a daemon-built queue.dlq.added event', () => {
    const { lookup, resolver } = history();
    expect(render('{{ extra.taskId }}|{{ extra.visible }}', dlqEnvelope({ original: REF, extra: { ...REF, visible: 'own data' } }), resolver)).toEqual(['|own data']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a missing base event: a permanent template error with the field, the reference and the limits, and no payload value', () => {
    const { resolver } = history();
    const envelope = dlqEnvelope({ original: { $eventRef: 'gone-9' }, secret: 'TOP-SECRET-VALUE' });
    let caught: unknown;
    try {
      render('{{ payload.original.taskId }}', envelope, resolver);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandTemplateError);
    const message = (caught as Error).message;
    expect(message).toContain("payload field 'original.taskId'");
    expect(message).toContain('gone-9');
    expect(message).toContain(`${HISTORY_MAX_AGE_DAYS} days`);
    expect(message).toContain('MB');
    expect(message).not.toContain('TOP-SECRET-VALUE');
  });
});

describe('forged references are plain data', () => {
  const forged = { x: { $eventRef: 'base-1', secret: 'own secret' }, original: { $eventRef: 'base-1', taskId: 'own taskId' } };

  it.each([
    ['a normal event', 'onTicket.created', { eventId: 'e' } as EventMeta],
    ['a normal event that claims origin queue in its meta (forged)', 'onTicket.created', { origin: 'queue' } as EventMeta],
    ['a queue.dlq.added event without meta.origin', 'queue.dlq.added', {} as EventMeta],
  ])('%s: a {"$eventRef"} in the payload is never followed (cli and action templates read the object itself)', (_label, event, meta) => {
    const { lookup, resolver } = history();
    const envelope: EventEnvelope = { id: 'e', timestamp: 't', event, payload: forged, meta };
    const resolveRef = resolver.forEnvelope(envelope);
    const cli = tokenizeTemplate('{{ x.secret }}|{{ x.taskId }}|{{ original.taskId }}').map((token) => substituteToken(token, forged, { resolveRef }).text);
    expect(cli).toEqual(['own secret||own taskId']);
    expect(renderActionTemplate('{{ payload.x.secret }}|{{ payload.x.taskId }}|{{ payload.original.taskId }}', envelope, 'with.payload.t', { resolveRef })).toBe('own secret||own taskId');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('without a resolver nothing is followed either', () => {
    const envelope = dlqEnvelope({ original: REF });
    expect(renderActionTemplate('{{ payload.original.taskId }}', envelope, 'with.payload.t')).toBe('');
  });
});

describe('action templates (renderActionTemplate and emit) with the resolver', () => {
  it('{{ payload.original.taskId }} is a field of the base event; a terminal ref renders the reference JSON', () => {
    const { resolver } = history();
    const envelope = dlqEnvelope({ original: REF });
    const resolveRef = resolver.forEnvelope(envelope);
    expect(renderActionTemplate('{{ payload.original.taskId }} / {{ payload.original.nested.k }}', envelope, 'with.payload.t', { resolveRef })).toBe('7 / deep');
    expect(renderActionTemplate('{{ payload.original }}', envelope, 'with.payload.t', { resolveRef })).toBe('{"$eventRef":"base-1"}');
  });

  it('a missing base event: ActionTemplateError with the field, the placeholder, the reference and the limits', () => {
    const { resolver } = history();
    const envelope = dlqEnvelope({ original: { $eventRef: 'gone-9' }, secret: 'TOP-SECRET-VALUE' });
    let caught: unknown;
    try {
      renderActionTemplate('{{ payload.original.taskId }}', envelope, 'with.payload.text', { resolveRef: resolver.forEnvelope(envelope) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActionTemplateError);
    const message = (caught as Error).message;
    expect(message).toContain('with.payload.text');
    expect(message).toContain('{{ payload.original.taskId }}');
    expect(message).toContain('gone-9');
    expect(message).toContain(`${HISTORY_MAX_AGE_DAYS} days`);
    expect(message).not.toContain('TOP-SECRET-VALUE');
  });

  it('emit renders its payload through ctx.resolveRef, loading the base event once', async () => {
    const { lookup, resolver } = history();
    const envelope = dlqEnvelope({ original: REF });
    const push = vi.fn().mockResolvedValue({ success: true, eventId: 'new' });
    const context: ActionContext = { signal: new AbortController().signal, subscriber: 's', push, resolveRef: resolver.forEnvelope(envelope) };
    const result = await emitAction.run({ event: 'task.failed', payload: { id: '{{ payload.original.taskId }}', title: '{{ payload.original.title }}' } }, envelope, context);
    expect(result.success).toBe(true);
    expect(push).toHaveBeenCalledWith({ event: 'task.failed', payload: { id: '7', title: 'Fix it' } });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('emit with a missing base event fails for good with the field and the reference', async () => {
    const { resolver } = history();
    const envelope = dlqEnvelope({ original: { $eventRef: 'gone-9' } });
    const push = vi.fn();
    const result = await emitAction.run({ event: 'task.failed', payload: { id: '{{ payload.original.taskId }}' } }, envelope, { signal: new AbortController().signal, subscriber: 's', push, resolveRef: resolver.forEnvelope(envelope) });
    expect(result).toMatchObject({ success: false, permanent: true });
    expect(result.error).toContain('with.payload.id');
    expect(result.error).toContain('gone-9');
    expect(push).not.toHaveBeenCalled();
  });

  it('emit with an unreadable history fails but is retried (not permanent)', async () => {
    const resolver = new RefResolver(() => { throw new Error('EBUSY'); });
    const envelope = dlqEnvelope({ original: REF });
    const result = await emitAction.run({ event: 'task.failed', payload: { id: '{{ payload.original.taskId }}' } }, envelope, { signal: new AbortController().signal, subscriber: 's', push: vi.fn(), resolveRef: resolver.forEnvelope(envelope) });
    expect(result.success).toBe(false);
    expect(result.permanent).toBeUndefined();
    expect(result.error).toContain('EBUSY');
  });

  it('ActionTransport hands the plugin a ctx.resolveRef bound to the envelope of the run (one lookup for the whole run)', async () => {
    const { lookup, resolver } = history();
    let seen: ActionContext | undefined;
    // Replaces the version that called resolveRef after the run had returned: a finished run is superseded and its resolveRef now throws, so the calls are made during the run
    const answers: unknown[] = [];
    const plugin: ActionPlugin = {
      name: 'probe',
      validate: () => undefined,
      run: (_config, _envelope, context) => {
        seen = context;
        if (context.resolveRef !== undefined) {
          answers.push(context.resolveRef('base-1', ['original']), context.resolveRef('base-1', ['original']));
        }
        return Promise.resolve({ success: true });
      },
    };
    const transport = new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => Promise.resolve({ success: true }) }), resolver);
    await transport.dispatch('probe', {}, dlqEnvelope({ original: REF }), 1000, 'sub');
    expect(seen?.resolveRef).toBeTypeOf('function');
    expect(answers).toEqual([BASE_PAYLOAD, BASE_PAYLOAD]);
    expect(lookup).toHaveBeenCalledTimes(1);
    // without a resolver the context is the host's own
    seen = undefined;
    await new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => Promise.resolve({ success: true }) })).dispatch('probe', {}, dlqEnvelope({}), 1000, 'sub');
    expect(seen).toBeDefined();
    expect(seen!.resolveRef).toBeUndefined();
  });
});

describe('what is NOT resolved: when filters, stdin, http bodies (templates only)', () => {
  it('a when: filter reads the reference object itself, never the base payload', () => {
    const envelope = dlqEnvelope({ original: REF });
    expect(PayloadFilter.evaluate('payload.original.taskId=7', envelope).matched).toBe(false);
    expect(PayloadFilter.evaluate('payload.original.$eventRef=base-1', envelope).matched).toBe(true);
  });

  it('stdin of a cli subscriber is the envelope as it is, reference included', async () => {
    const lookup = vi.fn<RefLookup>(() => ({ payload: BASE_PAYLOAD }));
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
    const dispatcher = new SyncDispatcher(noLogger(), noHistory(), undefined, new RefResolver(lookup));
    await dispatcher.dispatch([cliSub('echo ok')], dlqEnvelope({ original: REF }), 1000);
    // the envelope given to the transport is untouched (it writes it to stdin as JSON)
    expect((spy.mock.calls[0]![1] as EventEnvelope).payload).toEqual({ original: REF });
    expect(lookup).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

function noLogger(): QueueLogWriter {
  return { logDispatch: vi.fn(), logFilterMiss: vi.fn(), logDiagnostic: vi.fn() };
}

function noHistory(): HistoryWriter {
  return { logTrigger: vi.fn(), logOutcome: vi.fn(), logFiltered: vi.fn() };
}

function cliSub(command: string, event = 'queue.dlq.added'): ResolvedSubscriber {
  return { subscriberId: 's1', name: 's1', file: 'subscribers.yml', scope: 'global', event, type: 'cli', command, retries: 1, timeoutMs: 5000, backoff: 'exponential' };
}

describe('both dispatchers hand the resolver to the cli transport (the templates of the command)', () => {
  it('SyncDispatcher: the callback given to the transport follows the base event of its envelope', async () => {
    const { lookup, resolver } = history();
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
    await new SyncDispatcher(noLogger(), noHistory(), undefined, resolver).dispatch([cliSub('echo {{ original.taskId }}')], dlqEnvelope({ original: REF }), 1000);
    const resolveRef = spy.mock.calls[0]![6];
    expect(resolveRef).toBeTypeOf('function');
    expect(resolveRef!('base-1', ['original'])).toBe(BASE_PAYLOAD);
    expect(lookup).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('AsyncDispatcher: the callback given to the transport follows the base event of its envelope', async () => {
    const { lookup, resolver } = history();
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
    const walEntry: WalEntry = { id: 'w1', timestamp: 't', event: 'queue.dlq.added', payload: { original: REF }, meta: { origin: 'queue' }, subscriberId: 's1', status: 'pending', attempts: 0 };
    const dispatcher = new AsyncDispatcher(vi.fn(), vi.fn(), noLogger(), noHistory(), undefined, resolver);
    await dispatcher.dispatch([cliSub('echo {{ original.taskId }}')], dlqEnvelope({ original: REF }), new Map([['s1', walEntry]]));
    const resolveRef = spy.mock.calls[0]![6];
    expect(resolveRef).toBeTypeOf('function');
    expect(resolveRef!('base-1', ['original'])).toBe(BASE_PAYLOAD);
    expect(lookup).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('without a resolver the transport gets none (nothing is followed)', async () => {
    const spy = vi.spyOn(CliTransport.prototype, 'dispatch').mockResolvedValue({ success: true, stdout: '', durationMs: 1 });
    await new SyncDispatcher(noLogger(), noHistory()).dispatch([cliSub('echo ok')], dlqEnvelope({}), 1000);
    expect(spy.mock.calls[0]![6]).toBeUndefined();
    spy.mockRestore();
  });
});

describe('CliTransport: a real child process receives the base event field as its argument', () => {
  let workDir: string;
  let printer: string;
  const transport = new CliTransport();

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'queue-refresolver-'));
    printer = join(workDir, 'printer.js');
    writeFileSync(printer, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const argvOf = (result: DispatchResult): string[] => {
    if (!result.success) {
      throw new Error(`dispatch failed: ${result.error ?? '?'}`);
    }
    return (JSON.parse(result.stdout ?? '') as { argv: string[] }).argv;
  };

  function run(command: string, envelope: EventEnvelope, resolver: RefResolver | undefined): Promise<DispatchResult> {
    return transport.dispatch(command, envelope, 30_000, workDir, undefined, 'notify', resolver?.forEnvelope(envelope));
  }

  it('node printer with {{ payload.original.* }}: the base fields arrive verbatim, a terminal ref as JSON', async () => {
    const { lookup, resolver } = history();
    const result = await run(`"${NODE}" "${printer}" {{ payload.original.taskId }} "T: {{ payload.original.title }}" {{ payload.original }}`, dlqEnvelope({ original: REF }), resolver);
    expect(argvOf(result)).toEqual(['7', 'T: Fix it', '{"$eventRef":"base-1"}']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a forged reference (no origin) reaches the program as plain data: nothing of another event leaks', async () => {
    const { lookup, resolver } = history();
    const envelope: EventEnvelope = { id: 'e', timestamp: 't', event: 'onTicket', payload: { x: { $eventRef: 'base-1' } }, meta: {} };
    const result = await run(`"${NODE}" "${printer}" a {{ payload.x.taskId }} b`, envelope, resolver);
    expect(argvOf(result)).toEqual(['a', '', 'b']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a missing base event is a permanent failure that names the subscriber, the field and the reference; the program is not started', async () => {
    const { resolver } = history();
    const result = await run(`"${NODE}" "${printer}" {{ payload.original.taskId }}`, dlqEnvelope({ original: { $eventRef: 'gone-9' } }), resolver);
    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("subscriber 'notify'");
    expect(result.error).toContain("payload field 'original.taskId'");
    expect(result.error).toContain('gone-9');
    expect(result.error).toContain('queue history --event-id gone-9');
  });

  it('an unreadable history is a failure that is retried (not permanent)', async () => {
    const resolver = new RefResolver(() => { throw new Error('EBUSY'); });
    const result = await run(`"${NODE}" "${printer}" {{ payload.original.taskId }}`, dlqEnvelope({ original: REF }), resolver);
    expect(result.success).toBe(false);
    expect(result.permanent).toBeUndefined();
    expect(result.error).toContain('EBUSY');
  });

  it.skipIf(!IS_WINDOWS)('Windows: through a .cmd shim the base field arrives as one argument too', async () => {
    const shimDir = join(workDir, 'shims');
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, 'shim.cmd'), `@echo off\r\n"${NODE}" "${printer}" %*\r\n`);
    const { resolver } = history();
    const result = await transport.dispatch('./shim {{ payload.original.title }}', dlqEnvelope({ original: REF }), 30_000, shimDir, undefined, 'notify', resolver.forEnvelope(dlqEnvelope({ original: REF })));
    expect(argvOf(result)).toEqual(['Fix it']);
  });
});
