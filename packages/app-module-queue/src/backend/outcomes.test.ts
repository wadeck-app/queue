import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOutcomes } from './outcomes.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// mid-slice on any local clock
const NOW = Date.parse('2026-01-02T12:00:00.000Z') + 150_000;

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-outcomes-'));
  mkdirSync(join(configDir, 'history'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeDay(date: string, records: object[]): void {
  writeFileSync(join(configDir, 'history', `${date}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const outcome = (atMs: number, status: string) => ({ ts: new Date(atMs).toISOString(), type: 'outcome', eventId: 'e', event: 'onFoo', subscriberId: 'onFoo[0]', status });

describe('getOutcomes', () => {
  it('totals how the dispatches of the last 24 hours ended, under names a reader understands', () => {
    writeDay('2026-01-02', [outcome(NOW - MINUTE, 'success'), outcome(NOW - 2 * HOUR, 'success'), outcome(NOW - 3 * HOUR, 'failed'), outcome(NOW - HOUR, 'dlq')]);
    writeDay('2026-01-01', [outcome(NOW - 23 * HOUR, 'failed'), outcome(NOW - 30 * HOUR, 'success')]);
    expect(getOutcomes(configDir, NOW).last24Hours).toEqual({ delivered: 2, failedAttempts: 2, givenUp: 1 });
  });

  it('gives 24 hourly points of failures, oldest first, whose totals match the counters', () => {
    writeDay('2026-01-02', [outcome(NOW - MINUTE, 'failed'), outcome(NOW - MINUTE, 'dlq'), outcome(NOW - 5 * HOUR, 'failed')]);
    const { series, last24Hours } = getOutcomes(configDir, NOW);
    expect(series).toHaveLength(24);
    expect(series.at(-1)).toMatchObject({ failedAttempts: 1, givenUp: 1 });
    expect(series.every((point) => /^\d{2}:\d{2}$/.test(point.label))).toBe(true);
    expect(series.reduce((total, p) => total + p.failedAttempts, 0)).toBe(last24Hours.failedAttempts);
    expect(series.reduce((total, p) => total + p.givenUp, 0)).toBe(last24Hours.givenUp);
  });

  it('says whether anything failed, so the chart can stay hidden when there is nothing to draw', () => {
    writeDay('2026-01-02', [outcome(NOW - MINUTE, 'success')]);
    expect(getOutcomes(configDir, NOW).hasFailures).toBe(false);
    writeDay('2026-01-02', [outcome(NOW - MINUTE, 'success'), outcome(NOW - MINUTE, 'dlq')]);
    expect(getOutcomes(configDir, NOW).hasFailures).toBe(true);
    writeDay('2026-01-02', [outcome(NOW - MINUTE, 'failed')]);
    expect(getOutcomes(configDir, NOW).hasFailures).toBe(true);
  });

  it('is all zeros when nothing was recorded, whether the history folder is empty or missing', () => {
    const zeros = { delivered: 0, failedAttempts: 0, givenUp: 0 };
    expect(getOutcomes(configDir, NOW).last24Hours).toEqual(zeros);
    expect(getOutcomes(join(configDir, 'nowhere'), NOW).last24Hours).toEqual(zeros);
  });
});
