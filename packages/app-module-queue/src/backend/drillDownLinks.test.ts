import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// The numbers and names of the dashboard lead somewhere (drill-down): every `href` of every view must point to a page of this module,
// and its query parameters must be ones the target page really reads, or the link would land on an unfiltered page.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const viewsDir = join(root, 'src/dsl-views');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8')) as { extensionPoints: Array<Record<string, unknown>> };

type Node = Record<string, unknown>;

interface Link {
  file: string;
  href: string;
  owner: string;
}

function collectLinks(value: unknown, file: string, links: Link[], owner = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectLinks(item, file, links, owner));
  } else if (typeof value === 'object' && value !== null) {
    const node = value as Node;
    const name = typeof node['$type'] === 'string' ? node['$type'] : typeof node['key'] === 'string' ? `column ${node['key']}` : owner;
    // An href bound to a source ($sources.event.sourceHref) is built by the backend: events.test.ts checks what it answers
    if (typeof node['href'] === 'string' && !node['href'].startsWith('$')) {
      links.push({ file, href: node['href'], owner: name });
    }
    Object.values(node).forEach((child) => collectLinks(child, file, links, name));
  }
}

const links: Link[] = [];
for (const file of readdirSync(viewsDir).filter((name) => /\.ya?ml$/.test(name))) {
  collectLinks(yaml.load(readFileSync(join(viewsDir, file), 'utf-8')), file, links);
}

const pages = new Map(
  manifest.extensionPoints
    .filter((point) => point['kind'] === 'page')
    .map((point) => [String(point['path']), String(((point['view'] as Node)['value'] as string).split('/').pop())] as const),
);

// The query parameters a page reads: its controls bound to the URL and the $urlParam.<name> its sources use
function urlParamsOf(pageFile: string): Set<string> {
  const text = readFileSync(join(viewsDir, pageFile), 'utf-8');
  return new Set([...text.matchAll(/urlParam:\s*([A-Za-z]+)/g), ...text.matchAll(/\$urlParam\.([A-Za-z]+)/g)].map((match) => match[1]!));
}

describe('drill-down links of the views', () => {
  it('finds the links (the check itself works)', () => {
    expect(links.length).toBeGreaterThanOrEqual(15);
  });

  it.each(links.map((link) => [`${link.file} ${link.owner}: ${link.href}`, link] as const))('%s points to a page of the module with parameters it reads', (_label, link) => {
    const url = new URL(link.href.replace(/\{[^}]+\}/g, 'x'), 'http://app');
    expect(url.pathname.startsWith('/modules/queue')).toBe(true);
    const pagePath = url.pathname.slice('/modules/queue'.length) || '/';
    // A page path may have :param segments (/events/:name): they match any one segment
    const pageFile = [...pages].find(([path]) => new RegExp(`^${path.replace(/:[a-z0-9_-]+/gi, '[^/]+')}$`).test(pagePath))?.[1];
    expect(pageFile, `no page of the manifest has the path ${pagePath}`).toBeDefined();
    const read = urlParamsOf(pageFile!);
    for (const name of url.searchParams.keys()) {
      expect(read.has(name), `${pageFile} does not read the parameter "${name}"`).toBe(true);
    }
  });
});

describe('where the numbers lead', () => {
  const hrefsOf = (file: string): string[] => links.filter((link) => link.file === file).map((link) => link.href);

  it('the status tiles lead to the pending events and to the dead-letter queue', () => {
    expect(hrefsOf('status-widget.yaml')).toEqual(['/modules/queue/pending', '/modules/queue/pending', '/modules/queue/dlq']);
  });

  it('the outcome tiles lead to the history filtered by that outcome, and to the DLQ for what was given up', () => {
    expect(hrefsOf('outcomes-widget.yaml')).toEqual(['/modules/queue/history?status=success', '/modules/queue/history?status=failed', '/modules/queue/dlq']);
  });

  it('the activity tiles lead to the overview on the period they count', () => {
    expect(hrefsOf('activity-widget.yaml')).toEqual(['/modules/queue/?range=1h', '/modules/queue/?range=1h', '/modules/queue/?range=24h']);
  });

  it('the top events lead to the history of that event', () => {
    expect(hrefsOf('top-events-widget.yaml')).toEqual(['/modules/queue/history?event={event}']);
  });

  it('the relay badge in the navbar leads to the webhooks page', () => {
    expect(hrefsOf('relay-badge.yaml')).toEqual(['/modules/queue/webhooks']);
  });

  it('the overview numbers, event names and subscribers lead to the history, the DLQ and the filtered history', () => {
    expect(hrefsOf('overview-page.yaml')).toEqual([
      '/modules/queue/history',
      '/modules/queue/history?status=success',
      '/modules/queue/history?status=failed',
      '/modules/queue/dlq',
      '/modules/queue/history?event={event}',
      '/modules/queue/history?subscriber={subscriberId}',
    ]);
  });

  it('an event name in a table leads to its history, or to the page of that event', () => {
    expect(hrefsOf('pending-page.yaml')).toEqual(['/modules/queue/history?event={event}']);
    expect(hrefsOf('dlq-page.yaml')).toEqual(['/modules/queue/history?event={event}']);
    expect(hrefsOf('logs-page.yaml')).toEqual(['/modules/queue/history?event={event}']);
    expect(hrefsOf('history-page.yaml')).toEqual(['/modules/queue/events/{event}']);
    expect(hrefsOf('subscribers-page.yaml')).toContain('/modules/queue/events/{event}');
    expect(hrefsOf('events-page.yaml')).toEqual(['/modules/queue/events/{name}']);
  });
});
