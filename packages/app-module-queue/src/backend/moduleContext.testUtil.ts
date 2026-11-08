import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { vi } from 'vitest';

// The fake module context, request and reply of the backend tests (not a test file, never part of the module).
// When app-core-sdk adds a member to ModuleContext, this is the one place to add it.

/** A context whose members are vi.fn() stubs; `registerRoute` collects the handlers by "METHOD /path". */
export function collectRoutes(): { routes: Map<string, ModuleRouteHandler>; ctx: ModuleContext } {
  const routes = new Map<string, ModuleRouteHandler>();
  const ctx: ModuleContext = {
    dataDir: '/unused/data-dir',
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    clearInterval: vi.fn(),
    clearTimeout: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    registerRoute: (method, subPath, handler) => routes.set(`${method} ${subPath}`, handler),
    fileVersion: vi.fn(),
    unchanged: vi.fn(),
    dispose: vi.fn(),
  };
  return { routes, ctx };
}

// The backend narrows req to the shape it reads (params/query/body) with its own cast; a real FastifyRequest has 25+ properties nobody fakes.
export function fakeReq(partial: Record<string, unknown> = {}): Parameters<ModuleRouteHandler>[0] {
  return partial as unknown as Parameters<ModuleRouteHandler>[0];
}

// Same rationale as fakeReq: the backend only calls reply.code(n).send(body).
export function fakeReply() {
  const send = vi.fn((body: unknown) => body);
  const code = vi.fn((_status: number) => ({ send }));
  return { code, send };
}

export function asReply(reply: ReturnType<typeof fakeReply>): Parameters<ModuleRouteHandler>[1] {
  return reply as unknown as Parameters<ModuleRouteHandler>[1];
}
