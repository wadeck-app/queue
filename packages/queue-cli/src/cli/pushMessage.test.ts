import { describe, it, expect } from 'vitest';
import type { PushResponse } from '@wadeck-app/queue-core';
import { pushMessage } from './pushOutcome.js';

// The line `queue push` prints for an on* event that was queued. Protocol 1.7.0 adds who was waiting (`waiterCount`, `waiters`); an answer without them keeps today's text.
describe('pushMessage', () => {
  it.each([
    // [label, response, stream, text]
    ['nobody listens, nobody waits', { subscriberCount: 0, waiterCount: 0, waiters: [] }, 'stderr', "[warn] queued - no subscribers and no one waiting for 'onX'\n"],
    ['nobody listens, one waits', { subscriberCount: 0, waiterCount: 1, waiters: ['a.b'] }, 'stdout', '[ok] queued (0 subscribers, 1 waiting: a.b)\n'],
    ['nobody listens, two wait', { subscriberCount: 0, waiterCount: 2, waiters: ['a.b', 'c.d'] }, 'stdout', '[ok] queued (0 subscribers, 2 waiting: a.b, c.d)\n'],
    ['one listens, nobody waits', { subscriberCount: 1, waiterCount: 0, waiters: [] }, 'stdout', '[ok] queued (1 subscriber)\n'],
    ['three listen, nobody waits', { subscriberCount: 3, waiterCount: 0, waiters: [] }, 'stdout', '[ok] queued (3 subscribers)\n'],
    ['three listen, one waits', { subscriberCount: 3, waiterCount: 1, waiters: ['a.b'] }, 'stdout', '[ok] queued (3 subscribers, 1 waiting: a.b)\n'],
    ['one listens, three wait: all names', { subscriberCount: 1, waiterCount: 3, waiters: ['a.b', 'c.d', 'e.f'] }, 'stdout', '[ok] queued (1 subscriber, 3 waiting: a.b, c.d, e.f)\n'],
    ['more than three wait: three names and how many more', { subscriberCount: 0, waiterCount: 5, waiters: ['a.b', 'c.d', 'e.f', 'g.h', 'i.j'] }, 'stdout', '[ok] queued (0 subscribers, 5 waiting: a.b, c.d, e.f ... +2 more)\n'],
    ['more waiters than names (the daemon caps the list at 20)', { subscriberCount: 0, waiterCount: 25, waiters: Array.from({ length: 20 }, (_, i) => `w.n${i}`) }, 'stdout', '[ok] queued (0 subscribers, 25 waiting: w.n0, w.n1, w.n2 ... +22 more)\n'],
    ['a count without names', { subscriberCount: 0, waiterCount: 2 }, 'stdout', '[ok] queued (0 subscribers, 2 waiting)\n'],
    // An answer without the fields comes from a daemon older than 1.7.0, or one that could not look: exactly today's text
    ['old daemon, nobody listens', { subscriberCount: 0 }, 'stderr', "[warn] queued - no subscribers for 'onX'\n"],
    ['old daemon, two listen', { subscriberCount: 2 }, 'stdout', '[ok] queued (2 subscribers)\n'],
    ['old daemon, no count at all', {}, 'stderr', "[warn] queued - no subscribers for 'onX'\n"],
  ] as Array<[string, Partial<PushResponse>, string, string]>)('%s', (_label, fields, stream, text) => {
    expect(pushMessage('onX', { status: 'queued', ...fields })).toEqual({ stream, text });
  });

  it('a dispatched answer without subscribers is worded like a queued one (the caller prints the result of a before* event instead)', () => {
    expect(pushMessage('onX', { status: 'dispatched', subscriberCount: 0, waiterCount: 1, waiters: ['a.b'] }).text).toBe('[ok] queued (0 subscribers, 1 waiting: a.b)\n');
  });

  it('strips the control characters of a name before it reaches the terminal', () => {
    const { text } = pushMessage('onX', { status: 'queued', subscriberCount: 0, waiterCount: 1, waiters: ['a\u001b[31m.b\n'] });
    expect(text).toBe('[ok] queued (0 subscribers, 1 waiting: a[31m.b)\n');
  });
});
