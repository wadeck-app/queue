import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { getLogFiles } from './logFiles.js';
import { registeredRoutes } from './registeredRoutes.testUtil.js';

type Node = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const doc = yaml.load(readFileSync(join(here, '../dsl-views/log-files-page.yaml'), 'utf-8')) as Node;
const sections = doc['sections'] as Node[];
const actions = doc['$actions'] as Record<string, { url: string; confirm?: string; reloadSources?: boolean; errorPrefix?: string; successMessage?: string }>;
const tables = sections.filter((s) => s['$type'] === 'DataTable') as Array<{ rows: string; columns: Node[] }>;
const registered = registeredRoutes();

// "POST /api/modules/queue/log-files/{kind}/..." -> "POST /log-files/:kind/..."
function routeOf(url: string): string {
  return url.replace('/api/modules/queue', '').replace(/\{(\w+)\}/g, ':$1');
}

function rowActions(table: { columns: Node[] }): Array<Record<string, unknown>> {
  const column = table.columns.find((c) => c['type'] === 'actions') as { items: Array<Record<string, unknown>> } | undefined;
  return column?.items ?? [];
}

describe('log-files-page.yaml', () => {
  it('reads the log-files route and names no other source (no index access: the DSL renders nothing for sections[0])', () => {
    expect((doc['$sources'] as Record<string, { url: string }>)['files']?.url).toBe('GET /api/modules/queue/log-files');
    expect(readFileSync(join(here, '../dsl-views/log-files-page.yaml'), 'utf-8')).not.toMatch(/\[\d+\]/);
  });

  it('binds only keys the route answers', () => {
    const response = getLogFiles(join(here, 'no-such-dir-for-the-page-test')) as unknown as Record<string, unknown>;
    const text = readFileSync(join(here, '../dsl-views/log-files-page.yaml'), 'utf-8');
    for (const [, path] of text.matchAll(/\$sources\.files\.([A-Za-z.]+)/g)) {
      let node: unknown = response;
      for (const key of path!.split('.')) {
        // lastPrune and warning exist only when there is something to say; length is the array property
        if (key === 'lastPrune' || key === 'warning' || key === 'length') break;
        node = (node as Record<string, unknown>)[key];
        if (node === undefined) throw new Error(`the page binds $sources.files.${path} but the route does not answer ${key}`);
      }
    }
  });

  it('has one table for the logs, one for the history and one for the queue files, with the format: bytes size column', () => {
    expect(tables.map((t) => t.rows)).toEqual(['$sources.files.logs.files', '$sources.files.history.files', '$sources.files.queueFiles']);
    for (const table of tables) {
      expect(table.columns.find((c) => c['key'] === 'bytes')).toMatchObject({ format: 'bytes' });
    }
  });

  it('shows the zone of each day and the status with its reason', () => {
    const keys = tables[0]!.columns.map((c) => c['key']);
    expect(keys).toEqual(['name', 'dayText', 'bytes', 'modifiedAt', 'status', 'reasonText', undefined]);
    const status = tables[0]!.columns.find((c) => c['key'] === 'status') as { badge: Record<string, string> };
    expect(Object.keys(status.badge).sort()).toEqual(['kept', 'protected', 'prune']);
  });

  it('deletes a row only when canDelete, with the action of its own kind (the confirm text is static); the queue files have no action', () => {
    expect(rowActions(tables[0]!)).toEqual([expect.objectContaining({ action: 'deleteLogsFile', condition: 'canDelete' })]);
    expect(rowActions(tables[1]!)).toEqual([expect.objectContaining({ action: 'deleteHistoryFile', condition: 'canDelete' })]);
    expect(rowActions(tables[2]!)).toEqual([]);
  });

  it('every action name used by a button or a row exists, and every action reloads the sources', () => {
    const used = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        if (typeof record['action'] === 'string') used.add(record['action']);
        Object.values(record).forEach(walk);
      }
    };
    walk(sections);
    expect([...used].sort()).toEqual(['deleteHistoryFile', 'deleteLogsFile', 'pruneHistory', 'pruneLogs']);
    for (const name of Object.keys(actions)) {
      expect(actions[name]!.reloadSources, name).toBe(true);
      expect(actions[name]!.confirm, name).toBeTruthy();
      expect(actions[name]!.errorPrefix, name).toBeTruthy();
      // the toast shows the response message: a static successMessage would hide the counts
      expect(actions[name]!.successMessage, name).toBeUndefined();
    }
  });

  it('calls routes that are registered, with literal kinds for the prune and placeholders for the delete', () => {
    expect(actions['pruneLogs']!.url).toBe('POST /api/modules/queue/log-files/logs/prune');
    expect(actions['pruneHistory']!.url).toBe('POST /api/modules/queue/log-files/history/prune');
    expect(actions['deleteLogsFile']!.url).toBe('POST /api/modules/queue/log-files/{kind}/{day}/{variant}/delete');
    expect(actions['deleteHistoryFile']!.url).toBe(actions['deleteLogsFile']!.url);
    // The literal prune URLs are matched by the parameterised route
    expect(registered).toContain('POST /log-files/:kind/prune');
    expect(registered).toContain('POST /log-files/:kind/:day/:variant/delete');
    expect(routeOf(actions['deleteLogsFile']!.url)).toBe('POST /log-files/:kind/:day/:variant/delete');
  });

  it('the history confirm says the events can no longer be replayed and the counters drop; the prune confirms say it cannot be undone', () => {
    expect(actions['deleteHistoryFile']!.confirm).toMatch(/can no longer be replayed/);
    expect(actions['deleteHistoryFile']!.confirm).toMatch(/No payload recorded/);
    expect(actions['deleteHistoryFile']!.confirm).toMatch(/Overview and Activity/);
    expect(actions['pruneHistory']!.confirm).toMatch(/can no longer be replayed/);
    for (const name of ['pruneLogs', 'pruneHistory', 'deleteLogsFile', 'deleteHistoryFile']) {
      expect(actions[name]!.confirm, name).toMatch(/cannot be recovered/);
    }
  });

  it('shows "Prune by policy" only when something would be pruned, once per directory', () => {
    const buttons = sections.filter((s) => s['$type'] === 'ActionButton');
    expect(buttons).toEqual([
      expect.objectContaining({ action: 'pruneLogs', $if: '$sources.files.logs.prunableCount', label: 'Prune by policy' }),
      expect.objectContaining({ action: 'pruneHistory', $if: '$sources.files.history.prunableCount', label: 'Prune by policy' }),
    ]);
  });

  it('shows the usage as a progress bar with its own label, and the last action only when there is one', () => {
    const bars = sections.filter((s) => s['$type'] === 'Progress');
    expect(bars.map((b) => [b['value'], b['max'], b['valueLabel']])).toEqual([
      ['$sources.files.logs.totalBytes', '$sources.files.logs.maxTotalBytes', '$sources.files.logs.usageText'],
      ['$sources.files.history.totalBytes', '$sources.files.history.maxTotalBytes', '$sources.files.history.usageText'],
    ]);
    const card = sections.find((s) => s['$type'] === 'Card') as Node;
    expect(card['$if']).toBe('$sources.files.lastPrune');
    expect(JSON.stringify(card)).toContain('$sources.files.lastPrune.text');
  });

  it('declares the dsl-ui version it needs', () => {
    expect(readFileSync(join(here, '../dsl-views/log-files-page.yaml'), 'utf-8')).toMatch(/^# Needs dsl-ui >= /);
  });
});

describe('navigation', () => {
  it('Log files is the last nav entry (the 10th), after Queue Logs, at /log-files', () => {
    const manifest = JSON.parse(readFileSync(join(here, '../../manifest.json'), 'utf-8')) as { extensionPoints: Node[] };
    const nav = manifest.extensionPoints.filter((p) => p['kind'] === 'page' && p['slot'] === 'nav');
    expect(nav).toHaveLength(10);
    expect(nav.map((p) => p['label']).slice(-2)).toEqual(['Queue Logs', 'Queue Log files']);
    expect(nav[9]).toMatchObject({ path: '/log-files', view: { type: 'path', value: './src/dsl-views/log-files-page.yaml' } });
  });
});
