import { describe, it, expect } from 'vitest';
import { describeWaiting } from './waitingText.js';

// "N waiting: a.b, c.d": shared by `queue push` and the dashboard, so the two never word it differently
describe('describeWaiting', () => {
  it.each([
    [1, ['a.b'], '1 waiting: a.b'],
    [3, ['a.b', 'c.d', 'e.f'], '3 waiting: a.b, c.d, e.f'],
    [4, ['a.b', 'c.d', 'e.f', 'g.h'], '4 waiting: a.b, c.d, e.f ... +1 more'],
    [25, Array.from({ length: 20 }, (_, i) => `w.n${i}`), '25 waiting: w.n0, w.n1, w.n2 ... +22 more'],
    [2, undefined, '2 waiting'],
    [2, [], '2 waiting'],
  ] as Array<[number, string[] | undefined, string]>)('%s waiter(s) with names %j -> %s', (count, names, expected) => {
    expect(describeWaiting(count, names)).toBe(expected);
  });

  it('removes the control characters of a name (it comes from a file another process wrote)', () => {
    expect(describeWaiting(1, ['a\u001b[31m.b\n'])).toBe('1 waiting: a[31m.b');
  });

  it('a count that is lower than the names given is the count that wins', () => {
    expect(describeWaiting(1, ['a.b', 'c.d'])).toBe('1 waiting: a.b');
  });
});
