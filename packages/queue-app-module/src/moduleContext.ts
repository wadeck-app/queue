// Temporary hand-typed mirror of app-core's src/moduleContext.ts ModuleContext interface
// (confirmed with app-core-owner, 2026-10-11). Delete this file and import from
// @wadeck-app/app-core-sdk once that package ships real types -- do not let this drift
// from app-core's actual interface in the meantime.
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
