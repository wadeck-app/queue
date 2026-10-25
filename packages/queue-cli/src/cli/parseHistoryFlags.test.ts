/**
 * Unit tests for parseHistoryFlags function.
 * Tests the validation of history command flags.
 */
import { describe, it, expect } from 'vitest';
import { parseHistoryFlags } from './QueueIndex.js';

describe('parseHistoryFlags', () => {
  describe('missing flag values', () => {
    it('--event without value pushes error', () => {
      const result = parseHistoryFlags(['history', '--event']);
      expect(result.errors).toContain('--event requires a value');
      expect(result.filter.event).toBeUndefined();
    });

    it('--event with next flag starting with -- pushes error', () => {
      const result = parseHistoryFlags(['history', '--event', '--subscriber', 'sub1']);
      expect(result.errors).toContain('--event requires a value');
    });

    it('--subscriber without value pushes error', () => {
      const result = parseHistoryFlags(['history', '--subscriber']);
      expect(result.errors).toContain('--subscriber requires a value');
      expect(result.filter.subscriberId).toBeUndefined();
    });

    it('--subscriber with next flag starting with -- pushes error', () => {
      const result = parseHistoryFlags(['history', '--subscriber', '--event', 'test.event']);
      expect(result.errors).toContain('--subscriber requires a value');
    });

    it('--status without value pushes error', () => {
      const result = parseHistoryFlags(['history', '--status']);
      expect(result.errors).toContain('--status requires a value');
      expect(result.filter.status).toBeUndefined();
    });

    it('--status with next flag starting with -- pushes error', () => {
      const result = parseHistoryFlags(['history', '--status', '--event', 'test']);
      expect(result.errors).toContain('--status requires a value');
    });

    it('--since without value pushes error', () => {
      const result = parseHistoryFlags(['history', '--since']);
      expect(result.errors).toContain('--since requires a value');
      expect(result.filter.sinceMs).toBeUndefined();
    });

    it('--since with next flag starting with -- pushes error', () => {
      const result = parseHistoryFlags(['history', '--since', '--event', 'test']);
      expect(result.errors).toContain('--since requires a value');
    });

    it('--limit without value pushes error', () => {
      const result = parseHistoryFlags(['history', '--limit']);
      expect(result.errors).toContain('--limit requires a value');
      expect(result.limit).toBe(20); // falls back to default
    });

    it('--limit with next flag starting with -- pushes error', () => {
      const result = parseHistoryFlags(['history', '--limit', '--event', 'test']);
      expect(result.errors).toContain('--limit requires a value');
    });

    it('-n without value pushes error', () => {
      const result = parseHistoryFlags(['history', '-n']);
      expect(result.errors).toContain('-n requires a value');
      expect(result.limit).toBe(20); // falls back to default
    });

    it('-n with next flag starting with -- pushes error', () => {
      const result = parseHistoryFlags(['history', '-n', '--event', 'test']);
      expect(result.errors).toContain('-n requires a value');
    });

    it('--offset without value pushes error', () => {
      const result = parseHistoryFlags(['history', '--offset']);
      expect(result.errors).toContain('--offset requires a value');
      expect(result.offset).toBe(0); // falls back to default
    });

    it('--offset with next flag starting with -- pushes error', () => {
      const result = parseHistoryFlags(['history', '--offset', '--event', 'test']);
      expect(result.errors).toContain('--offset requires a value');
    });
  });

  describe('values starting with single dash', () => {
    it('--since -3d is accepted (negative duration)', () => {
      const result = parseHistoryFlags(['history', '--since', '-3d']);
      expect(result.errors).toEqual([]); // no error for -3d
      expect(result.filter.sinceMs).toBeGreaterThan(0);
    });

    it('--since -2h is accepted', () => {
      const result = parseHistoryFlags(['history', '--since', '-2h']);
      expect(result.errors).toEqual([]); // no error for -2h
      expect(result.filter.sinceMs).toBeGreaterThan(0);
    });

    it('--limit -5 is treated as option error not missing-value error', () => {
      const result = parseHistoryFlags(['history', '--limit', '-5']);
      // -5 is a negative number, so it should fail validation (must be positive)
      // not missing-value error
      expect(result.errors).toContain('--limit must be a positive integer, got: -5');
    });
  });

  describe('valid flags', () => {
    it('--event with value is accepted', () => {
      const result = parseHistoryFlags(['history', '--event', 'test.event']);
      expect(result.errors).toEqual([]);
      expect(result.filter.event).toBe('test.event');
    });

    it('--subscriber with value is accepted', () => {
      const result = parseHistoryFlags(['history', '--subscriber', 'sub-id-123']);
      expect(result.errors).toEqual([]);
      expect(result.filter.subscriberId).toBe('sub-id-123');
    });

    it('--status with valid value is accepted', () => {
      const result = parseHistoryFlags(['history', '--status', 'success']);
      expect(result.errors).toEqual([]);
      expect(result.filter.status).toBe('success');
    });

    it('--since with valid duration is accepted', () => {
      const result = parseHistoryFlags(['history', '--since', '-1d']);
      expect(result.errors).toEqual([]);
      expect(result.filter.sinceMs).toBeGreaterThan(0);
    });

    it('--limit with valid value is accepted', () => {
      const result = parseHistoryFlags(['history', '--limit', '50']);
      expect(result.errors).toEqual([]);
      expect(result.limit).toBe(50);
    });

    it('-n with valid value is accepted', () => {
      const result = parseHistoryFlags(['history', '-n', '30']);
      expect(result.errors).toEqual([]);
      expect(result.limit).toBe(30);
    });

    it('-n with invalid value errors', () => {
      const result = parseHistoryFlags(['history', '-n', 'abc']);
      expect(result.errors).toContain('--limit must be a positive integer, got: abc');
      expect(result.limit).toBe(20); // falls back to default
    });

    it('--offset with valid value is accepted', () => {
      const result = parseHistoryFlags(['history', '--offset', '10']);
      expect(result.errors).toEqual([]);
      expect(result.offset).toBe(10);
    });
  });

  describe('multiple errors', () => {
    it('multiple missing values produces multiple errors', () => {
      const result = parseHistoryFlags(['history', '--event', '--limit', '--offset']);
      expect(result.errors).toContain('--event requires a value');
      expect(result.errors).toContain('--limit requires a value');
      expect(result.errors).toContain('--offset requires a value');
      expect(result.errors.length).toBe(3);
    });
  });

  describe('flag at end of args', () => {
    it('flag at end of args list pushes error', () => {
      const result = parseHistoryFlags(['--event']);
      expect(result.errors).toContain('--event requires a value');
    });
  });

  describe('--project', () => {
    it('is returned as the reference to resolve (a name, an alias or an id), not put in the filter as it was typed', () => {
      const result = parseHistoryFlags(['history', '--project', 'app']);
      expect(result.errors).toEqual([]);
      expect(result.projectRef).toBe('app');
      expect(result.filter.projectId).toBeUndefined();
    });

    it('-p is the short form', () => {
      expect(parseHistoryFlags(['history', '-p', 'app']).projectRef).toBe('app');
    });

    it('without a value pushes an error instead of listing every project', () => {
      expect(parseHistoryFlags(['history', '--project']).errors).toContain('--project requires a value');
    });

    it('is absent without the flag', () => {
      expect(parseHistoryFlags(['history']).projectRef).toBeUndefined();
    });
  });
});
