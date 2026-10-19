import { isLogDate, readLogTail } from '@wadeck-app/queue-core';
import { InvalidQueryError } from './errors.js';
import { parseDigits, validateSingleString, type QueryParams } from './historyQuery.js';

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2000;

export interface LogsResponse {
  /** Day shown (UTC, YYYY-MM-DD). */
  date: string;
  /** False when nothing was logged that day. */
  present: boolean;
  /** Records of that day older than the ones returned. */
  omitted: number;
  /** One row per log record, rendered as `queue logs` renders it (a DataTable needs rows, not strings). */
  lines: Array<{ text: string }>;
}

/** The last records of a day's dispatch log: same content and rendering as `queue logs`, read from the files. */
export function getLogs(configDir: string, query: QueryParams): LogsResponse {
  const limit = parseDigits(query['limit'], 'limit', {
    min: 1,
    max: MAX_LOG_LINES,
    expected: `an integer between 1 and ${MAX_LOG_LINES}`,
  }) ?? DEFAULT_LOG_LINES;

  let date: string | undefined;
  if (query['date'] !== undefined && query['date'] !== '') {
    date = validateSingleString(query['date'], 'date');
    if (!isLogDate(date)) {
      throw new InvalidQueryError(`date must be a day as YYYY-MM-DD, got: "${date}"`);
    }
  }

  const tail = readLogTail(configDir, { limit, date });
  return { date: tail.date, present: tail.present, omitted: tail.omitted, lines: tail.lines.map((text) => ({ text })) };
}
