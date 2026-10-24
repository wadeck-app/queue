import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// A text button in a table row wraps on two lines as soon as the column is narrow ("Retry / now"): every row action is an icon
// button, its label stays the accessible name and the tooltip.

const viewsDir = join(dirname(fileURLToPath(import.meta.url)), '../dsl-views');

type Node = Record<string, unknown>;

interface RowAction {
  file: string;
  label: string;
  icon?: unknown;
}

function collect(value: unknown, file: string, found: RowAction[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collect(item, file, found));
  } else if (typeof value === 'object' && value !== null) {
    const node = value as Node;
    if (node['type'] === 'actions' && Array.isArray(node['items'])) {
      for (const item of node["items"] as Node[]) {
        found.push({ file, label: String(item['label']), icon: item['icon'] });
      }
    }
    Object.values(node).forEach((child) => collect(child, file, found));
  }
}

const actions: RowAction[] = [];
for (const file of readdirSync(viewsDir).filter((name) => /\.ya?ml$/.test(name))) {
  collect(yaml.load(readFileSync(join(viewsDir, file), 'utf-8')), file, actions);
}

describe('row actions of the views', () => {
  it('finds the row actions, or the guard below would pass on nothing', () => {
    expect(actions.length).toBeGreaterThanOrEqual(4);
  });

  it.each(actions.map((action) => [`${action.file}: ${action.label}`, action] as const))('%s is an icon button', (_name, action) => {
    expect(typeof action.icon, `${action.file}: give "${action.label}" an icon (see the icon vocabulary of dsl-ui)`).toBe('string');
  });
});
