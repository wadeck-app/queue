import { describe, it, expect } from 'vitest';
import { EventMatcher } from './EventMatcher.js';

describe('EventMatcher', () => {
  it('exact match: ticket.created matches ticket.created', () => {
    expect(EventMatcher.matches('ticket.created', 'ticket.created')).toBe(true);
  });

  it('exact match: ticket.created does not match ticket.updated', () => {
    expect(EventMatcher.matches('ticket.created', 'ticket.updated')).toBe(false);
  });

  it('single wildcard * matches one segment', () => {
    expect(EventMatcher.matches('ticket.*', 'ticket.created')).toBe(true);
    expect(EventMatcher.matches('ticket.*', 'ticket.updated')).toBe(true);
  });

  it('single wildcard * does NOT match multiple segments', () => {
    expect(EventMatcher.matches('ticket.*', 'ticket.sub.event')).toBe(false);
  });

  it('multi-segment wildcard ** matches any depth', () => {
    expect(EventMatcher.matches('ticket.**', 'ticket.created')).toBe(true);
    expect(EventMatcher.matches('ticket.**', 'ticket.sub.event')).toBe(true);
    expect(EventMatcher.matches('ticket.**', 'ticket.a.b.c')).toBe(true);
  });

  it('> wildcard matches any depth', () => {
    expect(EventMatcher.matches('ticket.>', 'ticket.created')).toBe(true);
    expect(EventMatcher.matches('ticket.>', 'ticket.sub.event')).toBe(true);
  });

  it('standalone ** matches everything', () => {
    expect(EventMatcher.matches('**', 'anything.here')).toBe(true);
    expect(EventMatcher.matches('>', 'foo.bar.baz')).toBe(true);
  });
});
