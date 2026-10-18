import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const doc = yaml.load(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsl-views/activity-widget.yaml'), 'utf-8')) as Node;
const items = doc['items'] as Node[];

describe('activity-widget.yaml', () => {
  it('reads the activity route', () => {
    const source = (doc['$sources'] as Record<string, Node>)['activity'];
    expect(source?.['url']).toBe('GET /api/modules/queue/activity');
  });

  it('is one row of three tiles; `items` is the key HorizontalStack reads (a `children` key renders blank)', () => {
    expect(doc['$type']).toBe('HorizontalStack');
    expect(doc['children']).toBeUndefined();
    expect(items.map((item) => item['$type'])).toEqual(['StatTile', 'StatTile', 'StatTile']);
  });

  it('shows the last 5 minutes, 60 minutes and 24 hours, in that order', () => {
    expect(items.map((item) => item['label'])).toEqual(['Events, last 5 min', 'Events, last 60 min', 'Events, last 24 h']);
    expect(items.map((item) => item['value'])).toEqual([
      '$sources.activity.last5Min',
      '$sources.activity.last60Min',
      '$sources.activity.last24Hours',
    ]);
  });
});
