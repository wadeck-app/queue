import { describe, it, expect } from 'vitest';
import { loadAbWidget, type Node } from './abWidget.js';

// The widget is an A/B test of layouts: these tests are about the reference one, the other layouts are in abWidgets.test.ts
const { doc, reference } = loadAbWidget('activity-widget.yaml');
const items = reference['items'] as Node[];

describe('activity-widget.yaml', () => {
  it('reads the activity route', () => {
    const source = (doc['$sources'] as Record<string, Node>)['activity'];
    expect(source?.['url']).toBe('GET /api/modules/queue/activity');
  });

  // Dashboard columns are about 270 px wide: three tiles in a row wrap their labels and overflow (seen in agent-browser)
  it('is a column of three tiles and the 5-minute chart; `items` is the key the stack reads (a `children` key renders blank)', () => {
    expect(reference['$type']).toBe('VerticalStack');
    expect(reference['children']).toBeUndefined();
    expect(items.map((item) => item['$type'])).toEqual(['StatTile', 'StatTile', 'StatTile', 'Chart', 'Chart']);
  });

  it('shows the last 5 minutes, 60 minutes and 24 hours, in that order', () => {
    const tiles = items.filter((item) => item['$type'] === 'StatTile');
    expect(tiles.map((item) => item['label'])).toEqual(['Events, last 5 min', 'Events, last 60 min', 'Events, last 24 h']);
    expect(tiles.map((item) => item['value'])).toEqual([
      '$sources.activity.last5Min',
      '$sources.activity.last60Min',
      '$sources.activity.last24Hours',
    ]);
  });
});

describe('activity-widget.yaml chart', () => {
  const chart = items.find((item) => item['$type'] === 'Chart') as Node;

  it('plots the series route of the last hour, labelled by the preformatted slice start', () => {
    const sources = doc['$sources'] as Record<string, Node>;
    expect(sources['series']?.['url']).toBe('GET /api/modules/queue/activity/series');
    expect(chart['data']).toBe('$sources.series.lastHour');
    expect(chart['xAxisKey']).toBe('label');
    expect(chart['xAxisType']).toBe('category');
  });

  it('gives its series the theme colour (a raw colour fails the view rules and breaks dark mode; without one the bars render black)', () => {
    const [series] = chart['series'] as Node[];
    expect(series?.['key']).toBe('events');
    expect(series?.['color']).toBe('var(--color-primary)');
  });
});

describe('activity-widget.yaml chart, compact form', () => {
  const chart = items.find((item) => item['$type'] === 'Chart') as Node;

  it('is an inline sparkline whose y values are counts, not bytes (Chart defaults to bytes: 1753 prints "1.8 KB")', () => {
    expect(chart['variant']).toBe('sparkline');
    expect(chart['yFormat']).toBe('number');
  });
});
