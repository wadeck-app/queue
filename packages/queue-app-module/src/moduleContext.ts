// Temporary hand-typed mirror of app-core's ModuleContext interface.
// @wadeck-app/app-core-sdk is published (2026.10.11) but its dist/index.d.ts still
// `export`s types `from '@wadeck-app/app-core-server/manifest'` etc -- a private,
// unpublished package not resolvable outside app-core's own monorepo (confirmed:
// not present in node_modules, tsc fails with TS7006 implicit-any on every handler
// param once imported). Reported to app-core-owner 2026-10-11; keep this mirror
// until the SDK's .d.ts is fixed to not reference app-core-server.
// Real signature is (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>
// (app-core's src/moduleRoutes.ts) -- loosely typed here since this file has no fastify dep;
// @wadeck-app/app-core-sdk will bring the real Fastify types.
export type ModuleReply = { code: (status: number) => { send: (body: unknown) => unknown } };
export type ModuleRouteHandler = (req: unknown, reply: ModuleReply) => unknown | Promise<unknown>;

export interface ModuleContext {
  setInterval(fn: () => void, ms: number): void;
  setTimeout(fn: () => void, ms: number): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  registerRoute(method: string, subPath: string, handler: ModuleRouteHandler): void;
  dispose(): void;
}
