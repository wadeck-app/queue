import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8')) as { extensionPoints: Node[] };
const points = manifest.extensionPoints;

describe('pages are linkable (widgets and other pages link to /modules/queue<path>)', () => {
  const pages = points.filter((point) => point['kind'] === 'page');

  it('every page has a distinct path starting with a slash', () => {
    const paths = pages.map((page) => page['path']);
    for (const path of paths) {
      expect(path, JSON.stringify(path)).toMatch(/^(\/(:?[a-z0-9_-]+)?)+$/);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('the overview is the home page of the module', () => {
    expect(pages.find((page) => page['label'] === 'Queue Overview')?.['path']).toBe('/');
  });
});

describe('the relay badge in the navbar slot (next to the orchestrator job counts)', () => {
  const badge = points.find((point) => point['slot'] === 'navbar');

  it('is a widget of the navbar slot, and there is no relay widget on the dashboard any more', () => {
    expect(badge).toMatchObject({ kind: 'widget', slot: 'navbar' });
    expect(points.filter((point) => point['slot'] === 'dashboard').map((point) => point['label'])).not.toContain('Queue Relay');
  });

  it('shows "Relay connected" or "Relay disconnected" from the relay route, coloured by its tone', () => {
    const view = yaml.load(readFileSync(join(root, 'src/dsl-views/relay-badge.yaml'), 'utf-8')) as Node;
    expect((view['$sources'] as Record<string, Node>)['relay']?.['url']).toBe('GET /api/modules/queue/relay');
    expect(view['$type']).toBe('Badge');
    expect(view['label']).toBe('$sources.relay.label');
    expect(view['variant']).toBe('$sources.relay.tone');
  });
});
