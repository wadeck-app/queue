import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getActivity } from './activity.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-01-02T12:00:00.000Z');

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'app-module-activity-'));
  mkdirSync(join(configDir, 'history'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function writeDay(date: string, atMs: number[]): void {
  const lines = atMs.map((ms, i) => JSON.stringify({ ts: new Date(ms).toISOString(), type: 'trigger', eventId: `${date}-${i}`, event: 'onFoo', matchedCount: 0, totalCount: 0 }));
  writeFileSync(join(configDir, 'history', `${date}.ndjson`), lines.join('\n') + '\n');
}

describe('getActivity', () => {
  it('counts the events pushed in the last 5 minutes, 60 minutes and 24 hours', () => {
    writeDay('2026-01-02', [NOW - MINUTE, NOW - 10 * MINUTE, NOW - 3 * HOUR]);
    writeDay('2026-01-01', [NOW - 23 * HOUR, NOW - 30 * HOUR]);
    expect(getActivity(configDir, NOW)).toEqual({ last5Min: 1, last60Min: 2, last24Hours: 4 });
  });

  it('is all zeros when nothing was recorded, whether the history folder is empty or missing', () => {
    expect(getActivity(configDir, NOW)).toEqual({ last5Min: 0, last60Min: 0, last24Hours: 0 });
    expect(getActivity(join(configDir, 'nowhere'), NOW)).toEqual({ last5Min: 0, last60Min: 0, last24Hours: 0 });
  });

  it('uses the current time by default', () => {
    writeDay(new Date().toISOString().slice(0, 10), [Date.now() - 1000]);
    expect(getActivity(configDir)).toEqual({ last5Min: 1, last60Min: 1, last24Hours: 1 });
  });
});
