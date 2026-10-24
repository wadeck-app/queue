import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const text = readFileSync(join(root, 'src/dsl-views/events-page.yaml'), 'utf-8');
const doc = yaml.load(text) as Node;
const sections = doc['sections'] as Node[];
const table = sections.find((section) => section['$type'] === 'DataTable') as Node;
const columns = table['columns'] as Node[];
const bar = sections.find((section) => section['$type'] === 'HorizontalStack') as { items: Node[] };
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8')) as { extensionPoints: Node[] };

function allTypes(node: unknown): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(allTypes);
  }
  if (node !== null && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, value]) => (key === '$type' ? [String(value)] : allTypes(value)));
  }
  return [];
}

describe('events-page.yaml: what the table shows and what the expanded row shows', () => {
  const keys = columns.map((column) => column['key']);

  it('shows the description as an excerpt that cannot wrap, and the last seen time in the readable form of the backend', () => {
    const description = columns.find((column) => column['key'] === 'descriptionExcerpt');
    expect(description).toMatchObject({ label: 'Description', truncate: true });
    expect(keys).toContain('lastSeenText');
    expect(keys).not.toContain('description');
    expect(keys).not.toContain('lastSeenAt');
  });

  it('expands to the description rendered as Markdown, nothing else: the rest is on the page of the event', () => {
    expect(table['expansion']).toEqual({ $type: 'Markdown', text: '$ctx.row.description' });
  });

  it('has no test push in the list: it sits next to the example on the page of the event', () => {
    expect(columns.find((column) => column['type'] === 'actions')).toBeUndefined();
    expect(doc['$actions']).toBeUndefined();
  });

  it('links the name to the page of that event, by exact name', () => {
    expect(columns[0]).toMatchObject({ key: 'name', href: '/modules/queue/events/{name}' });
  });
});

describe('events-page.yaml', () => {
  it('is the "Queue Events" page of the nav slot at /events', () => {
    expect(manifest.extensionPoints.find((point) => point['label'] === 'Queue Events')).toEqual({
      kind: 'page',
      slot: 'nav',
      label: 'Queue Events',
      path: '/events',
      view: { type: 'path', value: './src/dsl-views/events-page.yaml' },
    });
  });

  it('reads the events route and sends the filters of the URL to it', () => {
    const source = (doc['$sources'] as Record<string, Node>)['events'] as { url: string; params: Record<string, string> };
    expect(source.url).toBe('GET /api/modules/queue/events');
    expect(source.params).toEqual({ q: '$urlParam.q', source: '$urlParam.source', status: '$urlParam.status' });
  });

  it('offers a search, a source select filled from the answer and a declared/undeclared select, all bound to the URL', () => {
    expect(bar.items.map((item) => [item['$type'], item['urlParam']])).toEqual([
      ['SearchBar', 'q'],
      ['CompactSelect', 'source'],
      ['CompactSelect', 'status'],
    ]);
    const [, source, status] = bar.items as [Node, Node, Node];
    expect(source['options']).toBe('$sources.events.sourceOptions');
    // Seen rendered: while the answer is not there yet (and with no declared source) the options are undefined and the dsl-ui of the dev shell
    // crashed the whole page (white screen), so the select only exists once it has options
    expect(source['$if']).toBe('$sources.events.sourceOptions.length');
    expect((status['options'] as Array<{ value: string }>).map((option) => option.value)).toEqual(['declared', 'undeclared']);
    // A comma inside an unquoted flow mapping splits it into a bogus extra key (this crashed the page once)
    for (const option of status['options'] as Node[]) {
      expect(Object.keys(option).sort()).toEqual(['label', 'value']);
      expect(typeof option['label']).toBe('string');
    }
  });

  it('shows a warning badge with the unreadable files when there are some', () => {
    const badge = sections.find((section) => section['$type'] === 'Badge') as Node;
    expect(badge['$if']).toBe('$sources.events.problemsText');
    expect(badge['label']).toBe('$sources.events.problemsText');
    expect(badge['variant']).toBe('warning');
  });

  it('has the columns name, source, description excerpt, 24 h, last seen, status', () => {
    expect(columns.map((column) => column['key'] ?? column['type'])).toEqual(['name', 'source', 'descriptionExcerpt', 'count24h', 'lastSeenText', 'status']);
    expect(columns[0]?.['mono']).toBe(true);
  });

  it('shows the full ISO date of the last sighting as the tooltip of the short one', () => {
    expect(columns.find((column) => column['key'] === 'lastSeenText')?.['title']).toBe('Last seen {lastSeenAt}');
  });

  it('shows the status as a badge for both statuses the route answers', () => {
    const status = columns.find((column) => column['key'] === 'status') as { badge: Record<string, string> };
    expect(Object.keys(status.badge).sort()).toEqual(['declared', 'undeclared']);
  });

  it('explains in one sentence how a program declares its events when there are none', () => {
    const message = String(table['emptyMessage']);
    expect(message).toContain('queue.registerEvents');
    expect(message).toContain('@wadeck-app/queue-sdk');
    expect(message).toContain('queue events register');
    expect(message.split('. ')).toHaveLength(1);
  });

  it('is made of DSL nodes only: no raw HTML', () => {
    expect(new Set(allTypes(doc))).toEqual(new Set(['PageContent', 'PageHeader', 'HorizontalStack', 'SearchBar', 'CompactSelect', 'Badge', 'DataTable', 'Markdown']));
    // comments may mention a tag, the nodes may not carry one
    const withoutComments = text.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(withoutComments).not.toMatch(/<\/?[a-z][a-z0-9]*[ >/]/i);
  });
});
