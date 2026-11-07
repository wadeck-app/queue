import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

type Node = Record<string, unknown>;

const doc = yaml.load(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../dsl-views/relay-badge.yaml'), 'utf-8')) as Node;

/**
 * The navbar badge reads GET /relay on every page. When that route fails (it answers a JSON { error } when the relay runs but does not answer its status),
 * the source has no `label` or `tone`: the badge must not be drawn from nothing (an empty or default badge would read as a state), and it must never say
 * "connected" unless the relay answered that it is.
 */
describe('relay-badge.yaml', () => {
  it('reads the relay route, polled', () => {
    expect(doc['$sources']).toEqual({ relay: { url: 'GET /api/modules/queue/relay', poll: '30s' } });
  });

  it('is shown only when the route answered a label: it is bound to the very field it displays', () => {
    expect(doc['label']).toBe('$sources.relay.label');
    expect(doc['$if']).toBe('$sources.relay.label');
  });

  it('takes its tone from the answer too, with no static fallback that could claim a state', () => {
    expect(doc['variant']).toBe('$sources.relay.tone');
    expect(JSON.stringify(doc)).not.toMatch(/connected/i);
  });
});
