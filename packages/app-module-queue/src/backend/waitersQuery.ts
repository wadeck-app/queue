import { DEFAULT_HISTORY_LIMIT, WAITER_OUTCOMES, type WaitRowOutcome } from '@wadeck-app/queue-core';
import { InvalidQueryError } from './errors.js';
import { MAX_HISTORY_LIMIT, parseDigits, validateSingleString, type QueryParams } from './historyQuery.js';

/** The outcomes of a row of the waits history: how a wait ended, or `waiting`. */
export const WAITER_OUTCOME_FILTERS: readonly WaitRowOutcome[] = ['waiting', ...WAITER_OUTCOMES];

const MAX_NAME_FILTER_CHARS = 200;
/** The name filter becomes a regular expression with one `.*` per star: unbounded stars make a long search backtrack for ever. */
export const MAX_WAITER_NAME_FILTER_STARS = 3;

export interface WaiterHistoryFilter {
  /** A wait name, where `*` stands for any characters. */
  name?: string;
  outcome?: WaitRowOutcome;
  /** Epoch ms: the waits that ended at or after it, and the ones still waiting. */
  sinceMs?: number;
}

export interface ParsedWaiterHistoryQuery {
  filter: WaiterHistoryFilter;
  pagination: { limit?: number; offset?: number; page?: number };
}

/**
 * The query of GET /waiters/history, validated like the one of GET /history (same limit, offset, page and sinceMs rules and messages): anything invalid is an
 * InvalidQueryError naming the parameter, the value and the expected form (a 400), never a default.
 * - name: `*` for any characters, at most 200 characters and {@link MAX_WAITER_NAME_FILTER_STARS} stars; empty is absent
 * - outcome: waiting | matched | timeout | cancelled | refused | lost
 */
export function parseWaiterHistoryQuery(query: QueryParams): ParsedWaiterHistoryQuery {
  let name: string | undefined;
  if (query['name'] !== undefined && query['name'] !== '') {
    name = validateSingleString(query['name'], 'name');
    if (name.length > MAX_NAME_FILTER_CHARS) {
      throw new InvalidQueryError(`name must be at most ${MAX_NAME_FILTER_CHARS} characters, got ${name.length}`);
    }
    if (name.split('*').length - 1 > MAX_WAITER_NAME_FILTER_STARS) {
      throw new InvalidQueryError(`name can contain at most ${MAX_WAITER_NAME_FILTER_STARS} * (any characters), got: "${name}"`);
    }
  }

  let outcome: WaitRowOutcome | undefined;
  if (query['outcome'] !== undefined) {
    const text = validateSingleString(query['outcome'], 'outcome');
    if (!(WAITER_OUTCOME_FILTERS as readonly string[]).includes(text)) {
      throw new InvalidQueryError(`outcome must be one of ${WAITER_OUTCOME_FILTERS.join(', ')}, got: "${text}"`);
    }
    outcome = text as WaitRowOutcome;
  }

  const limit = parseDigits(query['limit'], 'limit', { min: 1, max: MAX_HISTORY_LIMIT, expected: `an integer between 1 and ${MAX_HISTORY_LIMIT}` });
  const page = parseDigits(query['page'], 'page', { min: 0, expected: 'an integer >= 0' });
  const offset = parseDigits(query['offset'], 'offset', { min: 0, expected: 'an integer >= 0' });
  if (page !== undefined && offset !== undefined) {
    throw new InvalidQueryError('page and offset cannot be combined: use page (with limit) or offset, not both');
  }
  if (page !== undefined && !Number.isSafeInteger(page * (limit ?? DEFAULT_HISTORY_LIMIT))) {
    throw new InvalidQueryError(`page * limit must be a safe integer, got page="${page}" limit="${limit ?? DEFAULT_HISTORY_LIMIT}"`);
  }
  const sinceMs = parseDigits(query['sinceMs'], 'sinceMs', { min: 0, onlyCheckSafeInteger: true, expected: 'an integer >= 0' });

  return {
    filter: { ...(name !== undefined && { name }), ...(outcome !== undefined && { outcome }), ...(sinceMs !== undefined && { sinceMs }) },
    pagination: { ...(limit !== undefined && { limit }), ...(offset !== undefined && { offset }), ...(page !== undefined && { page }) },
  };
}
