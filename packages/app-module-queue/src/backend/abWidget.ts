import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export type Node = Record<string, unknown>;

export interface AbWidget {
  /** The whole document: `$sources` and the AbTest node. */
  doc: Node;
  /** The view of the reference variant (`initial`): what a shell without A/B experiments renders. */
  reference: Node;
  /** Every variant by name, with the view each one renders. */
  variants: Record<string, { label: string; hint: string; view: Node }>;
}

const viewsDir = join(dirname(fileURLToPath(import.meta.url)), '../dsl-views');

/** Loads a widget view that wraps its layouts in an AbTest node (an A/B test under way). Fails loudly when it does not. */
export function loadAbWidget(file: string): AbWidget {
  const doc = yaml.load(readFileSync(join(viewsDir, file), 'utf-8')) as Node;
  if (doc['$type'] !== 'AbTest') {
    throw new Error(`${file} is expected to be an AbTest node (the A/B test is over: use the view directly), got ${String(doc['$type'])}`);
  }
  const variants = doc['variants'] as AbWidget['variants'];
  const reference = variants[String(doc['initial'])]?.view;
  if (!reference) {
    throw new Error(`${file}: "initial" (${String(doc['initial'])}) is not one of the variants: ${Object.keys(variants).join(', ')}`);
  }
  return { doc, reference, variants };
}

/** Every `$sources.<name>` a view reads. */
export function sourcesRead(value: unknown): Set<string> {
  const names = new Set<string>();
  for (const match of JSON.stringify(value).matchAll(/\$sources\.([A-Za-z0-9_]+)/g)) {
    names.add(match[1] ?? '');
  }
  return names;
}
