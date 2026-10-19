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

  it('shows the events never tried and, apart, the ones that failed an attempt and wait for a retry', () => {
    expect(doc['$type']).toBe('VerticalStack');
    expect(tiles.map((tile) => tile['value'])).toEqual(['$sources.status.pendingCount', '$sources.pending.awaitingRetry']);
    expect((doc['$sources'] as Record<string, Node>)['pending']?.['url']).toBe('GET /api/modules/queue/pending');
  });
});
