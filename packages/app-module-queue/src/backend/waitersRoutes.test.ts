import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ getWaiters: vi.fn(), listWaiterHistory: vi.fn() }));

vi.mock('./waiters.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./waiters.js')>()), getWaiters: m.getWaiters }));
vi.mock('./waiterHistory.js', () => ({ listWaiterHistory: m.listWaiterHistory }));

import backend from './index.js';
import { InvalidQueryError } from './errors.js';
import { asReply, collectRoutes, fakeReply, fakeReq } from './moduleContext.testUtil.js';

beforeEach(() => {
  vi.resetAllMocks();
});

async function call(route: string, req: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { routes, ctx } = collectRoutes();
  backend(ctx);
  const reply = fakeReply();
  await routes.get(route)!(fakeReq(req), asReply(reply));
  return { status: reply.code.mock.calls.at(-1)![0], body: reply.send.mock.calls.at(-1)![0] as Record<string, unknown> };
}

describe('GET /waiters', () => {
  it('answers the live waits as they are read (200), from the queue config folder', async () => {
    m.getWaiters.mockReturnValue({ waiters: [], count: 0, staleCount: 0, anonymousCount: 0 });
    const { status, body } = await call('GET /waiters');
    expect(status).toBe(200);
    expect(body).toEqual({ waiters: [], count: 0, staleCount: 0, anonymousCount: 0 });
    expect(m.getWaiters).toHaveBeenCalledWith(expect.any(String));
  });

  it('a folder that cannot be read is a 500 with the reason and the fix, never an empty 200', async () => {
    m.getWaiters.mockImplementation(() => {
      throw new Error('Cannot read the waits of /c/waiters: EACCES. Fix: check the folder.');
    });
    const { status, body } = await call('GET /waiters');
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Cannot read the waits of /c/waiters: EACCES. Fix: check the folder.' });
  });
});

describe('GET /waiters/history', () => {
  it('validates the query and hands the parsed filter and paging to the reader', async () => {
    m.listWaiterHistory.mockReturnValue({ entries: [], total: 0, limit: 20, offset: 0 });
    const { status } = await call('GET /waiters/history', { query: { name: 'agent.*', outcome: 'lost', limit: '5', page: '1' } });
    expect(status).toBe(200);
    expect(m.listWaiterHistory).toHaveBeenCalledWith(expect.any(String), { filter: { name: 'agent.*', outcome: 'lost' }, pagination: { limit: 5, page: 1 } });
  });

  it('works without any query', async () => {
    m.listWaiterHistory.mockReturnValue({ entries: [], total: 0, limit: 20, offset: 0 });
    expect((await call('GET /waiters/history')).status).toBe(200);
    expect(m.listWaiterHistory).toHaveBeenCalledWith(expect.any(String), { filter: {}, pagination: {} });
  });

  it('an invalid parameter is a 400 that names it, and nothing is read', async () => {
    const { status, body } = await call('GET /waiters/history', { query: { outcome: 'done' } });
    expect(status).toBe(400);
    expect(String(body['error'])).toContain('outcome must be one of');
    expect(m.listWaiterHistory).not.toHaveBeenCalled();
  });

  it('a reader that fails is a 500 with its reason', async () => {
    m.listWaiterHistory.mockImplementation(() => {
      throw new Error('Cannot read the waits of /c/waiters: EACCES. Fix: check the folder.');
    });
    const { status, body } = await call('GET /waiters/history');
    expect(status).toBe(500);
    expect(String(body['error'])).toContain('EACCES');
  });

  it('an InvalidQueryError raised by the reader is a 400', async () => {
    m.listWaiterHistory.mockImplementation(() => {
      throw new InvalidQueryError('name is not valid');
    });
    expect((await call('GET /waiters/history')).status).toBe(400);
  });
});
