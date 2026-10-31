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

describe('ActionTransport', () => {
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
    expect(contextFor).toHaveBeenCalledWith(envelope);
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
      await transportWith(() => new Promise<ActionResult>((_resolve, reject) => setTimeout(() => reject(new Error('late')), 60))).dispatch('probe', {}, envelope, 20, 'sub');
      await new Promise((resolve) => setTimeout(resolve, 120));
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
