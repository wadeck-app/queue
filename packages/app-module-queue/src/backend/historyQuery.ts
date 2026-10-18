import type { HistoryFilter } from '@wadeck-app/queue-core';
import { DEFAULT_HISTORY_LIMIT } from '@wadeck-app/queue-core';
import { InvalidQueryError } from './errors.js';

export const MAX_HISTORY_LIMIT = 500;

interface QueryParams {
  [key: string]: string | string[] | undefined;
}

interface ParsedHistoryQuery {
  filter: HistoryFilter;
  pagination: { limit?: number; offset?: number; page?: number };
}

function validateSingleString(param: unknown, name: string): string {
  if (Array.isArray(param)) {
    throw new InvalidQueryError(`${name} must be given once, got ${param.length} values`);
  }
  return param as string;
}

interface ParseDigitsOptions {
  min?: number;
  max?: number;
  onlyCheckSafeInteger?: boolean;
}

// Helper to parse and validate digits-only parameters with consistent error messages.
// Validates: single-value (via validateSingleString), empty check, /^\d+$/ regex, Number(), range/safe-integer checks.
function parseDigits(
  param: unknown,
  name: string,
  options: ParseDigitsOptions & { expected: string },
): number | undefined {
  if (param === undefined) {
    return undefined;
  }
  const paramStr = validateSingleString(param, name);
  if (paramStr === '') {
    throw new InvalidQueryError(`${name} must be ${options.expected}, got: ""`);
  }
  if (!/^\d+$/.test(paramStr)) {
    throw new InvalidQueryError(`${name} must be ${options.expected}, got: "${paramStr}"`);
  }
  const parsed = Number(paramStr);
  if (options.min !== undefined && parsed < options.min) {
    throw new InvalidQueryError(`${name} must be ${options.expected}, got: "${paramStr}"`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new InvalidQueryError(`${name} must be ${options.expected}, got: "${paramStr}"`);
  }
  if (options.onlyCheckSafeInteger && !Number.isSafeInteger(parsed)) {
    throw new InvalidQueryError(`${name} must be ${options.expected}, got: "${paramStr}"`);
  }
  return parsed;
}

/**
 * Parses and validates query parameters from GET /history, converting string query params
 * to typed filter and pagination objects. Rejects invalid values with detailed error messages.
 *
 * Rules:
 * - limit: integer 1..MAX_HISTORY_LIMIT, or absent (undefined)
 * - offset: integer >= 0, or absent (undefined)
 * - page: integer >= 0, or absent (undefined); if both page and offset are given, throws 400
 * - sinceMs: finite number >= 0, or absent (undefined)
 * - status: one of 'success', 'failed', 'dlq', 'filtered', or absent (undefined)
 * - event, subscriberId: any string or absent, empty string treated as absent
 *
 * Note: limit/offset/page/sinceMs use strict decimal-digits-only validation (/^\d+$/) to ensure
 * they are plain integers (rejecting scientific notation like "1e3", decimals like "1.5",
 * leading spaces, plus signs, and full-width digits). Leading zeros (e.g., "05") are accepted.
 * sinceMs further validates that the integer fits within Number.isSafeInteger (timestamps).
 * page * limit must be a safe integer (overflow guard).
 *
 * @throws InvalidQueryError with actionable message naming the parameter, received value, and expected form
 */
export function parseHistoryQuery(query: QueryParams): ParsedHistoryQuery {
  // Handle event: empty string is treated as undefined; arrays must be single value
  let event: string | undefined;
  if (query['event'] !== undefined && query['event'] !== '') {
    event = validateSingleString(query['event'], 'event');
  }

  // Handle subscriberId: empty string is treated as undefined; arrays must be single value
  let subscriberId: string | undefined;
  if (query['subscriberId'] !== undefined && query['subscriberId'] !== '') {
    subscriberId = validateSingleString(query['subscriberId'], 'subscriberId');
  }

  // Parse and validate limit: integer 1..MAX_HISTORY_LIMIT
  const limit = parseDigits(query['limit'], 'limit', {
    min: 1,
    max: MAX_HISTORY_LIMIT,
    expected: `an integer between 1 and ${MAX_HISTORY_LIMIT}`,
  });

  // Parse and validate page: integer >= 0
  const page = parseDigits(query['page'], 'page', {
    min: 0,
    expected: 'an integer >= 0',
  });

  // Parse and validate offset: integer >= 0
  const offset = parseDigits(query['offset'], 'offset', {
    min: 0,
    expected: 'an integer >= 0',
  });

  // Check for conflicting page and offset
  if (page !== undefined && offset !== undefined) {
    throw new InvalidQueryError('page and offset cannot be combined: use page (with limit) or offset, not both');
  }

  // Guard overflow: if page is given, page * effectiveLimit must be a safe integer
  if (page !== undefined) {
    const effectiveLimit = limit ?? DEFAULT_HISTORY_LIMIT;
    const computedOffset = page * effectiveLimit;
    if (!Number.isSafeInteger(computedOffset)) {
      throw new InvalidQueryError(`page * limit must be a safe integer, got page="${page}" limit="${effectiveLimit}"`);
    }
  }

  // Parse and validate sinceMs: integer >= 0 and safe integer (timestamps)
  const sinceMs = parseDigits(query['sinceMs'], 'sinceMs', {
    min: 0,
    onlyCheckSafeInteger: true,
    expected: 'an integer >= 0',
  });

  // Parse and validate status: must be one of the allowed values
  let status: 'success' | 'failed' | 'dlq' | 'filtered' | undefined;
  if (query['status'] !== undefined) {
    const statusStr = validateSingleString(query['status'], 'status');
    const validStatuses = ['success', 'failed', 'dlq', 'filtered'];
    if (statusStr === '' || !validStatuses.includes(statusStr)) {
      throw new InvalidQueryError(`status must be one of success, failed, dlq, filtered, got: "${statusStr}"`);
    }
    status = statusStr as 'success' | 'failed' | 'dlq' | 'filtered';
  }

  return {
    filter: {
      event,
      subscriberId,
      status,
      sinceMs,
    },
    pagination: {
      limit,
      offset,
      page,
    },
  };
}
