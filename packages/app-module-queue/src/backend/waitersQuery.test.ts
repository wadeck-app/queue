import { describe, it, expect } from 'vitest';
import { InvalidQueryError } from './errors.js';
import { MAX_WAITER_NAME_FILTER_STARS, parseWaiterHistoryQuery } from './waitersQuery.js';

describe('parseWaiterHistoryQuery (GET /waiters/history): the History conventions, a 400 with the reason for anything else', () => {
  it('no parameter: nothing filtered, no paging asked', () => {
    expect(parseWaiterHistoryQuery({})).toEqual({ filter: {}, pagination: {} });
  });

  it('parses name, outcome, sinceMs, limit, offset', () => {
    expect(parseWaiterHistoryQuery({ name: 'agent.*', outcome: 'matched', sinceMs: '1700000000000', limit: '50', offset: '10' })).toEqual({
      filter: { name: 'agent.*', outcome: 'matched', sinceMs: 1_700_000_000_000 },
      pagination: { limit: 50, offset: 10 },
    });
  });

  it('page is accepted without offset', () => {
    expect(parseWaiterHistoryQuery({ page: '2', limit: '10' }).pagination).toEqual({ limit: 10, page: 2 });
  });

  it('an empty name is absent (a cleared search box)', () => {
    expect(parseWaiterHistoryQuery({ name: '' }).filter).toEqual({});
  });

  it.each(['waiting', 'matched', 'timeout', 'cancelled', 'refused', 'lost'])('accepts the outcome %s', (outcome) => {
    expect(parseWaiterHistoryQuery({ outcome }).filter.outcome).toBe(outcome);
  });

  it.each([
    [{ outcome: 'done' }, /outcome must be one of waiting, matched, timeout, cancelled, refused, lost, got: "done"/],
    [{ outcome: '' }, /outcome must be one of/],
    [{ outcome: ['matched', 'lost'] }, /outcome must be given once, got 2 values/],
    [{ name: ['a', 'b'] }, /name must be given once, got 2 values/],
    [{ name: 'x'.repeat(201) }, /name must be at most 200 characters/],
    [{ name: 'a*b*c*d*e' }, /name can contain at most 3 \*/],
    [{ limit: '0' }, /limit must be an integer between 1 and 500, got: "0"/],
    [{ limit: '501' }, /limit must be an integer between 1 and 500/],
    [{ limit: '1e3' }, /limit must be an integer between 1 and 500/],
    [{ limit: '' }, /limit must be an integer between 1 and 500, got: ""/],
    [{ offset: '-1' }, /offset must be an integer >= 0, got: "-1"/],
    [{ page: 'x' }, /page must be an integer >= 0, got: "x"/],
    [{ page: '1', offset: '1' }, /page and offset cannot be combined/],
    [{ sinceMs: 'yesterday' }, /sinceMs must be an integer >= 0, got: "yesterday"/],
    [{ sinceMs: '99999999999999999999' }, /sinceMs must be an integer >= 0/],
    [{ page: '9007199254740991', limit: '500' }, /page \* limit must be a safe integer/],
  ])('refuses %j with the reason', (query, message) => {
    expect(() => parseWaiterHistoryQuery(query as Record<string, string | string[]>)).toThrow(InvalidQueryError);
    expect(() => parseWaiterHistoryQuery(query as Record<string, string | string[]>)).toThrow(message);
  });

  it('allows exactly MAX_WAITER_NAME_FILTER_STARS stars (the glob is turned into a regular expression: more stars would let a long search backtrack for ever)', () => {
    expect(MAX_WAITER_NAME_FILTER_STARS).toBe(3);
    expect(parseWaiterHistoryQuery({ name: '*a*b*c' }).filter.name).toBe('*a*b*c');
  });
});
