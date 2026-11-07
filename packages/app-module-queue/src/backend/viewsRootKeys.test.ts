import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

/**
 * The renderer ignores a root key it does not know, so a stray line (a copy-paste leftover parsed as `key: value`) disappears without any error:
 * log-files-page.yaml carried `_Kept in memory only: ..._"` at its root for a while. Every root key of every view must be a known one.
 *
 * The allowed keys are the ones the views of this module use, and nothing app-core's `check` would reject:
 *  - the DSL directives of a view: `$sources`, `$actions`, `$vars` and the `$type` of the root (plus `$if`, which app-core accepts on any node);
 *  - the properties the root component reads, per root `$type` (a property of PageContent is not one of Badge): listed in ROOT_PROPS below.
 * A new root component or property is added here on purpose, after checking that the renderer reads it.
 */

const viewsDir = join(dirname(fileURLToPath(import.meta.url)), '../dsl-views');

export const ROOT_DIRECTIVES = ['$sources', '$actions', '$vars', '$type', '$if'] as const;

export const ROOT_PROPS: Readonly<Record<string, readonly string[]>> = {
  PageContent: ['sections'],
  VerticalStack: ['gap', 'fill', 'items'],
  HorizontalStack: ['gap', 'fill', 'align', 'itemSizes', 'items'],
  Badge: ['label', 'variant', 'href', 'tone', 'size'],
};

/** The root keys of a parsed view that no rule allows, each with why. */
export function unknownRootKeys(doc: unknown): string[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return ['(the view is not a mapping)'];
  }
  const root = doc as Record<string, unknown>;
  const type = root['$type'];
  if (typeof type !== 'string') {
    return ['$type (missing: the root of a view needs a $type)'];
  }
  const props = ROOT_PROPS[type];
  if (props === undefined) {
    return [`$type: ${type} (no root properties are known for this component: add it to ROOT_PROPS after checking what the renderer reads)`];
  }
  return Object.keys(root).filter((key) => !(ROOT_DIRECTIVES as readonly string[]).includes(key) && !props.includes(key));
}

const files = readdirSync(viewsDir).filter((name) => /\.ya?ml$/.test(name));

describe('root keys of the views', () => {
  it('finds the views (the check itself works)', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files)('%s has no unknown root key', (file) => {
    const unknown = unknownRootKeys(yaml.load(readFileSync(join(viewsDir, file), 'utf-8')));
    expect(unknown, `unknown root key(s) in ${file}: ${unknown.join(' | ')} (a stray line parsed as a key is ignored by the renderer without any error)`).toEqual([]);
  });

  it('rejects the stray line that log-files-page.yaml had (the guard itself works)', () => {
    const doc = yaml.load('$type: PageContent\nsections: []\n_Kept in memory only: it disappears when the module restarts._"\n');
    expect(unknownRootKeys(doc)).toEqual(['_Kept in memory only']);
  });

  it('rejects a root property of another component and a root without $type', () => {
    expect(unknownRootKeys({ $type: 'Badge', label: 'x', sections: [] })).toEqual(['sections']);
    expect(unknownRootKeys({ label: 'x' })).toHaveLength(1);
    expect(unknownRootKeys({ $type: 'Mystery' })[0]).toContain('no root properties are known');
  });
});
