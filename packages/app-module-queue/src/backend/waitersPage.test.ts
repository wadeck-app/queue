import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { WAITER_OUTCOME_FILTERS } from './waitersQuery.js';

type Node = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const doc = yaml.load(readFileSync(join(here, '../dsl-views/waiters-page.yaml'), 'utf-8')) as Node;
const sources = doc['$sources'] as Record<string, Node>;
const sections = doc['sections'] as Node[];
const tables = sections.filter((section) => section['$type'] === 'DataTable');
const [liveTable, historyTable] = tables as [Node, Node];
const columnsOf = (table: Node): Node[] => table['columns'] as Node[];
const column = (table: Node, key: string): Node => {
  const found = columnsOf(table).find((candidate) => candidate['key'] === key);
  if (found === undefined) {
    throw new Error(`no column ${key}`);
  }
  return found;
};

describe('waiters-page.yaml', () => {
  it('is a PageContent with two tables: waiting now, then the history', () => {
    expect(doc['$type']).toBe('PageContent');
    expect(tables).toHaveLength(2);
    expect(liveTable['rows']).toBe('$sources.waiters.waiters');
    expect(historyTable['rows']).toBe('$sources.history.entries');
  });

  it('reloads both sources every 15 s: a wait appears and disappears while the page is open', () => {
    expect(sources['waiters']?.['poll']).toBe('15s');
    expect(sources['history']?.['poll']).toBe('15s');
  });

  it('sends the paging and the two filters of the history to the route, nothing else', () => {
    expect(sources['history']?.['params']).toEqual({ page: '$urlParam.page', limit: '$urlParam.size', name: '$urlParam.name', outcome: '$urlParam.outcome' });
  });

  it('waiting now: name, anonymous badge, events, filters, label, wake, since, last seen, stale badge', () => {
    expect(columnsOf(liveTable).map((c) => c['key'])).toEqual(['name', 'anonymousText', 'eventsText', 'whensText', 'label', 'contactText', 'since', 'lastSeen', 'staleText']);
    expect(column(liveTable, 'anonymousText')['badge']).toEqual({ anonymous: 'info' });
    expect(column(liveTable, 'staleText')['badge']).toEqual({ stale: 'warning' });
  });

  it('history: name, events, filters, label, from, to, duration, outcome badge, event link', () => {
    expect(columnsOf(historyTable).map((c) => c['key'])).toEqual(['name', 'anonymousText', 'eventsText', 'whensText', 'label', 'from', 'to', 'durationText', 'outcome', 'event']);
  });

  it('every date is formatted by the shell (format: datetime), never by the module', () => {
    for (const [table, key] of [[liveTable, 'since'], [liveTable, 'lastSeen'], [historyTable, 'from'], [historyTable, 'to']] as const) {
      expect(column(table, key)['format'], key).toBe('datetime');
    }
  });

  it('the outcome badge has a tone for every outcome the route filters on, and only those', () => {
    const badge = column(historyTable, 'outcome')['badge'] as Record<string, string>;
    expect(Object.keys(badge).sort()).toEqual([...WAITER_OUTCOME_FILTERS].sort());
    expect(badge).toMatchObject({ matched: 'success', timeout: 'warning', refused: 'danger', lost: 'danger', waiting: 'info' });
  });

  it('the event links to the History page filtered on that event, like the Pending and DLQ pages, with the event id as tooltip', () => {
    expect(column(historyTable, 'event')['href']).toBe('/modules/queue/history?event={event}');
    expect(column(historyTable, 'event')['title']).toBe('{eventId}');
  });

  it('the filters are the name and the outcome, bound to the URL params the source reads, and send the table back to page 1', () => {
    const bar = sections.find((section) => section['$type'] === 'HorizontalStack' && (section['items'] as Node[]).some((item) => item['$type'] === 'SearchBar')) as { items: Node[] };
    expect(bar.items.map((item) => [item['$type'], item['urlParam']])).toEqual([['SearchBar', 'name'], ['CompactSelect', 'outcome']]);
    for (const item of bar.items) {
      expect(item['resetUrlParams'], String(item['urlParam'])).toEqual(['page']);
    }
  });

  it('offers exactly the outcomes the route accepts', () => {
    const bar = sections.find((section) => section['$type'] === 'HorizontalStack' && (section['items'] as Node[]).some((item) => item['$type'] === 'CompactSelect')) as { items: Node[] };
    const select = bar.items.find((item) => item['urlParam'] === 'outcome') as { options: Array<{ value: string }> };
    expect(select.options.map((option) => option.value)).toEqual([...WAITER_OUTCOME_FILTERS]);
  });

  it('pages the history like the History page: Pagination then PageSizeSelect (20, 50, 100) on the total and limit of the route', () => {
    const row = sections.find((section) => section['$type'] === 'HorizontalStack' && (section['items'] as Node[]).some((item) => item['$type'] === 'Pagination')) as { items: Node[] };
    expect(row.items[0]).toMatchObject({ $type: 'Pagination', urlParam: 'page', total: '$sources.history.total', size: '$sources.history.limit' });
    expect(row.items[1]).toMatchObject({ $type: 'PageSizeSelect', urlParam: 'size', options: [20, 50, 100], resetUrlParams: ['page'], value: '$sources.history.limit' });
  });

  it('both tables explain their empty state', () => {
    expect(String(liveTable['emptyMessage'])).toMatch(/Nobody is waiting/);
    expect(String(historyTable['emptyMessage'])).toMatch(/No wait/);
  });

  it('shows what the routes warn about (files that could not be read); the routes sweep nothing, so there is nothing to report about a sweep', () => {
    const badges = sections.filter((section) => section['$type'] === 'Badge');
    expect(badges.map((badge) => [badge['$if'], badge['variant']])).toEqual([
      ['$sources.waiters.warningText', 'warning'],
      ['$sources.history.warningText', 'warning'],
    ]);
  });
});
