import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { getBreakdown } from './breakdown.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

type Node = Record<string, unknown>;

const viewsDir = join(dirname(fileURLToPath(import.meta.url)), '../dsl-views');
const P = 'GET /api/modules/queue';
const Q = 'POST /api/modules/queue';

/** Every view with the exact call behind each of its sources and actions: a page wired to a neighbour's route still calls "a registered route", this is what catches it. */
const EXPECTED: Record<string, { sources: Record<string, string>; actions: Record<string, string> }> = {
  'activity-widget.yaml': { sources: { activity: `${P}/activity`, series: `${P}/activity/series` }, actions: {} },
  'dlq-page.yaml': {
    sources: { dlq: `${P}/dlq`, projects: `${P}/projects`, daemon: `${P}/daemon`, projectScope: `${P}/project-scope`, projectHeader: 'GET /api/slots/queue:project-header' },
    actions: { replayEntry: `${Q}/dlq/{id}/replay`, clearEntry: `${Q}/dlq/{id}/clear` },
  },
  'event-page.yaml': {
    sources: { event: `${P}/events/detail` },
    actions: { validatePayload: `${Q}/events/{name}/validate-payload`, pushTest: `${Q}/events/{name}/push-test` },
  },
  'events-page.yaml': { sources: { events: `${P}/events` }, actions: {} },
  'history-page.yaml': {
    sources: { history: `${P}/history`, projects: `${P}/projects`, projectScope: `${P}/project-scope`, projectHeader: 'GET /api/slots/queue:project-header' },
    actions: { replayEvent: `${Q}/history/{eventId}/replay` },
  },
  'log-files-page.yaml': {
    sources: { files: `${P}/log-files` },
    actions: {
      pruneLogs: `${Q}/log-files/logs/prune`,
      pruneHistory: `${Q}/log-files/history/prune`,
      deleteLogsFile: `${Q}/log-files/{kind}/{day}/{variant}/delete`,
      deleteHistoryFile: `${Q}/log-files/{kind}/{day}/{variant}/delete`,
    },
  },
  'logs-page.yaml': { sources: { logs: `${P}/logs` }, actions: {} },
  'outcomes-widget.yaml': { sources: { outcomes: `${P}/outcomes` }, actions: {} },
  'overview-page.yaml': { sources: { overview: `${P}/overview` }, actions: {} },
  'pending-page.yaml': {
    sources: { pending: `${P}/pending`, daemon: `${P}/daemon` },
    actions: { retryPending: `${Q}/retry/{id}`, giveUpStuck: `${Q}/pending/give-up-stuck`, giveUpPending: `${Q}/pending/{id}/give-up` },
  },
  'relay-badge.yaml': { sources: { relay: `${P}/relay` }, actions: {} },
  'status-widget.yaml': { sources: { status: `${P}/status`, pending: `${P}/pending` }, actions: {} },
  'subscribers-page.yaml': { sources: { subscribers: `${P}/subscribers`, breakdown: `${P}/breakdown` }, actions: {} },
  'top-events-widget.yaml': { sources: { breakdown: `${P}/breakdown` }, actions: {} },
  'webhooks-page.yaml': { sources: { webhooks: `${P}/relay/webhooks`, deliveries: `${P}/relay/deliveries` }, actions: {} },
};

const load = (file: string): Node => yaml.load(readFileSync(join(viewsDir, file), 'utf-8')) as Node;
const urlsOf = (block: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((block ?? {}) as Record<string, { url: string }>).map(([name, spec]) => [name, spec.url]));

describe('each view calls the routes it was designed for', () => {
  it('lists every view file: a new view must be added to the table above', () => {
    expect(readdirSync(viewsDir).filter((file) => /\.ya?ml$/.test(file)).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s', (file, expected) => {
    const doc = load(file);
    expect(urlsOf(doc['$sources'])).toEqual(expected.sources);
    expect(urlsOf(doc['$actions'])).toEqual(expected.actions);
  });
});

describe('the tables of the Webhooks and Subscribers pages read the source that holds their rows', () => {
  const rowsOf = (file: string): string[] => [...readFileSync(join(viewsDir, file), 'utf-8').matchAll(/rows:\s*\$sources\.(\w+)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`);

  it('webhooks-page: webhooks table from the webhooks route, deliveries table from the deliveries route', () => {
    expect(rowsOf('webhooks-page.yaml')).toEqual(['webhooks.webhooks', 'deliveries.deliveries']);
  });

  it('subscribers-page: the subscriber table from subscribers, the activity table from the breakdown (which answers a `subscribers` list)', () => {
    expect(rowsOf('subscribers-page.yaml')).toEqual(['subscribers.subscribers', 'breakdown.subscribers']);
    const configDir = makeTempDir('app-module-views-bindings-');
    try {
      expect(Array.isArray((getBreakdown(configDir) as unknown as Node)['subscribers'])).toBe(true);
    } finally {
      removeTempDir(configDir);
    }
  });
});
