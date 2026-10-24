import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const doc = yaml.load(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsl-views/activity-widget.yaml'), 'utf-8')) as Node;
const items = doc['items'] as Node[];
const row = items[0] as Node;
const charts = items.filter((item) => item['$type'] === 'Chart');

describe('activity-widget.yaml', () => {
  it('reads the activity route and the series route', () => {
    const sources = doc['$sources'] as Record<string, Node>;
    expect(sources['activity']?.['url']).toBe('GET /api/modules/queue/activity');
    expect(sources['series']?.['url']).toBe('GET /api/modules/queue/activity/series');
  });

  // `items` is the key the stack reads (a `children` key renders blank)
  it('is a column: the three counts in one row, then each chart under a caption', () => {
    expect(doc['$type']).toBe('VerticalStack');
    expect(doc['children']).toBeUndefined();
    expect(items.map((item) => item['$type'])).toEqual(['HorizontalStack', 'Badge', 'Chart', 'Badge', 'Chart']);
  });

  // Dashboard columns are about 270 px wide: four tiles in a row wrap their labels
  it('shows the last 5 minutes, 1 hour and 24 hours in one row of at most three tiles, in that order', () => {
    const tiles = row['items'] as Node[];
    expect(tiles.length).toBeLessThanOrEqual(3);
    expect(tiles.map((tile) => tile['label'])).toEqual(['5 min', '1 h', '24 h']);
    expect(tiles.map((tile) => tile['value'])).toEqual([
      '$sources.activity.last5Min',
      '$sources.activity.last60Min',
      '$sources.activity.last24Hours',
    ]);
  });

  it('says what each chart plots: a caption before it', () => {
    expect(items.filter((item) => item['$type'] === 'Badge').map((caption) => caption['label'])).toEqual(['Per 5 min, last hour', 'Per hour, last 24 h']);
  });
});

describe('activity-widget.yaml charts', () => {
  it('plot the series route: the last hour then the last day, labelled by the preformatted slice start', () => {
    expect(charts.map((chart) => chart['data'])).toEqual(['$sources.series.lastHour', '$sources.series.lastDay']);
    for (const chart of charts) {
      expect(chart['xAxisKey']).toBe('label');
      expect(chart['xAxisType']).toBe('category');
    }
  });

  it('give their series the theme colour (a raw colour fails the view rules and breaks dark mode; without one the bars render black)', () => {
    for (const chart of charts) {
      const [series] = chart['series'] as Node[];
      expect(series?.['key']).toBe('events');
      expect(series?.['color']).toBe('var(--color-primary)');
    }
  });

  it('are inline sparklines whose y values are counts, not bytes (Chart defaults to bytes: 1753 prints "1.8 KB")', () => {
    for (const chart of charts) {
      expect(chart['variant']).toBe('sparkline');
      expect(chart['yFormat']).toBe('number');
    }
  });
});
