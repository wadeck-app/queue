import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const doc = yaml.load(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsl-views/dlq-page.yaml'), 'utf-8')) as Node;
const sources = doc['$sources'] as Record<string, { url: string; params?: Record<string, string> }>;
const sections = doc['sections'] as Node[];

describe('dlq-page.yaml', () => {
  it('is a PageContent whose table lists the entries of the dlq route', () => {
    expect(doc['$type']).toBe('PageContent');
    expect(sources['dlq']).toEqual({ url: 'GET /api/modules/queue/dlq', params: { project: '$urlParam.project' } });
    expect(sections.find((section) => section['$type'] === 'DataTable')?.['rows']).toBe('$sources.dlq.entries');
  });

  it('offers the registered projects, only when there are some, through the project URL param', () => {
    const select = sections.find((section) => section['$type'] === 'CompactSelect');
    expect(select).toMatchObject({ urlParam: 'project', options: '$sources.projects.options', $if: '$sources.projects.options.length' });
    expect(sources['projects']?.url).toBe('GET /api/modules/queue/projects');
  });

  it('offers a replay and a clear action per row, each calling its DLQ route with the row id', () => {
    const actions = doc['$actions'] as Record<string, { url: string }>;
    expect(actions['replayEntry']?.url).toBe('POST /api/modules/queue/dlq/{id}/replay');
    expect(actions['clearEntry']?.url).toBe('POST /api/modules/queue/dlq/{id}/clear');
  });

  describe('project header (slot queue:project-header)', () => {
    it('reads the project of the URL through the project-scope route and the contributions through the slot route', () => {
      expect(sources['projectScope']).toEqual({ url: 'GET /api/modules/queue/project-scope', params: { project: '$urlParam.project' } });
      expect(sources['projectHeader']).toEqual({ url: 'GET /api/slots/queue:project-header' });
    });

    it('embeds the ExtensionSlot once, shown only for a known project', () => {
      const slots = sections.filter((section) => section['$type'] === 'ExtensionSlot');
      expect(slots).toEqual([{ $type: 'ExtensionSlot', $if: '$sources.projectScope.found', items: '$sources.projectHeader' }]);
    });
  });
});
