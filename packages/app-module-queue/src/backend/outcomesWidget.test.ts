import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const doc = yaml.load(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsl-views/outcomes-widget.yaml'), 'utf-8')) as Node;
const items = doc['items'] as Node[];

describe('outcomes-widget.yaml', () => {
  it('reads the outcomes route and stacks its tiles and chart (dashboard columns are ~270 px wide)', () => {
    expect((doc['$sources'] as Record<string, Node>)['outcomes']?.['url']).toBe('GET /api/modules/queue/outcomes');
    expect(doc['$type']).toBe('VerticalStack');
    expect(items.map((item) => item['$type'])).toEqual(['StatTile', 'StatTile', 'StatTile', 'Chart']);
  });

  it('shows what the route calls delivered, failedAttempts and givenUp', () => {
    const tiles = items.filter((item) => item['$type'] === 'StatTile');
    expect(tiles.map((tile) => tile['value'])).toEqual([
      '$sources.outcomes.last24Hours.delivered',
      '$sources.outcomes.last24Hours.failedAttempts',
      '$sources.outcomes.last24Hours.givenUp',
    ]);
  });

  it('draws failures per hour as a sparkline of counts, in theme colours (a raw colour fails the view rules)', () => {
    const chart = items.find((item) => item['$type'] === 'Chart') as Node;
    expect(chart['variant']).toBe('sparkline');
    expect(chart['yFormat']).toBe('number');
    expect(chart['data']).toBe('$sources.outcomes.series');
    // an empty chart box says nothing: it is only drawn when something failed
    expect(chart['$if']).toBe('$sources.outcomes.hasFailures');
    const series = chart['series'] as Node[];
    expect(series.map((s) => s['key'])).toEqual(['failedAttempts', 'givenUp']);
    for (const s of series) {
      expect(s['color']).toMatch(/^var\(--color-[a-z-]+\)$/);
    }
  });
});
