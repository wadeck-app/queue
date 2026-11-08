/**
 * Audit of "a failure inside a 200": every POST route of the module, with the answer of its collaborator that means "the work was not done", must answer
 * a 4xx/5xx with the explanation in `error` (the shell shows `message`, else `error`; a 200 without `message` shows a success). The table lists every POST route,
 * so a route added to index.ts without a row here fails `lists every POST route`.
 * The routes that are a success with a caveat (the daemon could not be told, the file was already gone) stay 200 and carry the caveat in `message`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModuleRouteHandler } from '@wadeck-app/app-core-sdk';

const m = vi.hoisted(() => ({
  pushEvent: vi.fn(),
  pushTestEvent: vi.fn(),
  replayEvent: vi.fn(),
  replayDlqEntry: vi.fn(),
  clearDlqEntry: vi.fn(),
  retryEvent: vi.fn(),
  giveUpPending: vi.fn(),
  giveUpStuck: vi.fn(),
  pruneLogFiles: vi.fn(),
  deleteLogFileEntry: vi.fn(),
  getWaiters: vi.fn(),
  listWaiterHistory: vi.fn(),
}));

vi.mock('./push.js', () => ({ pushEvent: m.pushEvent }));
vi.mock('./events.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./events.js')>()), pushTestEvent: m.pushTestEvent }));
vi.mock('./replay.js', () => ({ replayEvent: m.replayEvent }));
vi.mock('./dlq.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./dlq.js')>()), replayDlqEntry: m.replayDlqEntry, clearDlqEntry: m.clearDlqEntry }));
vi.mock('./retry.js', () => ({ retryEvent: m.retryEvent }));
vi.mock('./pending.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./pending.js')>()), giveUpPending: m.giveUpPending, giveUpStuck: m.giveUpStuck }));
vi.mock('./logFiles.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./logFiles.js')>()), pruneLogFiles: m.pruneLogFiles, deleteLogFileEntry: m.deleteLogFileEntry }));
vi.mock('./waiters.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./waiters.js')>()), getWaiters: m.getWaiters }));
vi.mock('./waiterHistory.js', () => ({ listWaiterHistory: m.listWaiterHistory }));

import backend from './index.js';
import { UnexpectedDaemonAnswerError } from './errors.js';
import { collectRoutes, fakeReply, fakeReq } from './moduleContext.testUtil.js';

async function call(route: string, req: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const reply = fakeReply();
  const { routes, ctx } = collectRoutes();
  backend(ctx);
  await routes.get(route)!(fakeReq(req), reply as unknown as Parameters<ModuleRouteHandler>[1]);
  return { status: reply.code.mock.calls.at(-1)![0], body: reply.send.mock.calls.at(-1)![0] as Record<string, unknown> };
}

beforeEach(() => {
  vi.resetAllMocks();
});

interface Row {
  route: string;
  req: Record<string, unknown>;
  /** What the collaborator does when the work was NOT done: answers a value (async or not), or throws. */
  failure: { answers: unknown } | { throws: Error };
  status: number;
  /** The text the toast must show (in `error`). */
  says: string;
  mock: ReturnType<typeof vi.fn>;
}

const PUSH_REQ = { body: { event: 'onFoo', payload: {} } };

const ROWS: Row[] = [
  // the daemon answered a push with a status nobody knows (an older or newer daemon): not a success
  { route: 'POST /push', req: PUSH_REQ, failure: { answers: { status: 'surprise' } }, status: 502, says: 'surprise', mock: m.pushEvent },
  { route: 'POST /push', req: PUSH_REQ, failure: { answers: {} }, status: 502, says: 'no status', mock: m.pushEvent },
  { route: 'POST /events/:name/push-test', req: { params: { name: 'job.started' } }, failure: { answers: { status: 'surprise' } }, status: 502, says: 'surprise', mock: m.pushTestEvent },
  { route: 'POST /history/:eventId/replay', req: { params: { eventId: 'e1' } }, failure: { answers: { status: 'surprise' } }, status: 502, says: 'surprise', mock: m.replayEvent },
  { route: 'POST /dlq/:id/replay', req: { params: { id: 'd1' } }, failure: { answers: { status: 'surprise' } }, status: 502, says: 'surprise', mock: m.replayDlqEntry },
  { route: 'POST /dlq/:id/replay', req: { params: { id: 'd1' } }, failure: { answers: {} }, status: 502, says: 'no status', mock: m.replayDlqEntry },
  { route: 'POST /dlq/:id/clear', req: { params: { id: 'd1' } }, failure: { answers: {} }, status: 502, says: 'no count', mock: m.clearDlqEntry },
  { route: 'POST /dlq/:id/clear', req: { params: { id: 'd1' } }, failure: { throws: new UnexpectedDaemonAnswerError('the daemon answered dlq-clear without a count') }, status: 502, says: 'without a count', mock: m.clearDlqEntry },
  { route: 'POST /retry/:eventId', req: { params: { eventId: 'w1' } }, failure: { answers: { status: 'surprise' } }, status: 500, says: 'queue logs', mock: m.retryEvent },
  { route: 'POST /pending/give-up-stuck', req: {}, failure: { throws: new UnexpectedDaemonAnswerError('the daemon answered give-up-stuck without a count') }, status: 502, says: 'without a count', mock: m.giveUpStuck },
  { route: 'POST /pending/give-up-stuck', req: {}, failure: { throws: new Error('the DLQ file is locked') }, status: 500, says: 'locked', mock: m.giveUpStuck },
  { route: 'POST /pending/:id/give-up', req: { params: { id: 'f1' } }, failure: { throws: new UnexpectedDaemonAnswerError('the daemon answered give-up with status "surprise"') }, status: 502, says: 'surprise', mock: m.giveUpPending },
  // some files deleted, one not: a partial failure is a failure
  {
    route: 'POST /log-files/:kind/prune',
    req: { params: { kind: 'logs' } },
    failure: { answers: { kind: 'logs', deleted: [{ file: 'a.ndjson', bytes: 1 }], failures: [{ file: 'b.ndjson', error: 'EBUSY', fix: 'close it' }], message: '1 file deleted. 1 file could not be deleted: b.ndjson: EBUSY. close it' } },
    status: 500,
    says: 'could not be deleted',
    mock: m.pruneLogFiles,
  },
  { route: 'POST /log-files/:kind/:day/:variant/delete', req: { params: { kind: 'logs', day: '2020-01-01', variant: 'daemon' } }, failure: { throws: new Error('2020-01-01.ndjson could not be deleted: EBUSY. close it') }, status: 500, says: 'EBUSY', mock: m.deleteLogFileEntry },
];

describe('a route whose work was not done never answers 200', () => {
  it.each(ROWS.map((row) => [`${row.route} ${'answers' in row.failure ? JSON.stringify(row.failure.answers).slice(0, 40) : (row.failure as { throws: Error }).throws.message.slice(0, 40)}`, row] as const))('%s', async (_name, row) => {
    if ('answers' in row.failure) {
      // returned as is: awaited by the async handlers, used directly by the sync ones
      const answer = row.failure.answers;
      row.mock.mockImplementation(() => answer);
    } else {
      const error = row.failure.throws;
      row.mock.mockImplementation(() => {
        throw error;
      });
    }
    const { status, body } = await call(row.route, row.req);
    expect(status).toBe(row.status);
    expect(String(body['error'])).toContain(row.says);
  });

  it('the partial failure of a prune keeps what was deleted in the body (ok false, failedCount)', async () => {
    const row = ROWS.find((candidate) => candidate.route === 'POST /log-files/:kind/prune')!;
    m.pruneLogFiles.mockReturnValue((row.failure as { answers: object }).answers);
    const { status, body } = await call(row.route, row.req);
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, failedCount: 1, deleted: [{ file: 'a.ndjson', bytes: 1 }] });
  });

  it('lists every POST route of the module (validate-payload answers a verdict, see its own tests)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const posts = [...routes.keys()].filter((key) => key.startsWith('POST ')).sort();
    const covered = new Set([...ROWS.map((row) => row.route), 'POST /events/:name/validate-payload']);
    expect(posts.filter((route) => !covered.has(route))).toEqual([]);
  });
});

describe('what stays a 200 because the work was done', () => {
  it('delete of a file that is already gone: 200, deleted false, and the message says so (the file is not there, which is what was asked)', async () => {
    m.deleteLogFileEntry.mockReturnValue({ kind: 'logs', deleted: false, file: '2020-01-01.ndjson', bytes: 0, message: '2020-01-01.ndjson was already gone.' });
    const { status, body } = await call('POST /log-files/:kind/:day/:variant/delete', { params: { kind: 'logs', day: '2020-01-01', variant: 'daemon' } });
    expect(status).toBe(200);
    expect(body).toMatchObject({ deleted: false, message: '2020-01-01.ndjson was already gone.' });
  });

  it('a give-up done on the files because the daemon could not be told: 200 and the message carries the caveat', async () => {
    m.giveUpPending.mockResolvedValue({ status: 'moved', message: 'Moved to the dead-letter queue. The event could not be sent' });
    const { status, body } = await call('POST /pending/:id/give-up', { params: { id: 'f1' } });
    expect(status).toBe(200);
    expect(String(body['message'])).toContain('could not be sent');
  });

  it('a prune that deleted everything: 200', async () => {
    m.pruneLogFiles.mockReturnValue({ kind: 'logs', deleted: [{ file: 'a.ndjson', bytes: 1 }], failures: [], message: 'Deleted 1 log file' });
    expect((await call('POST /log-files/:kind/prune', { params: { kind: 'logs' } })).status).toBe(200);
  });
});

/**
 * The routes that read the waiter files and the waits history: a folder that cannot be read, or a query that is not valid, is a 4xx/5xx with the reason in `error`
 * (the nav figure and the page show nothing rather than a quiet "nobody is waiting"). The list of GET routes is explicit: a new one must be added here or to the allow-list.
 */
describe('a GET route that reads the waiter files never answers 200 for a failure', () => {
  const UNREADABLE = new Error('Cannot read the waits of /cfg/waiters: EACCES. Fix: check that the folder is readable.');
  const GET_ROWS: Array<{ route: string; req: Record<string, unknown>; mock: ReturnType<typeof vi.fn> | undefined; throws?: Error; status: number; says: string }> = [
    { route: 'GET /waiters', req: {}, mock: m.getWaiters, throws: UNREADABLE, status: 500, says: 'Fix: check that the folder' },
    { route: 'GET /waiters/history', req: {}, mock: m.listWaiterHistory, throws: UNREADABLE, status: 500, says: 'Fix: check that the folder' },
    // rejected before anything is read: no collaborator is reached
    { route: 'GET /waiters/history', req: { query: { outcome: 'done' } }, mock: undefined, status: 400, says: 'outcome must be one of' },
    { route: 'GET /waiters/history', req: { query: { limit: '0' } }, mock: undefined, status: 400, says: 'limit must be an integer between 1 and 500' },
    { route: 'GET /waiters/history', req: { query: { page: '1', offset: '1' } }, mock: undefined, status: 400, says: 'page and offset cannot be combined' },
    { route: 'GET /waiters/history', req: { query: { name: ['a', 'b'] } }, mock: undefined, status: 400, says: 'name must be given once' },
  ];

  it.each(GET_ROWS.map((row) => [`${row.route} ${JSON.stringify(row.req).slice(0, 50)}`, row] as const))('%s', async (_name, row) => {
    row.mock?.mockImplementation(() => {
      throw row.throws;
    });
    const { status, body } = await call(row.route, row.req);
    expect(status).toBe(row.status);
    expect(String(body['error'])).toContain(row.says);
  });

  it('lists every GET route that reads the waiter files', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const waiterGets = [...routes.keys()].filter((key) => key.startsWith('GET /waiters')).sort();
    expect(waiterGets.filter((route) => !GET_ROWS.some((row) => row.route === route))).toEqual([]);
  });
});
