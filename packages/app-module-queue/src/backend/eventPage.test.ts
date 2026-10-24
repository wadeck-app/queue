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

  it('edits the example in a monospace text area bound to a page variable seeded from the declared example', () => {
    expect(doc['$vars']).toEqual({ payload: '$sources.event.exampleText' });
    expect(find(doc, 'FieldTextarea')).toEqual([expect.objectContaining({ bind: 'payload', mono: true, $if: '$sources.event.hasExample' })]);
  });

  it('validates the text, keeping the answer and the text that was validated', () => {
    const actions = doc['$actions'] as Record<string, Node>;
    expect(actions['validatePayload']).toMatchObject({ url: 'POST /api/modules/queue/events/{name}/validate-payload', resultKey: 'validation', requestKey: 'validated' });
    const validate = find(doc, 'ActionButton').find((button) => button['action'] === 'validatePayload');
    expect(validate).toMatchObject({ body: { payload: '$vars.payload' } });
  });

  it('enables the rocket only while the current text is the one that was validated without a problem', () => {
    const push = find(doc, 'ActionButton').find((button) => button['action'] === 'pushTest');
    expect(push).toMatchObject({
      icon: 'rocket',
      iconOnly: true,
      label: 'Push test event',
      $if: '$sources.event.canPushTest',
      disabled: '!$validation.valid || $vars.payload != $validated.payload',
      body: { payload: '$vars.payload' },
    });
    expect((doc['$actions'] as Record<string, Node>)['pushTest']).toMatchObject({ url: 'POST /api/modules/queue/events/{name}/push-test' });
  });

  it('lists the validation problems with their paths', () => {
    const table = find(doc, 'DataTable').find((candidate) => candidate['rows'] === '$validation.errors');
    expect(table).toMatchObject({ $if: '$validation.errors.length', columns: [{ key: 'path' }, { key: 'message' }] });
    expect(find(doc, 'Badge')).toContainEqual({ $type: 'Badge', $if: '$validation.errors.length', label: '$validation.verdict', variant: 'warning' });
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
