import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listHistory } from './history.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// A torn line in a day file (a write cut short by a crash) must not make the dashboard history fail or hide the lines around it, and must be visible
let configDir: string;

beforeEach(() => {
  configDir = makeTempDir('app-module-queue-history-malformed-');
  mkdirSync(join(configDir, 'history'));
});

afterEach(() => {
  removeTempDir(configDir);
});

const TORN = '{"ts":"2026-01-01T00:00:30.000Z","type":"trigger","eventId":"torn","event":"onTorn","matchedCount":1,"tot';

function writeTornDay(): void {
  const good = (eventId: string, ts: string): string => JSON.stringify({ type: 'trigger', ts, eventId, event: 'onFoo', matchedCount: 0, totalCount: 0 });
  writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), [good('e1', '2026-01-01T00:00:00.000Z'), TORN, good('e2', '2026-01-01T00:01:00.000Z')].join('\n') + '\n');
}

describe('listHistory with a malformed line', () => {
  it('returns every readable entry and a warnings field naming the file, the count and the first line', () => {
    writeTornDay();

    const page = listHistory(configDir);

    expect(page.entries.map(e => e.eventId).sort()).toEqual(['e1', 'e2']);
    expect(page.total).toBe(2);
    expect(page.warnings).toHaveLength(1);
    expect(page.warnings![0]).toContain(join(configDir, 'history', '2026-01-01.ndjson'));
    expect(page.warnings![0]).toContain('1 malformed line');
    expect(page.warnings![0]).toContain(TORN.slice(0, 40));
  });

  it('adds warningText, the one text the page shows in its warning badge (the DSL cannot join a list)', () => {
    writeTornDay();
    expect(listHistory(configDir).warningText).toContain('1 malformed line');
  });

  it('has neither field when every line is readable', () => {
    writeFileSync(join(configDir, 'history', '2026-01-01.ndjson'), JSON.stringify({ type: 'trigger', ts: '2026-01-01T00:00:00.000Z', eventId: 'e1', event: 'onFoo', matchedCount: 0, totalCount: 0 }) + '\n');
    const page = listHistory(configDir);
    expect(page).not.toHaveProperty('warnings');
    expect(page).not.toHaveProperty('warningText');
  });
});
