import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const views = join(dirname(fileURLToPath(import.meta.url)), '../dsl-views');
const load = (file: string): Node => yaml.load(readFileSync(join(views, file), 'utf-8')) as Node;

function find(node: unknown, type: string, found: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    node.forEach((item) => find(item, type, found));
  } else if (typeof node === 'object' && node !== null) {
    if ((node as Node)['$type'] === type) {
      found.push(node as Node);
    }
    Object.values(node).forEach((child) => find(child, type, found));
  }
  return found;
}

describe('event-page.yaml', () => {
  const doc = load('event-page.yaml');

  it('reads the event named in the address (/events/:name)', () => {
    expect(doc['$sources']).toMatchObject({ event: { url: 'GET /api/modules/queue/events/detail', params: { name: '$route.name' } } });
  });

  it('pushes the shown example with an icon button next to its title: the name in the url, the payload text in the body', () => {
    const [button] = find(doc, 'ActionButton');
    expect(button).toMatchObject({
      action: 'pushTest',
      icon: 'rocket',
      iconOnly: true,
      label: 'Push test event',
      $if: '$sources.event.canPushTest',
      params: { name: '$sources.event.name' },
      body: { payload: '$sources.event.exampleText' },
    });
    expect((doc['$actions'] as Record<string, Node>)['pushTest']).toMatchObject({ url: 'POST /api/modules/queue/events/{name}/push-test' });
  });

  it('puts the source in a badge that leads to the events of that source', () => {
    const badge = find(doc, 'Badge').find((candidate) => candidate['label'] === '$sources.event.sourceBadge');
    expect(badge).toMatchObject({ href: '$sources.event.sourceHref' });
  });
});

describe('pending-page.yaml', () => {
  it('gives up every stuck event with an enabled page-level button (a Form button stays disabled until its form is edited)', () => {
    const doc = load('pending-page.yaml');
    expect(find(doc, 'Form')).toEqual([]);
    expect(find(doc, 'ActionButton')).toEqual([
      { $type: 'ActionButton', $if: '$sources.pending.stuckCount', action: 'giveUpStuck', label: 'Give up all the stuck events', icon: 'archive', variant: 'danger-outline' },
    ]);
  });
});
