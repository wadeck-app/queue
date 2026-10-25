import { describe, it, expect } from 'vitest';
import { parseHistoryQuery, MAX_HISTORY_LIMIT } from './historyQuery.js';
import { InvalidQueryError } from './errors.js';

describe('parseHistoryQuery', () => {
  describe('valid requests', () => {
    it('returns empty filter and pagination when query is empty', () => {
      const result = parseHistoryQuery({});
      expect(result).toEqual({
        filter: { event: undefined, subscriberId: undefined, status: undefined, sinceMs: undefined },
        pagination: { limit: undefined, offset: undefined },
      });
    });

    it('accepts event and subscriberId filter params', () => {
      const result = parseHistoryQuery({ event: 'onFoo', subscriberId: 'sub1' });
      expect(result).toEqual({
        filter: { event: 'onFoo', subscriberId: 'sub1', status: undefined, sinceMs: undefined },
        pagination: { limit: undefined, offset: undefined },
      });
    });

    it('treats empty string event and subscriberId as absent (undefined)', () => {
      const result = parseHistoryQuery({ event: '', subscriberId: '' });
      expect(result).toEqual({
        filter: { event: undefined, subscriberId: undefined, status: undefined, sinceMs: undefined },
        pagination: { limit: undefined, offset: undefined },
      });
    });

    it('accepts valid status values', () => {
      const statuses = ['success', 'failed', 'dlq', 'filtered'];
      for (const status of statuses) {
        const result = parseHistoryQuery({ status });
        expect(result.filter.status).toBe(status);
      }
    });

    it('accepts valid limit (1 to MAX_HISTORY_LIMIT)', () => {
      const result1 = parseHistoryQuery({ limit: '1' });
      expect(result1.pagination.limit).toBe(1);

      const result500 = parseHistoryQuery({ limit: '500' });
      expect(result500.pagination.limit).toBe(500);
    });

    it('accepts valid offset (>= 0)', () => {
      const result0 = parseHistoryQuery({ offset: '0' });
      expect(result0.pagination.offset).toBe(0);

      const result100 = parseHistoryQuery({ offset: '100' });
      expect(result100.pagination.offset).toBe(100);
    });

    it('accepts valid sinceMs (finite number >= 0)', () => {
      const result0 = parseHistoryQuery({ sinceMs: '0' });
      expect(result0.filter.sinceMs).toBe(0);

      const result1000 = parseHistoryQuery({ sinceMs: '1693567200000' });
      expect(result1000.filter.sinceMs).toBe(1693567200000);
    });

    it('treats undefined/empty limit, offset, sinceMs as absent', () => {
      const result = parseHistoryQuery({ limit: undefined, offset: undefined, sinceMs: undefined });
      expect(result.pagination).toEqual({ limit: undefined, offset: undefined });
      expect(result.filter.sinceMs).toBeUndefined();
    });

    it('accepts all filters and pagination together', () => {
      const result = parseHistoryQuery({
        event: 'onPush',
        subscriberId: 'webhook',
        status: 'success',
        sinceMs: '1000',
        limit: '50',
        offset: '10',
      });
      expect(result).toEqual({
        filter: {
          event: 'onPush',
          subscriberId: 'webhook',
          status: 'success',
          sinceMs: 1000,
        },
        pagination: { limit: 50, offset: 10 },
      });
    });
  });

  describe('invalid limit', () => {
    it('rejects non-numeric limit', () => {
      expect(() => parseHistoryQuery({ limit: 'abc' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "abc"'),
      );
    });

    it('rejects limit = 0', () => {
      expect(() => parseHistoryQuery({ limit: '0' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "0"'),
      );
    });

    it('rejects limit > MAX_HISTORY_LIMIT', () => {
      expect(() => parseHistoryQuery({ limit: '501' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "501"'),
      );
    });

    it('rejects negative limit', () => {
      expect(() => parseHistoryQuery({ limit: '-5' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "-5"'),
      );
    });

    it('rejects decimal limit', () => {
      expect(() => parseHistoryQuery({ limit: '1.5' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "1.5"'),
      );
    });

    it('rejects scientific notation limit', () => {
      expect(() => parseHistoryQuery({ limit: '1e3' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "1e3"'),
      );
    });

    it('rejects empty string limit as error (not absent)', () => {
      expect(() => parseHistoryQuery({ limit: '' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: ""'),
      );
    });

    it('rejects limit with leading space', () => {
      expect(() => parseHistoryQuery({ limit: ' 5' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: " 5"'),
      );
    });

    it('rejects limit with plus sign', () => {
      expect(() => parseHistoryQuery({ limit: '+5' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "+5"'),
      );
    });

    it('accepts limit with leading zeros (e.g., "05")', () => {
      const result = parseHistoryQuery({ limit: '05' });
      expect(result.pagination.limit).toBe(5);
    });

    it('rejects limit with full-width digits', () => {
      expect(() => parseHistoryQuery({ limit: '５' })).toThrow(
        new InvalidQueryError('limit must be an integer between 1 and 500, got: "５"'),
      );
    });

    it('rejects duplicated limit parameter', () => {
      expect(() => parseHistoryQuery({ limit: ['5', '10'] })).toThrow(
        new InvalidQueryError('limit must be given once, got 2 values'),
      );
    });
  });

  describe('invalid offset', () => {
    it('rejects non-numeric offset', () => {
      expect(() => parseHistoryQuery({ offset: 'abc' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: "abc"'),
      );
    });

    it('rejects negative offset', () => {
      expect(() => parseHistoryQuery({ offset: '-3' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: "-3"'),
      );
    });

    it('rejects decimal offset', () => {
      expect(() => parseHistoryQuery({ offset: '1.5' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: "1.5"'),
      );
    });

    it('rejects scientific notation offset', () => {
      expect(() => parseHistoryQuery({ offset: '1e3' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: "1e3"'),
      );
    });

    it('rejects empty string offset as error (not absent)', () => {
      expect(() => parseHistoryQuery({ offset: '' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: ""'),
      );
    });

    it('rejects offset with leading space', () => {
      expect(() => parseHistoryQuery({ offset: ' 5' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: " 5"'),
      );
    });

    it('rejects offset with plus sign', () => {
      expect(() => parseHistoryQuery({ offset: '+5' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: "+5"'),
      );
    });

    it('accepts offset with leading zeros (e.g., "05")', () => {
      const result = parseHistoryQuery({ offset: '05' });
      expect(result.pagination.offset).toBe(5);
    });

    it('rejects offset with full-width digits', () => {
      expect(() => parseHistoryQuery({ offset: '５' })).toThrow(
        new InvalidQueryError('offset must be an integer >= 0, got: "５"'),
      );
    });

    it('rejects duplicated offset parameter', () => {
      expect(() => parseHistoryQuery({ offset: ['0', '10'] })).toThrow(
        new InvalidQueryError('offset must be given once, got 2 values'),
      );
    });
  });

  describe('invalid sinceMs', () => {
    it('rejects non-numeric sinceMs', () => {
      expect(() => parseHistoryQuery({ sinceMs: 'abc' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "abc"'),
      );
    });

    it('rejects negative sinceMs', () => {
      expect(() => parseHistoryQuery({ sinceMs: '-100' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "-100"'),
      );
    });

    it('rejects Infinity', () => {
      expect(() => parseHistoryQuery({ sinceMs: 'Infinity' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "Infinity"'),
      );
    });

    it('rejects NaN', () => {
      expect(() => parseHistoryQuery({ sinceMs: 'NaN' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "NaN"'),
      );
    });

    it('rejects empty string sinceMs as error (not absent)', () => {
      expect(() => parseHistoryQuery({ sinceMs: '' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: ""'),
      );
    });

    it('rejects decimal sinceMs', () => {
      expect(() => parseHistoryQuery({ sinceMs: '1000.5' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "1000.5"'),
      );
    });

    it('rejects scientific notation sinceMs', () => {
      expect(() => parseHistoryQuery({ sinceMs: '1e3' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "1e3"'),
      );
    });

    it('rejects sinceMs with leading space', () => {
      expect(() => parseHistoryQuery({ sinceMs: ' 1000' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: " 1000"'),
      );
    });

    it('rejects sinceMs with plus sign', () => {
      expect(() => parseHistoryQuery({ sinceMs: '+1000' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "+1000"'),
      );
    });

    it('accepts sinceMs with leading zeros (e.g., "01000")', () => {
      const result = parseHistoryQuery({ sinceMs: '01000' });
      expect(result.filter.sinceMs).toBe(1000);
    });

    it('rejects sinceMs with full-width digits', () => {
      expect(() => parseHistoryQuery({ sinceMs: '１０００' })).toThrow(
        new InvalidQueryError('sinceMs must be an integer >= 0, got: "１０００"'),
      );
    });

    it('rejects sinceMs beyond Number.MAX_SAFE_INTEGER', () => {
      const beyondSafeInt = '9007199254740992';
      expect(() => parseHistoryQuery({ sinceMs: beyondSafeInt })).toThrow(
        new InvalidQueryError(`sinceMs must be an integer >= 0, got: "${beyondSafeInt}"`),
      );
    });

    it('accepts sinceMs at Number.MAX_SAFE_INTEGER', () => {
      const maxSafeInt = '9007199254740991';
      const result = parseHistoryQuery({ sinceMs: maxSafeInt });
      expect(result.filter.sinceMs).toBe(9007199254740991);
    });

    it('rejects duplicated sinceMs parameter', () => {
      expect(() => parseHistoryQuery({ sinceMs: ['1000', '2000'] })).toThrow(
        new InvalidQueryError('sinceMs must be given once, got 2 values'),
      );
    });
  });

  describe('invalid status', () => {
    it('rejects status not in allowed list', () => {
      expect(() => parseHistoryQuery({ status: 'bogus' })).toThrow(
        new InvalidQueryError('status must be one of success, failed, dlq, filtered, got: "bogus"'),
      );
    });

    it('rejects empty string status as error (not absent)', () => {
      expect(() => parseHistoryQuery({ status: '' })).toThrow(
        new InvalidQueryError('status must be one of success, failed, dlq, filtered, got: ""'),
      );
    });

    it('rejects duplicated status parameter', () => {
      expect(() => parseHistoryQuery({ status: ['success', 'failed'] })).toThrow(
        new InvalidQueryError('status must be given once, got 2 values'),
      );
    });
  });

  describe('array/duplicated parameters edge cases', () => {
    it('rejects duplicated event parameter', () => {
      expect(() => parseHistoryQuery({ event: ['onFoo', 'onBar'] })).toThrow(
        new InvalidQueryError('event must be given once, got 2 values'),
      );
    });

    it('rejects duplicated subscriberId parameter', () => {
      expect(() => parseHistoryQuery({ subscriberId: ['sub1', 'sub2'] })).toThrow(
        new InvalidQueryError('subscriberId must be given once, got 2 values'),
      );
    });
  });

  describe('valid page', () => {
    it('accepts page = 0', () => {
      const result = parseHistoryQuery({ page: '0' });
      expect(result.pagination.page).toBe(0);
    });

    it('accepts page = 1', () => {
      const result = parseHistoryQuery({ page: '1' });
      expect(result.pagination.page).toBe(1);
    });

    it('accepts page with leading zeros (e.g., "05")', () => {
      const result = parseHistoryQuery({ page: '05' });
      expect(result.pagination.page).toBe(5);
    });

    it('treats undefined page as absent', () => {
      const result = parseHistoryQuery({ page: undefined });
      expect(result.pagination.page).toBeUndefined();
    });
  });

  describe('invalid page', () => {
    it('rejects non-numeric page', () => {
      expect(() => parseHistoryQuery({ page: 'abc' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: "abc"'),
      );
    });

    it('rejects negative page', () => {
      expect(() => parseHistoryQuery({ page: '-1' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: "-1"'),
      );
    });

    it('rejects decimal page', () => {
      expect(() => parseHistoryQuery({ page: '1.5' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: "1.5"'),
      );
    });

    it('rejects scientific notation page', () => {
      expect(() => parseHistoryQuery({ page: '1e3' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: "1e3"'),
      );
    });

    it('rejects empty string page as error (not absent)', () => {
      expect(() => parseHistoryQuery({ page: '' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: ""'),
      );
    });

    it('rejects page with leading space', () => {
      expect(() => parseHistoryQuery({ page: ' 5' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: " 5"'),
      );
    });

    it('rejects page with plus sign', () => {
      expect(() => parseHistoryQuery({ page: '+5' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: "+5"'),
      );
    });

    it('rejects page with full-width digits', () => {
      expect(() => parseHistoryQuery({ page: '５' })).toThrow(
        new InvalidQueryError('page must be an integer >= 0, got: "５"'),
      );
    });

    it('rejects duplicated page parameter', () => {
      expect(() => parseHistoryQuery({ page: ['0', '1'] })).toThrow(
        new InvalidQueryError('page must be given once, got 2 values'),
      );
    });
  });

  describe('page with limit/offset interaction', () => {
    it('accepts page without limit or offset', () => {
      const result = parseHistoryQuery({ page: '2' });
      expect(result.pagination.page).toBe(2);
      expect(result.pagination.limit).toBeUndefined();
      expect(result.pagination.offset).toBeUndefined();
    });

    it('accepts page with limit', () => {
      const result = parseHistoryQuery({ page: '1', limit: '10' });
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.offset).toBeUndefined();
    });

    it('when both page and offset given, throws 400 with actionable message', () => {
      expect(() => parseHistoryQuery({ page: '1', offset: '25' })).toThrow(
        new InvalidQueryError('page and offset cannot be combined: use page (with limit) or offset, not both'),
      );
    });

    it('rejects when page * limit overflows safe integer', () => {
      const maxSafeInt = '9007199254740991';
      expect(() => parseHistoryQuery({ page: maxSafeInt, limit: '100' })).toThrow(
        new InvalidQueryError(`page * limit must be a safe integer, got page="${maxSafeInt}" limit="100"`),
      );
    });

    it('accepts page * limit at safe integer boundary', () => {
      const result = parseHistoryQuery({ page: '450359962737', limit: '20' });
      expect(result.pagination.page).toBe(450359962737);
      expect(result.pagination.limit).toBe(20);
    });
  });
});

describe('parseHistoryQuery: project', () => {
  it('filters on the id of a registered project; an empty value is absent', () => {
    expect(parseHistoryQuery({ project: '569c412d' }).filter.projectId).toBe('569c412d');
    expect(parseHistoryQuery({ project: '' }).filter.projectId).toBeUndefined();
  });

  it('refuses something that is not a project id, naming the expected form, instead of listing an empty history', () => {
    expect(() => parseHistoryQuery({ project: 'my app' })).toThrowError(InvalidQueryError);
    expect(() => parseHistoryQuery({ project: 'my app' })).toThrowError(/project must be .*8 hexadecimal/);
  });

  it('refuses the parameter given twice', () => {
    expect(() => parseHistoryQuery({ project: ['569c412d', 'deadbeef'] })).toThrowError(/project must be given once/);
  });
});
