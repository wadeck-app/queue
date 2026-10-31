import { describe, it, expect, vi } from 'vitest';
import { emitAction } from './emit.js';
import type { ActionContext, ActionPushResult } from './ActionPlugin.js';
import type { EventEnvelope } from '../types.js';

const envelope: EventEnvelope = {
  id: 'wal-id',
  timestamp: '2026-01-02T03:04:05.000Z',
  event: 'onTicket.created',
  payload: { title: 'Bug', who: { name: 'Ada' }, secret: 'abc\0def' },
  meta: { eventId: 'first-push' },
};

function context(result: ActionPushResult = { success: true, eventId: 'new-id' }): ActionContext & { push: ReturnType<typeof vi.fn> } {
  return { push: vi.fn().mockResolvedValue(result) };
}

describe('emit: validate', () => {
  const validate = (config: Record<string, unknown>): string | undefined => emitAction.validate(config, { event: 'onX' });

  it('accepts a literal event and an optional payload of templates', () => {
    expect(validate({ event: 'agent.message' })).toBeUndefined();
    expect(validate({ event: 'agent.message', payload: { text: '{{ payload.title }}', nested: { list: ['{{ id }}', 1, true] } } })).toBeUndefined();
  });

  it.each([
    [{}, /'with.event' is required/],
    [{ event: '' }, /'with.event' is required/],
    [{ event: 5 }, /'with.event' is required/],
    [{ event: 'agent.{{ payload.kind }}' }, /literal event name, not a template/],
    [{ event: 'agent.*' }, /not a pattern/],
    [{ event: 'agent.>' }, /not a pattern/],
    [{ event: 'agent..message' }, /dot-separated segments/],
    [{ event: 'agent message' }, /dot-separated segments/],
    [{ event: 'a', extra: 1 }, /unknown field 'extra'/],
    [{ event: 'a', payload: 'text' }, /must be a mapping/],
    [{ event: 'a', payload: ['x'] }, /must be a mapping/],
    [{ event: 'a', payload: { text: '{{ text }}' } }, /payload\.text/],
    [{ event: 'a', payload: { deep: { list: ['{{ x }}'] } } }, /with\.payload\.deep\.list\[0\]/],
  ])('refuses %j', (config, message) => {
    expect(validate(config)).toMatch(message);
  });

  it('emits() gives the event name of a valid configuration only', () => {
    expect(emitAction.emits?.({ event: 'agent.message' })).toBe('agent.message');
    expect(emitAction.emits?.({ event: 'agent.*' })).toBeUndefined();
    expect(emitAction.emits?.({})).toBeUndefined();
  });
});

describe('emit: run', () => {
  it('renders the payload leaves (strings only, keys kept) and pushes the literal event', async () => {
    const ctx = context();
    const result = await emitAction.run(
      { event: 'agent.message', payload: { text: 'New {{ payload.title }} by {{ payload.who.name }}', ref: '{{ id }}', count: 3, list: ['{{ event }}'] } },
      envelope,
      ctx,
    );
    expect(ctx.push).toHaveBeenCalledWith({ event: 'agent.message', payload: { text: 'New Bug by Ada', ref: 'first-push', count: 3, list: ['onTicket.created'] } });
    expect(result).toMatchObject({ success: true, detail: expect.stringContaining('new-id') as unknown as string });
  });

  it('pushes an empty payload when there is none', async () => {
    const ctx = context();
    await emitAction.run({ event: 'ping' }, envelope, ctx);
    expect(ctx.push).toHaveBeenCalledWith({ event: 'ping', payload: {} });
  });

  it('keeps a __proto__ key of the configuration as a plain own property', async () => {
    const ctx = context();
    const config = JSON.parse('{"event":"x","payload":{"__proto__":{"polluted":"{{ event }}"}}}') as Record<string, unknown>;
    await emitAction.run(config, envelope, ctx);
    const pushed = (ctx.push.mock.calls[0]![0] as { payload: object }).payload;
    expect(Object.getPrototypeOf(pushed)).toBe(Object.prototype);
    expect(Object.hasOwn(pushed, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('fails for good, naming the field and not the value, when a value cannot be rendered (NUL)', async () => {
    const ctx = context();
    const result = await emitAction.run({ event: 'x', payload: { text: '{{ payload.secret }}' } }, envelope, ctx);
    expect(result).toMatchObject({ success: false, permanent: true });
    expect(result.error).toContain('with.payload.text');
    expect(result.error).not.toContain('abc');
    expect(ctx.push).not.toHaveBeenCalled();
  });

  it('fails for good on a configuration that did not pass validation (the plugin is the last line)', async () => {
    const ctx = context();
    const result = await emitAction.run({ event: 'a.*' }, envelope, ctx);
    expect(result).toMatchObject({ success: false, permanent: true });
    expect(ctx.push).not.toHaveBeenCalled();
  });

  it('passes the refusal of the push on, permanent or not', async () => {
    expect(await emitAction.run({ event: 'x' }, envelope, context({ success: false, error: 'loop guard', permanent: true }))).toEqual({ success: false, error: 'loop guard', permanent: true });
    expect(await emitAction.run({ event: 'x' }, envelope, context({ success: false, error: 'aborted' }))).toEqual({ success: false, error: 'aborted' });
  });
});
