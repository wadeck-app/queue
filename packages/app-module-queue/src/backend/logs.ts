import { LOG_OUTCOMES, readLogRecords, type LogOutcome } from '@wadeck-app/queue-core';
import { InvalidQueryError } from './errors.js';
import { parseDigits, validateSingleString, type QueryParams } from './historyQuery.js';

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2000;

export interface LogRow {
  /** HH:MM:SS (UTC, as stored). */
  time: string;
  /** ok ran a subscriber, miss skipped it (filter did not match), fail an attempt failed, dlq given up, info anything else. */
  outcome: LogOutcome;
  event: string;
  subscriberId?: string;
  /** The whole record, pretty-printed: what the expanded row shows. */
  detailsText: string;
}

export interface LogsResponse {
  /** Day shown (UTC, YYYY-MM-DD). */
  date: string;
  /** False when nothing was logged that day. */
  present: boolean;
  /** Matching records of that day older than the ones returned. */
  omitted: number;
  /** One short row per record, newest first (the dashboard shows the latest without scrolling). */
  records: LogRow[];
}

function parseOutcome(param: unknown): LogOutcome | undefined {
  if (param === undefined || param === '') {
    return undefined;
  }
  const outcome = validateSingleString(param, 'outcome');
  if (!(LOG_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new InvalidQueryError(`outcome must be one of ${LOG_OUTCOMES.join(', ')}, got: "${outcome}"`);
  }
  return outcome as LogOutcome;
}

/** The last records of a day's dispatch log, one short row each, filtered by outcome and event before the limit. */
export function getLogs(configDir: string, query: QueryParams): LogsResponse {
  const limit = parseDigits(query['limit'], 'limit', {
    min: 1,
    max: MAX_LOG_LINES,
    expected: `an integer between 1 and ${MAX_LOG_LINES}`,
  }) ?? DEFAULT_LOG_LINES;

  let date: string | undefined;
  if (query['date'] !== undefined && query['date'] !== '') {
    date = validateSingleString(query['date'], 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new InvalidQueryError(`date must be a day as YYYY-MM-DD, got: "${date}"`);
    }
  }
  const outcome = parseOutcome(query['outcome']);
  const event = query['event'] !== undefined && query['event'] !== '' ? validateSingleString(query['event'], 'event') : undefined;

  const result = readLogRecords(configDir, { limit, ...(date !== undefined && { date }), ...(outcome !== undefined && { outcome }), ...(event !== undefined && { event }) });
  return {
    date: result.date,
    present: result.present,
    omitted: result.omitted,
    records: result.records.map((record) => ({
      time: record.time,
      outcome: record.outcome,
      event: record.event,
      subscriberId: record.subscriberId,
      detailsText: JSON.stringify(record.entry, null, 2),
    })),
  };
}
