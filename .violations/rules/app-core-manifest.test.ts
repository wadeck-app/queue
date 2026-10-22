import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// The rule is the SDK's own; this checks that it is wired the way the runner loads it (a `rule` export of the right shape).
import { rule } from './app-core-manifest.js';

const dirs: string[] = [];

function manifest(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'violations-manifest-'));
  dirs.push(dir);
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('app-core-sdk/manifest-valid', () => {
  it('has the shape the runner expects of a rule', () => {
    expect(rule.id).toBe('app-core-sdk/manifest-valid');
    expect(rule.defaultScope).toContain('**/manifest.json');
    expect(rule.defaultSeverity).toBe('error');
  });

  it('accepts a source manifest', async () => {
    const file = manifest(JSON.stringify({ id: 'ok', extensionPoints: [{ kind: 'widget', slot: 'dashboard', view: { type: 'inline', value: { $type: 'Badge', label: 'x' } } }] }));
    expect(await rule.check([file])).toEqual([]);
  });

  it('reports every problem with its path, the cross-field rules of app-core included', async () => {
    const file = manifest(JSON.stringify({ id: 'ok', extensionPoints: [{ kind: 'page', slot: 'flow:nav', width: 2, view: { type: 'inline', value: {} } }] }));
    const messages = (await rule.check([file])).map((v) => v.message);
    expect(messages.some((m) => m.startsWith('extensionPoints.0.label:'))).toBe(true);
    expect(messages.some((m) => m.startsWith('extensionPoints.0.width:'))).toBe(true);
  });

  it('says a manifest.json is not valid JSON, and leaves a manifest.json that is not app-core\'s alone', async () => {
    expect((await rule.check([manifest('{ nope')]))[0]?.message).toContain('is not valid JSON');
    expect(await rule.check([manifest(JSON.stringify({ name: 'a browser extension', manifest_version: 3 }))])).toEqual([]);
  });
});
