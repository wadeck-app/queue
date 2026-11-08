import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredRoutes } from './registeredRoutes.testUtil.js';

// Docs parity: the module paragraph of the root CLAUDE.md is what an agent reads to know what the dashboard serves, so it must list exactly the routes the
// backend registers (by method) and the number of pages the manifest declares.
const here = dirname(fileURLToPath(import.meta.url));
const claudeMd = readFileSync(join(here, '../../../../CLAUDE.md'), 'utf-8');
const manifest = JSON.parse(readFileSync(join(here, '../../manifest.json'), 'utf-8')) as { extensionPoints?: Array<{ kind: string }> };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };

/** "GET /status" ... from "dashboard routes (GET: `status`, ...; POST: `push`, ...; the list is ...)". */
function documentedRoutes(): string[] {
  const marker = 'dashboard routes (';
  const start = claudeMd.indexOf(marker);
  if (start === -1) {
    throw new Error(`CLAUDE.md has no "${marker}" list: the parity test cannot find the route list it checks`);
  }
  const end = claudeMd.indexOf('; the list is', start);
  if (end === -1) {
    throw new Error('CLAUDE.md route list must end with "; the list is `registerRoute` in `src/backend/index.ts`)": the parity test cannot find where it stops');
  }
  const groups = claudeMd.slice(start + marker.length, end).split(/;\s*(?=POST:)/);
  return groups.flatMap((group) => {
    const method = /^(GET|POST):/.exec(group)?.[1];
    if (method === undefined) {
      throw new Error(`CLAUDE.md route group does not start with "GET:" or "POST:": ${group.slice(0, 40)}`);
    }
    return [...group.matchAll(/`([^`]+)`/g)].map((match) => `${method} /${match[1]}`);
  });
}

describe('CLAUDE.md describes the module as it is', () => {
  it('lists every registered route and no other, with its method', () => {
    const registered = registeredRoutes();
    const documented = documentedRoutes();
    expect(documented.filter((route) => !registered.includes(route)), 'CLAUDE.md lists a route that is not registered').toEqual([]);
    expect(registered.filter((route) => !documented.includes(route)), 'CLAUDE.md omits a registered route').toEqual([]);
    expect(new Set(documented).size, 'a route is listed twice').toBe(documented.length);
  });

  it('says how many pages the manifest declares', () => {
    const entries = manifest.extensionPoints;
    if (entries === undefined) {
      throw new Error('manifest.json has no "extensionPoints": the page count cannot be read');
    }
    const pages = entries.filter((entry) => entry.kind === 'page').length;
    const words = [...claudeMd.matchAll(/shown by (\w+) pages/g)].map((match) => match[1]!);
    expect(words, 'CLAUDE.md must say "shown by <number> pages" once').toHaveLength(1);
    expect(NUMBER_WORDS[words[0]!], `CLAUDE.md says "${words[0]}" pages (an unknown number word fails too), the manifest declares ${pages}`).toBe(pages);
  });
});
