import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { LOG_OUTCOMES } from '@wadeck-app/queue-core';

type Node = Record<string, unknown>;

const doc = yaml.load(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsl-views/logs-page.yaml'), 'utf-8')) as Node;
const sections = doc['sections'] as Node[];
const table = sections.find((section) => section['$type'] === 'DataTable') as Node;
const bar = sections.find((section) => section['$type'] === 'HorizontalStack' && (section['items'] as Node[]).some((item) => item['$type'] === 'SearchBar')) as { items: Node[] };

describe('logs-page.yaml', () => {
  it('sends the filters of the URL to the route', () => {
    const source = (doc['$sources'] as Record<string, Node>)['logs'] as { url: string; params: Record<string, string> };
    expect(source.url).toBe('GET /api/modules/queue/logs');
    expect(source.params).toEqual({ limit: '$urlParam.size', date: '$urlParam.date', outcome: '$urlParam.outcome', event: '$urlParam.event' });
  });

  it('keeps one row to the strict minimum: the time, the result and the event', () => {
    expect((table['columns'] as Node[]).map((column) => column['key'])).toEqual(['time', 'outcome', 'event']);
  });

  it('shows the result as a badge for every outcome the route knows', () => {
    const outcome = (table['columns'] as Node[]).find((column) => column['key'] === 'outcome') as { badge: Record<string, string> };
    expect(Object.keys(outcome.badge).sort()).toEqual([...LOG_OUTCOMES].sort());
  });

  it('puts the detail in an expanded row, like the payload of the History page', () => {
    const expansion = table['expansion'] as Node;
    expect(expansion['$type']).toBe('JsonViewer');
    // JsonViewer gets no row otherwise and renders an empty block
    expect(expansion['row']).toBe('$ctx.row');
    expect(expansion['field']).toBe('detailsText');
  });

  it('offers the filters of the route: event name and every outcome, bound to the URL', () => {
    expect(bar.items.map((item) => [item['$type'], item['urlParam']])).toEqual([
      ['SearchBar', 'event'],
      ['CompactSelect', 'outcome'],
    ]);
    const select = bar.items.find((item) => item['$type'] === 'CompactSelect') as { options: Array<{ value: string }> };
    expect(select.options.map((option) => option.value)).toEqual([...LOG_OUTCOMES]);
  });
});
