import { describe, expect, it } from 'vitest';
import { parsePushAnswer, serializePushRequest, toPublishResult } from './wire.js';

describe('parsePushAnswer', () => {
  it('unwraps a dispatched answer', () => {
    const parsed = parsePushAnswer({ ok: true, result: { status: 'dispatched', result: { a: 1 }, subscriberCount: 2, eventId: 'e1' } });
    expect(parsed).toEqual({ ok: true, response: { status: 'dispatched', result: { a: 1 }, subscriberCount: 2, eventId: 'e1' } });
  });

  it.each(['queued', 'aborted', 'rejected'])('accepts the %s status', (status) => {
    const parsed = parsePushAnswer({ ok: true, result: { status } });
    expect(parsed.ok).toBe(true);
  });

  it('keeps reason, supported and warnings', () => {
    const parsed = parsePushAnswer({ ok: true, result: { status: 'rejected', reason: 'r', supported: '^1.0.0', warnings: ['w1', 'w2'] } });
    expect(parsed).toEqual({ ok: true, response: { status: 'rejected', reason: 'r', supported: '^1.0.0', warnings: ['w1', 'w2'] } });
  });

  it('ignores unknown fields', () => {
    const parsed = parsePushAnswer({ ok: true, extra: 1, result: { status: 'queued', future: true } });
    expect(parsed).toEqual({ ok: true, response: { status: 'queued' } });
  });

  it('fails on an unknown status value and quotes it', () => {
    const parsed = parsePushAnswer({ ok: true, result: { status: 'exploded' } });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('exploded');
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['no result', { ok: true }],
    ['ok false', { ok: false, result: { status: 'queued' } }],
    ['a non-object result', { ok: true, result: 3 }],
    ['a missing status', { ok: true, result: {} }],
  ])('fails on %s', (_name, body) => {
    const parsed = parsePushAnswer(body);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason.length).toBeGreaterThan(0);
  });

  it('drops warnings that are not an array of strings', () => {
    const parsed = parsePushAnswer({ ok: true, result: { status: 'queued', warnings: ['a', 3] } });
    expect(parsed).toEqual({ ok: true, response: { status: 'queued', warnings: ['a'] } });
  });

  it('drops fields of the wrong type', () => {
    const parsed = parsePushAnswer({ ok: true, result: { status: 'queued', eventId: 5, reason: {}, subscriberCount: 'x' } });
    expect(parsed).toEqual({ ok: true, response: { status: 'queued' } });
  });
});

describe('toPublishResult', () => {
  it('maps dispatched with its result and eventId', () => {
    expect(toPublishResult({ status: 'dispatched', result: 1, eventId: 'e' })).toEqual({ status: 'dispatched', result: 1, eventId: 'e' });
  });

  it('maps queued', () => {
    expect(toPublishResult({ status: 'queued', eventId: 'e' })).toEqual({ status: 'queued', eventId: 'e' });
  });

  it('maps aborted to dropped with the daemon reason', () => {
    expect(toPublishResult({ status: 'aborted', reason: 'hook said no' })).toEqual({ status: 'dropped', reason: 'hook said no' });
  });

  it('gives aborted without a reason a generic one', () => {
    const result = toPublishResult({ status: 'aborted' });
    expect(result.status).toBe('dropped');
    expect(result.reason).toContain('aborted');
  });

  it('maps rejected to dropped', () => {
    expect(toPublishResult({ status: 'rejected', reason: 'bad protocol' })).toEqual({ status: 'dropped', reason: 'bad protocol' });
  });
});

describe('serializePushRequest', () => {
  it('serialises a plain request', () => {
    const out = serializePushRequest({ event: 'a.b', payload: { x: 1 }, cwd: '/p', protocol: '1.0.0' });
    expect(out.ok).toBe(true);
    expect(out.ok && JSON.parse(out.body)).toEqual({ event: 'a.b', payload: { x: 1 }, cwd: '/p', protocol: '1.0.0' });
  });

  it('names the BigInt property', () => {
    const out = serializePushRequest({ event: 'a', payload: { deep: { n: [1, 10n] } }, cwd: '/p' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('payload.deep.n[1]');
    expect(!out.ok && out.reason).toContain('BigInt');
  });

  it('names a circular reference', () => {
    const payload: Record<string, unknown> = { name: 'x' };
    payload['self'] = { back: payload };
    const out = serializePushRequest({ event: 'a', payload, cwd: '/p' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('circular');
    expect(!out.ok && out.reason).toContain('payload.self.back');
  });

  it('reports a toJSON that throws without throwing itself', () => {
    const payload = {
      toJSON() {
        throw new Error('nope');
      },
    };
    const out = serializePushRequest({ event: 'a', payload, cwd: '/p' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('nope');
  });

  it('reports an undefined payload', () => {
    const out = serializePushRequest({ event: 'a', payload: undefined, cwd: '/p' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('undefined');
  });

  it('accepts null and repeated (non-circular) references', () => {
    const shared = { v: 1 };
    expect(serializePushRequest({ event: 'a', payload: null, cwd: '/p' }).ok).toBe(true);
    expect(serializePushRequest({ event: 'a', payload: { a: shared, b: shared }, cwd: '/p' }).ok).toBe(true);
  });
});
