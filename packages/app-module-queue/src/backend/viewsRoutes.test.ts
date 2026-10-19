import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = dirname(fileURLToPath(import.meta.url));
const viewsDir = join(backendDir, '../dsl-views');

// "GET /status", "POST /dlq/:id/replay" ... as registered by index.ts
const registered = new Set(
  [...readFileSync(join(backendDir, 'index.ts'), 'utf8').matchAll(/registerRoute\('(GET|POST)', '([^']+)'/g)].map((match) => `${match[1]} ${match[2]}`),
);

// "GET /api/modules/queue/dlq/{id}/replay?x=1" in a view -> "GET /dlq/:id/replay"
function routeOf(method: string, path: string): string {
  return `${method} ${path.split('?')[0]!.replace(/\{[^}]+\}/g, ':param').replace(/:[A-Za-z]+/g, ':param')}`;
}

const normalisedRegistered = new Set([...registered].map((route) => routeOf(route.split(' ')[0]!, route.split(' ')[1]!)));

describe('dsl-views call the routes the backend registers', () => {
  const calls = readdirSync(viewsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => [...readFileSync(join(viewsDir, file), 'utf8').matchAll(/\b(GET|POST)\s+\/api\/modules\/queue(\/[^\s"']*)/g)].map((match) => ({ file, call: routeOf(match[1]!, match[2]!) })));

  it('finds the calls of the views (the check itself works)', () => {
    expect(calls.length).toBeGreaterThan(10);
    expect(normalisedRegistered.size).toBeGreaterThan(10);
  });

  it.each(calls.map(({ file, call }) => [file, call] as const))('%s: %s is a registered route', (_file, call) => {
    expect(normalisedRegistered).toContain(call);
  });
});
