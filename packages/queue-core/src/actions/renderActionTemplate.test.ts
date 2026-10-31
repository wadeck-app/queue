import { describe, it, expect } from 'vitest';
import { ActionTemplateError, MAX_RENDERED_FIELD_BYTES, findActionTemplateProblem, renderActionTemplate } from './renderActionTemplate.js';
import type { EventEnvelope } from '../types.js';

function envelope(payload: unknown, meta: EventEnvelope['meta'] = {}): EventEnvelope {
  return { id: 'wal-id', timestamp: '2026-01-02T03:04:05.000Z', event: 'onTicket.created', payload, meta };
}

function render(template: string, payload: unknown = {}, meta: EventEnvelope['meta'] = {}): string {
  return renderActionTemplate(template, envelope(payload, meta), 'with.payload.text');
}

describe('renderActionTemplate', () => {
  it('renders a payload field, nested paths and the envelope fields', () => {
    expect(render('{{ payload.a }}/{{payload.b.c}}/{{ event }}/{{ timestamp }}', { a: 'x', b: { c: 'y' } })).toBe('x/y/onTicket.created/2026-01-02T03:04:05.000Z');
  });

  it('{{ id }} is the id of the first push when the meta holds it, so a retry renders the same value; else the envelope id', () => {
    expect(render('{{ id }}', {}, { eventId: 'first-push' })).toBe('first-push');
    expect(render('{{ id }}')).toBe('wal-id');
  });

  it('writes objects and arrays as JSON, numbers and booleans as text, undefined and null as an empty string', () => {
    expect(render('{{ payload.o }}|{{ payload.n }}|{{ payload.b }}|{{ payload.z }}|{{ payload.missing }}|{{ payload.deep.missing }}', { o: { k: [1] }, n: 3, b: false, z: null })).toBe('{"k":[1]}|3|false|||');
    expect(render('{{ payload }}', { a: 1 })).toBe('{"a":1}');
  });

  it('reads array items by index', () => {
    expect(render('{{ payload.items.1 }}', { items: ['a', 'b'] })).toBe('b');
  });

  it('is single pass: a value that looks like a placeholder is not rendered again', () => {
    expect(render('{{ payload.a }}', { a: '{{ payload.b }}', b: 'secret' })).toBe('{{ payload.b }}');
  });

  it('reads own properties only, never __proto__, constructor or prototype', () => {
    expect(render('{{ payload.toString }}|{{ payload.hasOwnProperty }}', { })).toBe('|');
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(findActionTemplateProblem(`{{ payload.${key} }}`)).toContain(`'${key}'`);
      expect(() => render(`{{ payload.a.${key} }}`, { a: {} })).toThrow(ActionTemplateError);
    }
  });

  it('refuses a bare {{ x }} and says to write payload.x', () => {
    const problem = findActionTemplateProblem('hello {{ text }}');
    expect(problem).toContain('{{ payload.text }}');
    expect(() => render('{{ text }}', { text: 'v' })).toThrow(/payload\.text/);
  });

  it.each(['{{ }}', '{{ payload. }}', '{{ payload.a b }}', '{{ payload.a! }}', '{{ a b }}', 'open {{ payload.a', '{{ {{ payload.a }} }}'])('refuses the malformed template %j', (template) => {
    expect(findActionTemplateProblem(template)).toBeDefined();
    expect(() => render(template, { a: 1 })).toThrow(ActionTemplateError);
  });

  it('accepts a template without placeholder as it is', () => {
    expect(findActionTemplateProblem('plain text, 100% { not a placeholder }')).toBeUndefined();
    expect(render('plain')).toBe('plain');
  });

  it('refuses a NUL character in a rendered value, naming the field and never the value', () => {
    try {
      render('{{ payload.a }}', { a: 'abc\0def' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ActionTemplateError);
      expect((err as ActionTemplateError).field).toBe('with.payload.text');
      expect((err as Error).message).toContain('with.payload.text');
      expect((err as Error).message).not.toContain('abc');
    }
  });

  it('caps one rendered field at 64 KB without echoing it', () => {
    const big = 'x'.repeat(MAX_RENDERED_FIELD_BYTES + 1);
    try {
      render('{{ payload.a }}', { a: big });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain(String(MAX_RENDERED_FIELD_BYTES));
      expect((err as Error).message).not.toContain('xxxxx');
    }
    expect(render('{{ payload.a }}', { a: 'x'.repeat(MAX_RENDERED_FIELD_BYTES) })).toHaveLength(MAX_RENDERED_FIELD_BYTES);
  });

  it('counts bytes, not characters', () => {
    expect(() => render('{{ payload.a }}', { a: 'é'.repeat(MAX_RENDERED_FIELD_BYTES / 2 + 1) })).toThrow(/bytes/);
  });
});
