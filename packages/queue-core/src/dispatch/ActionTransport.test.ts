import { describe, it, expect, vi } from 'vitest';
import { ActionTransport } from './ActionTransport.js';
import { createActionRegistry } from '../actions/createActionRegistry.js';
import type { ActionPlugin, ActionResult } from '../actions/ActionPlugin.js';
import type { EventEnvelope } from '../types.js';

const envelope: EventEnvelope = { id: 'e', timestamp: '2026-01-01T00:00:00.000Z', event: 'onX', payload: {}, meta: {} };

function transportWith(run: ActionPlugin['run']): ActionTransport {
  const plugin: ActionPlugin = { name: 'probe', validate: () => undefined, run };
  return new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => Promise.resolve({ success: true }) }));
}

describe('ActionTransport: a run that was superseded cannot act any more', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** A transport whose plugin ignores the signal and pushes late; returns what reached the host's push and what was said. */
  function lateWorld(pushAfterMs: number, attemptsWithOneTransport = 1): { run: () => Promise<void>; pushes: string[]; said: string[]; late: Array<Promise<unknown>>; signals: AbortSignal[] } {
    const pushes: string[] = [];
    const said: string[] = [];
    const late: Array<Promise<unknown>> = [];
    const signals: AbortSignal[] = [];
    let attempt = 0;
    const plugin: ActionPlugin = {
      name: 'probe',
      validate: () => undefined,
      run: async (_config, _envelope, context) => {
        const mine = ++attempt;
        signals.push(context.signal);
        // the plugin ignores the signal on purpose: the first attempt is slow, the retry is fast
        if (mine === 1) {
          late.push(sleep(pushAfterMs).then(() => context.push({ event: 'agent.message', payload: { attempt: mine } })));
          await sleep(pushAfterMs * 10);
          return { success: true };
        }
        const result = await context.push({ event: 'agent.message', payload: { attempt: mine } });
        return { success: result.success };
      },
    };
    const transport = new ActionTransport(
      createActionRegistry([plugin]),
      () => ({ push: (request) => { pushes.push(`${(request.payload as { attempt: number }).attempt}`); return Promise.resolve({ success: true }); } }),
      undefined,
      (message) => said.push(message),
    );
    return {
      run: async () => {
        for (let i = 0; i < attemptsWithOneTransport + 1; i++) {
          await transport.dispatch('probe', {}, envelope, 20, 'sub');
        }
      },
      pushes, said, late, signals,
    };
  }

  it('a late ctx.push of the attempt that timed out is refused (superseded) and the retry emits once', async () => {
    const world = lateWorld(80);
    await world.run();
    // the retry ran (attempt 2, within its own timeout) and pushed; attempt 1 pushes late, after both dispatches
    const lateResults = await Promise.all(world.late);
    expect(world.pushes).toEqual(['2']);
    expect(lateResults[0]).toMatchObject({ success: false, error: expect.stringMatching(/^superseded:/) as unknown as string });
    expect((lateResults[0] as { permanent?: boolean }).permanent).not.toBe(true);
  });

  it('says the refused late push in a diagnostic naming the action and the subscriber', async () => {
    const world = lateWorld(80);
    await world.run();
    await Promise.all(world.late);
    expect(world.said).toHaveLength(1);
    expect(world.said[0]).toContain("action 'probe'");
    expect(world.said[0]).toContain('subscriber sub');
    expect(world.said[0]).toContain('agent.message');
  });

  it('aborts the signal of the attempt that timed out before the dispatch returns, so the retry can be scheduled safely', async () => {
    const world = lateWorld(80);
    let aborted: boolean | undefined;
    await (async () => {
      // one dispatch only
      const plugin: ActionPlugin = { name: 'slow', validate: () => undefined, run: async (_c, _e, context) => { world.signals.push(context.signal); await sleep(200); return { success: true }; } };
      const transport = new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => Promise.resolve({ success: true }) }));
      const result = await transport.dispatch('slow', {}, envelope, 20, 'sub');
      aborted = world.signals[0]!.aborted;
      expect(result.error).toMatch(/^timeout after/);
    })();
    expect(aborted).toBe(true);
  });

  it('a push made after the plugin returned (not awaited) is refused too', async () => {
    let escaped: Promise<unknown> | undefined;
    const pushes: string[] = [];
    const plugin: ActionPlugin = {
      name: 'probe',
      validate: () => undefined,
      run: (_c, _e, context) => { escaped = sleep(30).then(() => context.push({ event: 'x', payload: {} })); return Promise.resolve({ success: true }); },
    };
    await new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => { pushes.push('x'); return Promise.resolve({ success: true }); } })).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(await escaped).toMatchObject({ success: false, error: expect.stringMatching(/^superseded:/) as unknown as string });
    expect(pushes).toEqual([]);
  });

  it('a late resolveRef throws instead of reading the history for a dead run', async () => {
    let escaped: (() => unknown) | undefined;
    const plugin: ActionPlugin = { name: 'probe', validate: () => undefined, run: (_c, _e, context) => { escaped = () => context.resolveRef!('ref', []); return Promise.resolve({ success: true }); } };
    const refs = { forEnvelope: () => () => 'payload' } as unknown as ConstructorParameters<typeof ActionTransport>[2];
    const transport = new ActionTransport(createActionRegistry([plugin]), () => ({ push: () => Promise.resolve({ success: true }) }), refs);
    await transport.dispatch('probe', {}, envelope, 1000, 'sub');
    expect(escaped).toThrow(/superseded/);
  });
});

describe('ActionTransport', () => {
  it('prints a timeout under one second in milliseconds, not as 0s', async () => {
    const result = await transportWith(() => new Promise<ActionResult>(() => undefined)).dispatch('probe', {}, envelope, 30, 'sub');
    expect(result.error).toMatch(/^timeout after 30ms /);
    const seconds = await transportWith(() => new Promise<ActionResult>(() => undefined)).dispatch('probe', {}, envelope, 1200, 'sub');
    expect(seconds.error).toMatch(/^timeout after 1.2s /);
  }, 10_000);

  it('hands the plugin the id of the subscriber it runs for', async () => {
    let seen: string | undefined;
    await transportWith((_c, _e, context) => { seen = context.subscriber; return Promise.resolve({ success: true }); }).dispatch('probe', {}, envelope, 1000, 'project-1/wake');
    expect(seen).toBe('project-1/wake');
  });

  it('keeps the detail of a failed run', async () => {
    const result = await transportWith(() => Promise.resolve({ success: false, error: 'no', detail: 'sent 2 of 3' })).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(result).toMatchObject({ success: false, detail: 'sent 2 of 3' });
  });

  it('reports a success with an EMPTY stdout (the synchronous dispatcher parses stdout as JSON) and the detail apart', async () => {
    const result = await transportWith(() => Promise.resolve({ success: true, detail: 'did it' })).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(result).toMatchObject({ success: true, stdout: '', detail: 'did it' });
    expect(result.stderr).toBeUndefined();
  });

  it('hands the plugin its configuration, the envelope and a context bound to that envelope', async () => {
    const run = vi.fn<ActionPlugin['run']>().mockResolvedValue({ success: true });
    const contextFor = vi.fn(() => ({ push: () => Promise.resolve({ success: true }) }));
    const plugin: ActionPlugin = { name: 'probe', validate: () => undefined, run };
    await new ActionTransport(createActionRegistry([plugin]), contextFor).dispatch('probe', { a: 1 }, envelope, 1000, 'sub');
    expect(contextFor).toHaveBeenCalledWith(envelope, 'sub');
    expect(run).toHaveBeenCalledWith({ a: 1 }, envelope, expect.objectContaining({ push: expect.any(Function) as unknown as () => void }));
  });

  it('passes a permanent failure through, and a plain failure stays retryable', async () => {
    const permanent = await transportWith(() => Promise.resolve({ success: false, error: 'bad value', permanent: true })).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(permanent).toMatchObject({ success: false, error: 'bad value', permanent: true });
    const plain = await transportWith(() => Promise.resolve({ success: false, error: 'try later' })).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(plain.permanent).toBeUndefined();
  });

  it('honours the timeout when the plugin never answers: a retryable failure starting with "timeout"', async () => {
    const result = await transportWith(() => new Promise<ActionResult>(() => undefined)).dispatch('probe', {}, envelope, 30, 'sub');
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/^timeout after/);
    expect(result.permanent).toBeUndefined();
  });

  it('turns a throw (async or synchronous) into a retryable failure that names the action, never a permanent one', async () => {
    const asyncThrow = await transportWith(() => Promise.reject(new Error('boom'))).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(asyncThrow).toMatchObject({ success: false });
    expect(asyncThrow.error).toContain("action 'probe' threw");
    expect(asyncThrow.error).toContain('boom');
    expect(asyncThrow.permanent).toBeUndefined();
    const syncThrow = await transportWith(() => { throw new Error('sync boom'); }).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(syncThrow.error).toContain('sync boom');
    expect(syncThrow.permanent).toBeUndefined();
  });

  it('does not leave an unhandled rejection when a plugin fails after the timeout', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let failLate: (error: Error) => void = () => undefined;
      const result = await transportWith(() => new Promise<ActionResult>((_resolve, reject) => { failLate = reject; })).dispatch('probe', {}, envelope, 20, 'sub');
      expect(result.success).toBe(false);
      // The plugin fails only now, after the dispatch gave up on it; Node reports an unhandled rejection before the next check phase, so one setImmediate turn is enough
      failLate(new Error('late'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('fails for good on an unknown action, listing the available ones', async () => {
    const result = await transportWith(() => Promise.resolve({ success: true })).dispatch('nope', {}, envelope, 1000, 'sub');
    expect(result).toMatchObject({ success: false, permanent: true });
    expect(result.error).toContain('Available actions: emit, probe');
  });

  it('reports a plugin that returns something else than a result as a failure', async () => {
    const result = await transportWith((() => Promise.resolve(undefined)) as unknown as ActionPlugin['run']).dispatch('probe', {}, envelope, 1000, 'sub');
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('bug in the plugin');
  });
});
