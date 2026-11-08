import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import backend from './index.js';

const unused = (): never => {
  throw new Error('registeredRoutes: the backend called a ModuleContext member that registering routes must not need');
};

/** The routes the backend registers ("GET /status", "POST /dlq/:id/replay"), collected by activating it against a fake module context: behavior, not the text of index.ts. */
export function registeredRoutes(): string[] {
  const routes: string[] = [];
  const ctx: ModuleContext = {
    dataDir: '/unused/data-dir',
    setInterval: unused,
    setTimeout: unused,
    clearInterval: unused,
    clearTimeout: unused,
    on: unused,
    off: unused,
    emit: unused,
    registerRoute: (method, subPath) => { routes.push(`${method} ${subPath}`); },
    dispose: unused,
  };
  backend(ctx);
  return routes;
}
