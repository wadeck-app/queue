import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const viewsDir = join(dirname(fileURLToPath(import.meta.url)), '../dsl-views');
const load = (name: string): Node => yaml.load(readFileSync(join(viewsDir, name), 'utf-8')) as Node;
const columnKeys = (table: Node): unknown[] => (table['columns'] as Node[]).map((column) => column['key']);

describe('top-events-widget.yaml', () => {
  const doc = load('top-events-widget.yaml');

  it('is a table of the events pushed most in the last 24 h, from the breakdown route', () => {
    expect((doc['$sources'] as Record<string, Node>)['breakdown']?.['url']).toBe('GET /api/modules/queue/breakdown');
    expect(doc['$type']).toBe('DataTable');
    expect(doc['rows']).toBe('$sources.breakdown.topEvents');
    expect(columnKeys(doc)).toEqual(['event', 'count']);
  });
});

describe('subscribers-page.yaml, last 24 hours table', () => {
  const sections = load('subscribers-page.yaml')['sections'] as Node[];
  const tables = sections.filter((section) => section['$type'] === 'DataTable');

  it('shows the configured subscribers, then how each ended over the last 24 h from the breakdown route', () => {
    expect(tables.map((table) => table['rows'])).toEqual(['$sources.subscribers.subscribers', '$sources.breakdown.subscribers']);
    expect(columnKeys(tables[1]!)).toEqual(['subscriberId', 'delivered', 'failedAttempts', 'givenUp', 'avgMs', 'maxMs']);
  });
});

describe('status-widget.yaml', () => {
  const doc = load('status-widget.yaml');
  const tiles = doc['items'] as Node[];

  // Dashboard columns are about 270 px wide: more than three tiles in a row wrap their labels
  it('shows, in one row of three tiles, the events never tried, the ones that failed an attempt and wait for a retry, and the DLQ', () => {
    expect(doc['$type']).toBe('HorizontalStack');
    expect(tiles.length).toBeLessThanOrEqual(3);
    expect(tiles.map((tile) => tile['value'])).toEqual(['$sources.status.pendingCount', '$sources.pending.awaitingRetry', '$sources.status.dlqCount']);
    expect((doc['$sources'] as Record<string, Node>)['pending']?.['url']).toBe('GET /api/modules/queue/pending');
  });
});

describe('hourly chart (the last 24 h, counts per hour)', () => {
  const widgetCharts = (load('activity-widget.yaml')['items'] as Node[]).filter((item) => item['$type'] === 'Chart');

  it('the activity widget plots the hourly series as counts, not bytes (1753 would print "1.8 KB")', () => {
    expect(widgetCharts[1]?.['data']).toBe('$sources.series.lastDay');
    expect(widgetCharts[1]?.['yFormat']).toBe('number');
    expect(widgetCharts[1]?.['xAxisType']).toBe('category');
  });
});

describe('overview-page.yaml', () => {
  const doc = load('overview-page.yaml');
  const sections = doc['sections'] as Node[];
  const bar = sections[0] as { items: Node[] };
  const charts = sections.filter((section) => section['$type'] === 'Chart');

  it('reads one source for the whole page, with the period of the URL', () => {
    const overview = (doc['$sources'] as Record<string, Node>)['overview'] as { url: string; params: Record<string, string> };
    expect(overview.url).toBe('GET /api/modules/queue/overview');
    expect(overview.params).toEqual({ range: '$urlParam.range' });
  });

  it('offers the periods the route accepts, in the URL so that a link keeps the period', () => {
    const select = bar.items.find((item) => item['$type'] === 'CompactSelect') as { urlParam: string; options: Array<{ value: string }> };
    expect(select.urlParam).toBe('range');
    expect(select.options.map((option) => option.value)).toEqual(['1h', '6h', '24h', '3d', '7d']);
  });

  it('plots events and failures as counts, not bytes, in theme colours, failures only when there are some', () => {
    expect(charts.map((chart) => chart['data'])).toEqual(['$sources.overview.events', '$sources.overview.failures']);
    for (const chart of charts) {
      expect(chart['yFormat']).toBe('number');
      expect(chart['xAxisType']).toBe('category');
      for (const series of chart['series'] as Node[]) {
        expect(series['color']).toMatch(/^var\(--color-[a-z-]+\)$/);
      }
    }
    expect(charts[1]?.['$if']).toBe('$sources.overview.hasFailures');
  });
});

describe('pending-page.yaml', () => {
  const doc = load('pending-page.yaml');
  const actions = doc['$actions'] as Record<string, Node>;
  const table = (doc['sections'] as Node[]).find((section) => section['$type'] === 'DataTable') as Node;
  const actionColumn = (table['columns'] as Node[]).find((column) => column['type'] === 'actions') as Node;

  it('retries an event in one click from its row, with the id of the row in the URL (no select to fill)', () => {
    expect(actions['retryPending']?.['url']).toBe('POST /api/modules/queue/retry/{id}');
  });

  it('says what happened, on success and on failure', () => {
    for (const action of Object.values(actions)) {
      expect(action['successMessage']).toBeTruthy();
      expect(action['errorPrefix']).toBeTruthy();
    }
  });

  it('offers to give up all the stuck events at once, only when there are some, after a confirmation that says what happens to them', () => {
    expect(actions['giveUpStuck']?.['url']).toBe('POST /api/modules/queue/pending/give-up-stuck');
    expect(String(actions['giveUpStuck']?.['confirm'])).toMatch(/dead-letter queue/i);
    const sections = doc['sections'] as Node[];
    const warning = sections.find((section) => section['$if'] === '$sources.pending.stuckCount' && section['$type'] === 'Badge');
    expect(warning?.['label']).toBe('$sources.pending.stuckText');
    const form = sections.find((section) => section['$type'] === 'Form') as Node;
    expect(form['$if']).toBe('$sources.pending.stuckCount');
    expect(form['onSubmit']).toBe('$ctx.giveUpStuck');
  });

  it('gives up an event that nobody retries any more from its row: it moves to the DLQ, after a confirmation that says so', () => {
    expect((actionColumn['items'] as Node[]).map((item) => item['action'])).toEqual(['retryPending', 'giveUpPending']);
    expect(actions['giveUpPending']?.['url']).toBe('POST /api/modules/queue/pending/{id}/give-up');
    expect(String(actions['giveUpPending']?.['confirm'])).toMatch(/dead-letter queue/i);
  });
});

describe('history-page.yaml row action', () => {
  const doc = load('history-page.yaml');
  const actions = doc['$actions'] as Record<string, Node>;
  const table = (doc['sections'] as Node[]).find((section) => section['$type'] === 'DataTable') as Node;
  const actionColumn = (table['columns'] as Node[]).find((column) => column['type'] === 'actions') as Node;

  it('replays an event from its row, with its event id in the URL', () => {
    expect((actionColumn['items'] as Node[]).map((item) => item['action'])).toEqual(['replayEvent']);
    expect(actions['replayEvent']?.['url']).toBe('POST /api/modules/queue/history/{eventId}/replay');
  });

  it('confirms before running the subscribers again, and says what happened', () => {
    expect(String(actions['replayEvent']?.['confirm'])).toMatch(/subscribers/i);
    expect(actions['replayEvent']?.['successMessage']).toBeTruthy();
    expect(actions['replayEvent']?.['errorPrefix']).toBeTruthy();
  });
});

describe('dlq-page.yaml', () => {
  const doc = load('dlq-page.yaml');
  const actions = doc['$actions'] as Record<string, Node>;
  const table = (doc['sections'] as Node[]).find((section) => section['$type'] === 'DataTable') as Node;
  const actionColumn = (table['columns'] as Node[]).find((column) => column['type'] === 'actions') as Node;

  it('replays or clears an entry in one click from its row, with the row id in the URL', () => {
    const items = actionColumn['items'] as Node[];
    expect(items.map((item) => item['action'])).toEqual(['replayEntry', 'clearEntry']);
    expect(actions['replayEntry']?.['url']).toBe('POST /api/modules/queue/dlq/{id}/replay');
    expect(actions['clearEntry']?.['url']).toBe('POST /api/modules/queue/dlq/{id}/clear');
  });

  it('confirms before dropping an entry and says what happened, on success and on failure', () => {
    expect(String(actions['clearEntry']?.['confirm'])).toMatch(/cannot be recovered/);
    for (const action of Object.values(actions)) {
      expect(action['successMessage']).toBeTruthy();
      expect(action['errorPrefix']).toBeTruthy();
    }
  });
});
