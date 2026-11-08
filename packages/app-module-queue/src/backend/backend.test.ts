import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { DaemonUnreachableError, ReplayNotFoundError, ReplayError, InvalidQueryError, RelayNotConfiguredError, TestPayloadNotFoundError, SchemaUnusableError, InvalidPayloadError, ReservedEventError, PendingNotFoundError, NotInFlightError, UnknownProjectError, LogFileNotFoundError, LogFileInUseError } from './errors.js';
import { RelayApiError } from '@wadeck-app/queue-relay-client/dist/relayApi.js';

const {
  mockGetStatus,
  mockGetActivity,
  mockGetActivitySeries,
  mockGetOutcomes,
  mockGetBreakdown,
  mockGetOverviewRange,
  mockListPending,
  mockListHistory,
  mockGetHistoryEntry,
  mockReplayEvent,
  mockListDlq,
  mockReplayDlqEntry,
  mockClearDlqEntry,
  mockGiveUpPending,
  mockGiveUpStuck,
  mockListSubscribers,
  mockListProjectOptions,
  mockGetRelatedForProject,
  mockGetProjectScope,
  mockPushEvent,
  mockGetLogs,
  mockGetLogFiles,
  mockPruneLogFiles,
  mockDeleteLogFileEntry,
  mockGetEvents,
  mockGetEventPage,
  mockPushTestEvent,
  mockValidateEventPayload,
  mockRetryEvent,
  mockGetDaemonState,
  mockGetRelayInfo,
  mockListWebhooks,
  mockListDeliveries,
  mockResolveProjectCwd,
} = vi.hoisted(() => ({
  mockGetStatus: vi.fn(),
  mockGetActivity: vi.fn(),
  mockGetActivitySeries: vi.fn(),
  mockGetOutcomes: vi.fn(),
  mockGetBreakdown: vi.fn(),
  mockGetOverviewRange: vi.fn(),
  mockListPending: vi.fn(),
  mockListHistory: vi.fn(),
  mockGetHistoryEntry: vi.fn(),
  mockReplayEvent: vi.fn(),
  mockListDlq: vi.fn(),
  mockReplayDlqEntry: vi.fn(),
  mockClearDlqEntry: vi.fn(),
  mockGiveUpPending: vi.fn(),
  mockGiveUpStuck: vi.fn(),
  mockListSubscribers: vi.fn(),
  mockListProjectOptions: vi.fn(),
  mockGetRelatedForProject: vi.fn(),
  mockGetProjectScope: vi.fn(),
  mockPushEvent: vi.fn(),
  mockGetLogs: vi.fn(),
  mockGetLogFiles: vi.fn(),
  mockPruneLogFiles: vi.fn(),
  mockDeleteLogFileEntry: vi.fn(),
  mockGetEvents: vi.fn(),
  mockGetEventPage: vi.fn(),
  mockPushTestEvent: vi.fn(),
  mockValidateEventPayload: vi.fn(),
  mockRetryEvent: vi.fn(),
  mockGetDaemonState: vi.fn(),
  mockGetRelayInfo: vi.fn(),
  mockListWebhooks: vi.fn(),
  mockListDeliveries: vi.fn(),
  mockResolveProjectCwd: vi.fn(),
}));

vi.mock('./status.js', () => ({ getStatus: mockGetStatus }));
vi.mock('./activity.js', () => ({ getActivity: mockGetActivity, getActivitySeries: mockGetActivitySeries }));
vi.mock('./outcomes.js', () => ({ getOutcomes: mockGetOutcomes }));
vi.mock('./breakdown.js', () => ({ getBreakdown: mockGetBreakdown }));
vi.mock('./overviewRange.js', () => ({ getOverviewRange: mockGetOverviewRange }));
vi.mock('./pending.js', () => ({ listPending: mockListPending, giveUpPending: mockGiveUpPending, giveUpStuck: mockGiveUpStuck }));
vi.mock('./history.js', () => ({ listHistory: mockListHistory, getHistoryEntry: mockGetHistoryEntry }));
vi.mock('./replay.js', () => ({ replayEvent: mockReplayEvent }));
vi.mock('./dlq.js', () => ({ listDlq: mockListDlq, replayDlqEntry: mockReplayDlqEntry, clearDlqEntry: mockClearDlqEntry }));
vi.mock('./subscribers.js', () => ({ listSubscribers: mockListSubscribers }));
// assertProjectId stays the real one: it is the shared 400 wording of /dlq and /related/project/:projectId
vi.mock('./projects.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./projects.js')>()), listProjectOptions: mockListProjectOptions }));
vi.mock('./related.js', () => ({ getRelatedForProject: mockGetRelatedForProject }));
vi.mock('./projectScope.js', () => ({ getProjectScope: mockGetProjectScope }));
vi.mock('./push.js', () => ({ pushEvent: mockPushEvent }));
vi.mock('./projectCwd.js', () => ({ resolveProjectCwd: mockResolveProjectCwd }));
vi.mock('./logs.js', () => ({ getLogs: mockGetLogs }));
vi.mock('./logFiles.js', () => ({ getLogFiles: mockGetLogFiles, pruneLogFiles: mockPruneLogFiles, deleteLogFileEntry: mockDeleteLogFileEntry }));
vi.mock('./events.js', () => ({ getEvents: mockGetEvents, getEventPage: mockGetEventPage, pushTestEvent: mockPushTestEvent, validateEventPayload: mockValidateEventPayload }));
vi.mock('./retry.js', () => ({ retryEvent: mockRetryEvent }));
vi.mock('./daemon.js', () => ({ getDaemonState: mockGetDaemonState }));
vi.mock('./relay.js', () => ({ getRelayInfo: mockGetRelayInfo }));
vi.mock('./relayWebhooks.js', () => ({ listWebhooks: mockListWebhooks, listDeliveries: mockListDeliveries }));

import backend from './index.js';
import { asReply, collectRoutes, fakeReply, fakeReq } from './moduleContext.testUtil.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backend', () => {
  it('registers one route per app-module-queue operation', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    expect([...routes.keys()]).toEqual([
      'GET /status',
      'GET /activity',
      'GET /activity/series',
      'GET /outcomes',
      'GET /breakdown',
      'GET /overview',
      'GET /history',
      'GET /history/:eventId',
      'POST /history/:eventId/replay',
      'GET /logs',
      'GET /log-files',
      'POST /log-files/:kind/prune',
      'POST /log-files/:kind/:day/:variant/delete',
      'GET /events',
      'GET /events/detail',
      'POST /events/:name/validate-payload',
      'POST /events/:name/push-test',
      'POST /retry/:eventId',
      'POST /pending/give-up-stuck',
      'POST /pending/:id/give-up',
      'GET /daemon',
      'GET /relay',
      'GET /relay/webhooks',
      'GET /relay/deliveries',
      'GET /pending',
      'GET /dlq',
      'POST /dlq/:id/replay',
      'POST /dlq/:id/clear',
      'GET /projects',
      'GET /project-scope',
      'GET /related/project/:projectId',
      'GET /subscribers',
      'POST /push',
    ]);
  });

  it('GET /status forwards getStatus()', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetStatus.mockReturnValue({ pendingCount: 1, dlqCount: 0 });
    const reply = fakeReply();
    await routes.get('GET /status')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ pendingCount: 1, dlqCount: 0 });
  });

  it('GET /activity forwards the event counts of the last 5 min, 60 min and 24 h', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetActivity.mockReturnValue({ last5Min: 2, last60Min: 9, last24Hours: 140 });
    const reply = fakeReply();
    routes.get('GET /activity')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ last5Min: 2, last60Min: 9, last24Hours: 140 });
  });

  it('GET /activity returns 500 with the reason when the history cannot be read', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetActivity.mockImplementation(() => { throw new Error('Cannot read history'); });
    const reply = fakeReply();
    routes.get('GET /activity')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Cannot read history' });
  });

  it('GET /history forwards limit/offset query params and sends the full page', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 10 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '5', offset: '10' } }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: undefined, subscriberId: undefined }),
      { limit: 5, offset: 10 },
    );
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 10 });
  });

  it('GET /history sends the warnings of skipped malformed lines to the client unchanged (the page, not a bare list, so nothing is hidden)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const page = { entries: [], total: 0, limit: 20, offset: 0, warnings: ['h/2026-01-01.ndjson: 1 malformed line(s) skipped'], warningText: 'h/2026-01-01.ndjson: 1 malformed line(s) skipped' };
    mockListHistory.mockReturnValue(page);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: {} }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(page);
  });

  it('GET /history omits limit/offset when not provided, letting listHistory default them', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 0, limit: 20, offset: 0 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: {} }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(expect.any(String), expect.anything(), { limit: undefined, offset: undefined });
  });

  it('GET /history returns 400 when limit is invalid (non-numeric)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: 'abc' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be an integer between 1 and 500, got: "abc"',
    });
  });

  it('GET /history returns 400 when limit is 0', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '0' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be an integer between 1 and 500, got: "0"',
    });
  });

  it('GET /history returns 400 when limit exceeds MAX_HISTORY_LIMIT (501)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '501' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be an integer between 1 and 500, got: "501"',
    });
  });

  it('GET /history returns 400 when offset is negative', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { offset: '-3' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'offset must be an integer >= 0, got: "-3"',
    });
  });

  it('GET /history returns 400 when sinceMs is invalid (non-numeric)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { sinceMs: 'abc' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'sinceMs must be an integer >= 0, got: "abc"',
    });
  });

  it('GET /history returns 400 when sinceMs is decimal', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { sinceMs: '1000.5' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'sinceMs must be an integer >= 0, got: "1000.5"',
    });
  });

  it('GET /history returns 400 when limit is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: ['5', '10'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'limit must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when offset is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { offset: ['0', '10'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'offset must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when sinceMs is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { sinceMs: ['1000', '2000'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'sinceMs must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when status is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { status: ['success', 'failed'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'status must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when status is invalid', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { status: 'bogus' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'status must be one of success, failed, dlq, filtered, got: "bogus"',
    });
  });

  it('GET /history returns 200 with valid page when query params are valid', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 10 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { limit: '5', offset: '10', status: 'success' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 10 });
  });

  it('GET /history accepts page=0 with limit, passes page to listHistory', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 0 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '0', limit: '5' } }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { limit: 5, offset: undefined, page: 0 },
    );
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 0 });
  });

  it('GET /history accepts page=1 with limit, passes page to listHistory', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockReturnValue({ entries: [], total: 42, limit: 5, offset: 5 });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '1', limit: '5' } }), asReply(reply));
    expect(mockListHistory).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { limit: 5, offset: undefined, page: 1 },
    );
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [], total: 42, limit: 5, offset: 5 });
  });

  it('GET /history returns 400 when page is invalid (non-numeric)', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: 'abc' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be an integer >= 0, got: "abc"',
    });
  });

  it('GET /history returns 400 when page is negative', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '-1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be an integer >= 0, got: "-1"',
    });
  });

  it('GET /history returns 400 when page is duplicated', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: ['0', '1'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be given once, got 2 values',
    });
  });

  it('GET /history returns 400 when both page and offset are given', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '1', offset: '5' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page and offset cannot be combined: use page (with limit) or offset, not both',
    });
  });

  it('GET /history returns 400 when page * limit overflows safe integer', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    const maxSafeInt = '9007199254740991';
    routes.get('GET /history')!(fakeReq({ query: { page: maxSafeInt, limit: '100' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: `page * limit must be a safe integer, got page="${maxSafeInt}" limit="100"`,
    });
  });

  it('GET /history returns 400 when page is empty string', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: { page: '' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'page must be an integer >= 0, got: ""',
    });
  });

  it('POST /history/:eventId/replay returns 404 when eventId is not found', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new ReplayNotFoundError('No history entry found for eventId x'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ error: 'No history entry found for eventId x' });
  });

  it('POST /history/:eventId/replay returns 422 when entry has no recorded payload', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new ReplayError('No payload recorded for eventId x'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(422);
    expect(reply.send).toHaveBeenCalledWith({ error: 'No payload recorded for eventId x' });
  });

  it('POST /history/:eventId/replay returns 503 when daemon is unreachable', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new DaemonUnreachableError('Daemon is not running'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Daemon is not running' });
  });

  it('POST /history/:eventId/replay returns 500 for other errors', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayEvent.mockRejectedValue(new Error('Unexpected error'));
    const reply = fakeReply();
    await routes.get('POST /history/:eventId/replay')!(fakeReq({ params: { eventId: 'x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected error' });
  });

  it('GET /dlq answers the entries', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const entry = { id: 'd 1', event: 'onFoo', subscriberId: 'onFoo[0]', payload: {}, meta: {}, attempts: 5, lastError: 'x', movedAt: '2026-10-19T10:00:00.000Z' };
    mockListDlq.mockReturnValue([entry]);
    const reply = fakeReply();
    await routes.get('GET /dlq')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ entries: [entry] });
  });

  it('GET /dlq filters on a well formed ?project= and answers 400 with the shared wording for a malformed or repeated one', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListDlq.mockReturnValue([]);
    const ok = fakeReply();
    await routes.get('GET /dlq')!(fakeReq({ query: { project: '64f4ae91' } }), asReply(ok));
    expect(mockListDlq).toHaveBeenCalledWith(expect.any(String), '64f4ae91');
    expect(ok.code).toHaveBeenCalledWith(200);
    for (const bad of ['nope', ['64f4ae91', '64f4ae91']]) {
      const reply = fakeReply();
      await routes.get('GET /dlq')!(fakeReq({ query: { project: bad } }), asReply(reply));
      expect(reply.code).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith({ error: expect.stringContaining('project must be the id of a registered project (8 hexadecimal characters, project list shows them)') });
    }
  });

  it('GET /dlq returns 500 with the reason when reading the DLQ fails (the daemon is not involved)', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListDlq.mockImplementation(() => { throw new Error('Cannot read dlq.ndjson'); });
    const reply = fakeReply();
    await routes.get('GET /dlq')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Cannot read dlq.ndjson' });
  });

  it('GET /projects answers the registered projects as select options', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListProjectOptions.mockReturnValue([{ value: '64f4ae91', label: 'app' }]);
    const reply = fakeReply();
    await routes.get('GET /projects')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ options: [{ value: '64f4ae91', label: 'app' }] });
  });

  it('GET /projects returns 500 with the reason when the registry cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListProjectOptions.mockImplementation(() => { throw new Error('registry is not valid JSON'); });
    const reply = fakeReply();
    await routes.get('GET /projects')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'registry is not valid JSON' });
  });

  it('GET /project-scope answers the scope of the ?project= query', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetProjectScope.mockReturnValue({ id: '64f4ae91', name: 'app', found: true });
    const reply = fakeReply();
    await routes.get('GET /project-scope')!(fakeReq({ query: { project: '64f4ae91' } }), asReply(reply));
    expect(mockGetProjectScope).toHaveBeenCalledWith(expect.any(String), '64f4ae91');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ id: '64f4ae91', name: 'app', found: true });
  });

  it('GET /project-scope hands an absent query to the scope (found: false, never a 400)', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetProjectScope.mockReturnValue({ id: '', name: '', found: false });
    const reply = fakeReply();
    await routes.get('GET /project-scope')!(fakeReq(), asReply(reply));
    expect(mockGetProjectScope).toHaveBeenCalledWith(expect.any(String), undefined);
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('GET /project-scope returns 500 with the reason when the registry cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetProjectScope.mockImplementation(() => { throw new Error('registry is not valid JSON'); });
    const reply = fakeReply();
    await routes.get('GET /project-scope')!(fakeReq({ query: { project: '64f4ae91' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'registry is not valid JSON' });
  });

  it('GET /related/project/:projectId answers the related card of the project in the route param', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const card = { title: 'Queue', count: 2, items: [], moreUrl: '/modules/queue/history?project=64f4ae91' };
    mockGetRelatedForProject.mockReturnValue(card);
    const reply = fakeReply();
    await routes.get('GET /related/project/:projectId')!(fakeReq({ params: { projectId: '64f4ae91' } }), asReply(reply));
    expect(mockGetRelatedForProject).toHaveBeenCalledWith(expect.any(String), expect.any(String), '64f4ae91');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(card);
  });

  it('GET /related/project/:projectId maps a malformed id to 400, an unknown id to 404 and anything else to 500, always with { error }', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const cases: Array<[Error, number]> = [
      [new InvalidQueryError('project must be the id of a registered project'), 400],
      [new UnknownProjectError('No project with id deadbeef in the registry'), 404],
      [new Error('registry is not valid JSON'), 500],
    ];
    for (const [error, status] of cases) {
      mockGetRelatedForProject.mockImplementation(() => { throw error; });
      const reply = fakeReply();
      await routes.get('GET /related/project/:projectId')!(fakeReq({ params: { projectId: 'deadbeef' } }), asReply(reply));
      expect(reply.code).toHaveBeenCalledWith(status);
      expect(reply.send).toHaveBeenCalledWith({ error: error.message });
    }
  });

  it('GET /subscribers returns 500 with the reason for an invalid subscribers.yml', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListSubscribers.mockImplementation(() => { throw new Error('Invalid subscribers.yml: bad indentation'); });
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { cwd: '/p' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Invalid subscribers.yml: bad indentation' });
  });

  it('GET /subscribers answers 400 with the fix when the cwd is not inside a registered project, and passes no cwd (not process.cwd()) when none is asked', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListSubscribers.mockImplementation(() => { throw new InvalidQueryError('cwd "/x" is not inside a registered project. Fix: pass a folder of a registered project'); });
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { cwd: '/x' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'cwd "/x" is not inside a registered project. Fix: pass a folder of a registered project' });

    mockListSubscribers.mockReset();
    mockListSubscribers.mockReturnValue([]);
    await routes.get('GET /subscribers')!(fakeReq({ query: {} }), asReply(fakeReply()));
    expect(mockListSubscribers).toHaveBeenCalledWith(expect.any(String), undefined, undefined, expect.any(String));
  });

  it('POST /dlq/:id/clear returns 500 with the reason when the DLQ cannot be edited', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockClearDlqEntry.mockImplementation(() => { throw new Error('Lock held by another process'); });
    const reply = fakeReply();
    await routes.get('POST /dlq/:id/clear')!(fakeReq({ params: { id: 'd1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Lock held by another process' });
  });

  it('POST /dlq/:id/replay answers 500, not 503, for an error that is not about the daemon', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayDlqEntry.mockRejectedValue(new Error('Unexpected failure'));
    const reply = fakeReply();
    await routes.get('POST /dlq/:id/replay')!(fakeReq({ params: { id: 'd1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected failure' });
  });

  it('POST /dlq/:id/replay still answers 503 when the daemon is unreachable', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockReplayDlqEntry.mockRejectedValue(new DaemonUnreachableError('Daemon is not running'));
    const reply = fakeReply();
    await routes.get('POST /dlq/:id/replay')!(fakeReq({ params: { id: 'd1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
  });

  it('GET /activity/series answers the series, and 500 with the reason when the history cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetActivitySeries.mockReturnValueOnce({ lastHour: [{ label: '12:00', events: 1 }], lastDay: [] });
    const ok = fakeReply();
    await routes.get('GET /activity/series')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith({ lastHour: [{ label: '12:00', events: 1 }], lastDay: [] });

    mockGetActivitySeries.mockImplementationOnce(() => { throw new Error('EACCES: history'); });
    const broken = fakeReply();
    await routes.get('GET /activity/series')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: history' });
  });

  it('GET /outcomes answers how the dispatches ended, and 500 with the reason when the history cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const outcomes = { last24Hours: { delivered: 3, failedAttempts: 1, givenUp: 0 }, series: [] };
    mockGetOutcomes.mockReturnValueOnce(outcomes);
    const ok = fakeReply();
    await routes.get('GET /outcomes')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith(outcomes);

    mockGetOutcomes.mockImplementationOnce(() => { throw new Error('EACCES: history'); });
    const broken = fakeReply();
    await routes.get('GET /outcomes')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: history' });
  });

  it('GET /overview answers the totals and charts of the period given by ?range=, and the default period without one', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const overview = { range: '6h', title: 'Last 6 hours', totals: { events: 3 } };
    mockGetOverviewRange.mockReturnValueOnce(overview);
    const ok = fakeReply();
    await routes.get('GET /overview')!(fakeReq({ query: { range: '6h' } }), asReply(ok));
    expect(mockGetOverviewRange).toHaveBeenCalledWith(expect.any(String), '6h');
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith(overview);

    mockGetOverviewRange.mockReturnValueOnce(overview);
    await routes.get('GET /overview')!(fakeReq(), asReply(fakeReply()));
    expect(mockGetOverviewRange).toHaveBeenLastCalledWith(expect.any(String), undefined);
  });

  it('GET /overview answers 400 with the accepted periods for a period it does not know, 500 for a history it cannot read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetOverviewRange.mockImplementationOnce(() => { throw new InvalidQueryError('range must be one of 1h, 6h, 24h, 3d, 7d, got: "2w"'); });
    const bad = fakeReply();
    await routes.get('GET /overview')!(fakeReq({ query: { range: '2w' } }), asReply(bad));
    expect(bad.code).toHaveBeenCalledWith(400);
    expect(bad.send).toHaveBeenCalledWith({ error: 'range must be one of 1h, 6h, 24h, 3d, 7d, got: "2w"' });

    mockGetOverviewRange.mockImplementationOnce(() => { throw new Error('EACCES: history'); });
    const broken = fakeReply();
    await routes.get('GET /overview')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: history' });
  });

  it('POST /pending/give-up-stuck moves every stuck event to the DLQ and answers how many, 500 with the reason when it cannot', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGiveUpStuck.mockReturnValueOnce({ moved: 56 });
    const ok = fakeReply();
    await routes.get('POST /pending/give-up-stuck')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith({ moved: 56 });

    mockGiveUpStuck.mockImplementationOnce(() => { throw new Error('Lock held by another process'); });
    const broken = fakeReply();
    await routes.get('POST /pending/give-up-stuck')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'Lock held by another process' });
  });

  it('POST /pending/:id/give-up moves the entry to the DLQ: 200, 404 for an unknown id, 409 for an entry no longer in flight, 500 otherwise', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGiveUpPending.mockReturnValueOnce({ status: 'moved' });
    const ok = fakeReply();
    await routes.get('POST /pending/:id/give-up')!(fakeReq({ params: { id: 'f1' } }), asReply(ok));
    expect(mockGiveUpPending).toHaveBeenCalledWith(expect.any(String), 'f1');
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith({ status: 'moved' });

    mockGiveUpPending.mockImplementationOnce(() => { throw new PendingNotFoundError('No pending event with id x'); });
    const missing = fakeReply();
    await routes.get('POST /pending/:id/give-up')!(fakeReq({ params: { id: 'x' } }), asReply(missing));
    expect(missing.code).toHaveBeenCalledWith(404);
    expect(missing.send).toHaveBeenCalledWith({ error: 'No pending event with id x' });

    mockGiveUpPending.mockImplementationOnce(() => { throw new NotInFlightError('already delivered'); });
    const done = fakeReply();
    await routes.get('POST /pending/:id/give-up')!(fakeReq({ params: { id: 'a1' } }), asReply(done));
    expect(done.code).toHaveBeenCalledWith(409);

    mockGiveUpPending.mockImplementationOnce(() => { throw new Error('Lock held by another process'); });
    const broken = fakeReply();
    await routes.get('POST /pending/:id/give-up')!(fakeReq({ params: { id: 'f1' } }), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
  });

  it('GET /breakdown answers the top events and subscribers, and 500 with the reason when the history cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const breakdown = { topEvents: [{ event: 'onFoo', count: 2 }], otherEvents: 0, subscribers: [] };
    mockGetBreakdown.mockReturnValueOnce(breakdown);
    const ok = fakeReply();
    await routes.get('GET /breakdown')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith(breakdown);

    mockGetBreakdown.mockImplementationOnce(() => { throw new Error('EACCES: history'); });
    const broken = fakeReply();
    await routes.get('GET /breakdown')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: history' });
  });

  it('GET /pending answers the in-flight events with the retry choices, and 500 with the reason when the WAL cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListPending.mockReturnValueOnce({ entries: [], awaitingRetry: 0 });
    const ok = fakeReply();
    await routes.get('GET /pending')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith({ entries: [], awaitingRetry: 0 });

    mockListPending.mockImplementationOnce(() => { throw new Error('EACCES: wal.ndjson'); });
    const broken = fakeReply();
    await routes.get('GET /pending')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: wal.ndjson' });
  });

  it('GET /logs forwards the query to getLogs', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetLogs.mockReturnValue({ date: '2026-10-18', present: true, omitted: 0, lines: [{ text: 'x' }] });
    const reply = fakeReply();
    await routes.get('GET /logs')!(fakeReq({ query: { limit: '5', date: '2026-10-18' } }), asReply(reply));
    expect(mockGetLogs).toHaveBeenCalledWith(expect.any(String), { limit: '5', date: '2026-10-18' });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ date: '2026-10-18', present: true, omitted: 0, lines: [{ text: 'x' }] });
  });

  it('GET /logs answers 400 for a bad query and 500 for any other failure', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetLogs.mockImplementationOnce(() => { throw new InvalidQueryError('date must be a day as YYYY-MM-DD, got: "x"'); });
    const bad = fakeReply();
    await routes.get('GET /logs')!(fakeReq({ query: { date: 'x' } }), asReply(bad));
    expect(bad.code).toHaveBeenCalledWith(400);
    expect(bad.send).toHaveBeenCalledWith({ error: 'date must be a day as YYYY-MM-DD, got: "x"' });

    mockGetLogs.mockImplementationOnce(() => { throw new Error('EACCES: permission denied'); });
    const broken = fakeReply();
    await routes.get('GET /logs')!(fakeReq({ query: {} }), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
  });

  it('GET /log-files answers getLogFiles() and 500 with the message when a directory is unreadable', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetLogFiles.mockReturnValue({ today: '2026-10-19', sections: [], queueFiles: [] });
    const reply = fakeReply();
    await routes.get('GET /log-files')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ today: '2026-10-19', sections: [], queueFiles: [] });

    mockGetLogFiles.mockImplementationOnce(() => { throw new Error('Cannot read the logs directory x. Check that it is a readable directory'); });
    const broken = fakeReply();
    await routes.get('GET /log-files')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'Cannot read the logs directory x. Check that it is a readable directory' });
  });

  it('POST /log-files/:kind/prune forwards the kind from the URL, no body needed', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPruneLogFiles.mockReturnValue({ kind: 'history', deleted: [], failures: [], message: 'Nothing to prune' });
    const reply = fakeReply();
    await routes.get('POST /log-files/:kind/prune')!(fakeReq({ params: { kind: 'history' } }), asReply(reply));
    expect(mockPruneLogFiles).toHaveBeenCalledWith(expect.any(String), 'history');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ kind: 'history', deleted: [], failures: [], message: 'Nothing to prune' });
  });

  it('POST /log-files/:kind/prune answers 500 with the failures (ok false, failedCount, error) when some files could not be deleted, so the page shows a failure and not a silent success', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const result = {
      kind: 'logs',
      deleted: ['2026-01-01.ndjson'],
      failures: [{ file: '2026-01-02.ndjson', error: 'EBUSY', fix: 'close the program that holds it' }],
      message: '1 file deleted. 1 file could not be deleted: 2026-01-02.ndjson: EBUSY. close the program that holds it',
    };
    mockPruneLogFiles.mockReturnValue(result);
    const reply = fakeReply();
    await routes.get('POST /log-files/:kind/prune')!(fakeReq({ params: { kind: 'logs' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ ...result, ok: false, failedCount: 1, error: result.message });
  });

  it('POST /log-files/:kind/prune answers 400 for a bad kind and 500 for any other failure', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPruneLogFiles.mockImplementationOnce(() => { throw new InvalidQueryError('kind must be one of logs, history, got: "wal"'); });
    const bad = fakeReply();
    await routes.get('POST /log-files/:kind/prune')!(fakeReq({ params: { kind: 'wal' } }), asReply(bad));
    expect(bad.code).toHaveBeenCalledWith(400);
    expect(bad.send).toHaveBeenCalledWith({ error: 'kind must be one of logs, history, got: "wal"' });

    mockPruneLogFiles.mockImplementationOnce(() => { throw new Error('EACCES: logs'); });
    const broken = fakeReply();
    await routes.get('POST /log-files/:kind/prune')!(fakeReq({ params: { kind: 'logs' } }), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: logs' });
  });

  it('POST /log-files/:kind/:day/:variant/delete forwards the three parts and answers the result', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockDeleteLogFileEntry.mockReturnValue({ kind: 'logs', deleted: true, file: '2026-10-10.ndjson', bytes: 5, message: 'Deleted' });
    const reply = fakeReply();
    await routes.get('POST /log-files/:kind/:day/:variant/delete')!(fakeReq({ params: { kind: 'logs', day: '2026-10-10', variant: 'daemon' } }), asReply(reply));
    expect(mockDeleteLogFileEntry).toHaveBeenCalledWith(expect.any(String), 'logs', '2026-10-10', 'daemon');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ kind: 'logs', deleted: true, file: '2026-10-10.ndjson', bytes: 5, message: 'Deleted' });
  });

  it('POST /log-files/:kind/:day/:variant/delete maps 400 malformed, 404 no such combination, 409 protected, 500 anything else', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const cases: Array<[Error, number]> = [
      [new InvalidQueryError('day must be a day as YYYY-MM-DD, got: "x"'), 400],
      [new LogFileNotFoundError('The history has no launcher files'), 404],
      [new LogFileInUseError('2026-10-19.ndjson is protected (today (UTC))'), 409],
      [new Error('2026-10-10.ndjson could not be deleted: EBUSY. Close it'), 500],
    ];
    for (const [error, status] of cases) {
      mockDeleteLogFileEntry.mockImplementationOnce(() => { throw error; });
      const reply = fakeReply();
      await routes.get('POST /log-files/:kind/:day/:variant/delete')!(fakeReq({ params: { kind: 'logs', day: 'x', variant: 'daemon' } }), asReply(reply));
      expect(reply.code).toHaveBeenCalledWith(status);
      expect(reply.send).toHaveBeenCalledWith({ error: error.message });
    }
  });

  it('GET /events forwards the query to getEvents', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetEvents.mockReturnValue({ events: [], total: 0, sources: [], sourceOptions: [], problems: [], problemsText: '' });
    const reply = fakeReply();
    await routes.get('GET /events')!(fakeReq({ query: { q: 'job', source: 'flow' } }), asReply(reply));
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), { q: 'job', source: 'flow' });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ events: [], total: 0, sources: [], sourceOptions: [], problems: [], problemsText: '' });
  });

  it('GET /events/detail answers the page of the event named by ?name=, and 500 with the reason when the catalog cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetEventPage.mockReturnValueOnce({ found: true, name: 'job.started' });
    const ok = fakeReply();
    await routes.get('GET /events/detail')!(fakeReq({ query: { name: 'job.started' } }), asReply(ok));
    expect(mockGetEventPage).toHaveBeenCalledWith(expect.any(String), 'job.started');
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith({ found: true, name: 'job.started' });

    mockGetEventPage.mockImplementationOnce(() => { throw new Error('EACCES: events'); });
    const broken = fakeReply();
    await routes.get('GET /events/detail')!(fakeReq({ query: { name: 'x' } }), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: events' });
  });

  it("GET /events/detail without ?name= asks the page for an empty name, which answers found: false with the hint", async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetEventPage.mockReturnValueOnce({ found: false });
    await routes.get("GET /events/detail")!(fakeReq({ query: {} }), asReply(fakeReply()));
    expect(mockGetEventPage).toHaveBeenCalledWith(expect.any(String), '');
  });

  it('GET /events answers 400 with the actionable message for a bad query and 500 for any other failure', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetEvents.mockImplementationOnce(() => { throw new InvalidQueryError('status must be declared or undeclared, got: "x"'); });
    const bad = fakeReply();
    await routes.get('GET /events')!(fakeReq({ query: { status: 'x' } }), asReply(bad));
    expect(bad.code).toHaveBeenCalledWith(400);
    expect(bad.send).toHaveBeenCalledWith({ error: 'status must be declared or undeclared, got: "x"' });

    mockGetEvents.mockImplementationOnce(() => { throw new Error('EACCES: events'); });
    const broken = fakeReply();
    await routes.get('GET /events')!(fakeReq({ query: {} }), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'EACCES: events' });
  });

  it('POST /events/:name/push-test pushes the example of the event and answers the push result', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushTestEvent.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    const reply = fakeReply();
    await routes.get('POST /events/:name/push-test')!(fakeReq({ params: { name: 'job.started' } }), asReply(reply));
    expect(mockPushTestEvent).toHaveBeenCalledWith(expect.any(String), 'job.started');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'queued', eventId: 'e1', message: expect.stringMatching(/^Pushed with the working directory of the dashboard process /) });
  });

  it('POST /events/:name/push-test answers 404 without example, 503 when the daemon is down, 500 otherwise', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const handler = routes.get('POST /events/:name/push-test')!;

    mockPushTestEvent.mockRejectedValueOnce(new TestPayloadNotFoundError('job.completed declares no example payload: add an "example"'));
    const noExample = fakeReply();
    await handler(fakeReq({ params: { name: 'job.completed' } }), asReply(noExample));
    expect(noExample.code).toHaveBeenCalledWith(404);
    expect(noExample.send).toHaveBeenCalledWith({ error: 'job.completed declares no example payload: add an "example"' });

    mockPushTestEvent.mockRejectedValueOnce(new DaemonUnreachableError('Daemon is not running -- start it with `queue start`'));
    const down = fakeReply();
    await handler(fakeReq({ params: { name: 'job.started' } }), asReply(down));
    expect(down.code).toHaveBeenCalledWith(503);

    mockPushTestEvent.mockRejectedValueOnce(new Error('boom'));
    const broken = fakeReply();
    await handler(fakeReq({ params: { name: 'job.started' } }), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'boom' });
  });

  it('POST /events/:name/push-test pushes the edited payload when the body carries one, and answers 400 when it is refused', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const handler = routes.get('POST /events/:name/push-test')!;
    mockPushTestEvent.mockResolvedValueOnce({ status: 'queued', eventId: 'e2' });
    await handler(fakeReq({ params: { name: 'job.started' }, body: { payload: '{"jobId":"x"}' } }), asReply(fakeReply()));
    expect(mockPushTestEvent).toHaveBeenCalledWith(expect.any(String), 'job.started', '{"jobId":"x"}');

    mockPushTestEvent.mockRejectedValueOnce(new InvalidPayloadError('The payload was not pushed: payload.jobId: must be string'));
    const refused = fakeReply();
    await handler(fakeReq({ params: { name: 'job.started' }, body: { payload: '{}' } }), asReply(refused));
    expect(refused.code).toHaveBeenCalledWith(400);
    expect(refused.send).toHaveBeenCalledWith({ error: 'The payload was not pushed: payload.jobId: must be string' });
  });

  it('POST /events/:name/push-test answers 400 with the reason for an event of the reserved queue. namespace (never 500, never 503)', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushTestEvent.mockRejectedValueOnce(new ReservedEventError('queue.dlq.added is emitted by the queue daemon itself, so it cannot be pushed as a test'));
    const reply = fakeReply();
    await routes.get('POST /events/:name/push-test')!(fakeReq({ params: { name: 'queue.dlq.added' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'queue.dlq.added is emitted by the queue daemon itself, so it cannot be pushed as a test' });
  });

  it('POST /events/:name/push-test answers 400 with the reason when the body carries a payload that is not a string, and pushes nothing (validate-payload refuses the same body)', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const handler = routes.get('POST /events/:name/push-test')!;
    for (const payload of [{ jobId: 'x' }, 42, null, ['a']]) {
      const reply = fakeReply();
      await handler(fakeReq({ params: { name: 'job.started' }, body: { payload } }), asReply(reply));
      expect(reply.code).toHaveBeenCalledWith(400);
      expect(String((reply.send.mock.calls[0]![0] as { error: string }).error)).toMatch(/payload.*string.*JSON text/);
    }
    expect(mockPushTestEvent).not.toHaveBeenCalled();
  });

  it('POST /events/:name/validate-payload and push-test answer 422 naming the event when its schema cannot be compiled', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const message = 'The schema declared by job.broken cannot be used to check a payload (type must be one of the allowed values). Fix: correct the "schema" in the declaration';
    mockValidateEventPayload.mockImplementationOnce(() => { throw new SchemaUnusableError(message); });
    const validation = fakeReply();
    await routes.get('POST /events/:name/validate-payload')!(fakeReq({ params: { name: 'job.broken' }, body: { payload: '{}' } }), asReply(validation));
    expect(validation.code).toHaveBeenCalledWith(422);
    expect(validation.send).toHaveBeenCalledWith({ error: message });

    mockPushTestEvent.mockRejectedValueOnce(new SchemaUnusableError(message));
    const push = fakeReply();
    await routes.get('POST /events/:name/push-test')!(fakeReq({ params: { name: 'job.broken' }, body: { payload: '{}' } }), asReply(push));
    expect(push.code).toHaveBeenCalledWith(422);
    expect(push.send).toHaveBeenCalledWith({ error: message });
  });

  it('POST /events/:name/push-test pushes from the working directory of the project it is given, and says which directory was used', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockResolveProjectCwd.mockReturnValue({ cwd: '/work/app', projectName: 'app' });
    mockPushTestEvent.mockResolvedValue({ status: 'queued', eventId: 'e1', subscriberCount: 1 });
    const reply = fakeReply();
    await routes.get('POST /events/:name/push-test')!(fakeReq({ params: { name: 'job.started' }, body: { project: 'deadbeef' } }), asReply(reply));
    expect(mockResolveProjectCwd).toHaveBeenCalledWith(expect.any(String), 'deadbeef');
    expect(mockPushTestEvent).toHaveBeenCalledWith(expect.any(String), 'job.started', undefined, { cwd: '/work/app' });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'queued', eventId: 'e1', subscriberCount: 1, message: 'Pushed with the working directory of project "app": /work/app.' });
  });

  it('POST /events/:name/push-test without a project says it used the working directory of the dashboard and how to push from a project', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushTestEvent.mockResolvedValue({ status: 'queued', eventId: 'e1', subscriberCount: 1 });
    const reply = fakeReply();
    await routes.get('POST /events/:name/push-test')!(fakeReq({ params: { name: 'job.started' } }), asReply(reply));
    const body = reply.send.mock.calls[0]![0] as { message: string };
    expect(body.message).toContain(process.cwd());
    expect(body.message).toMatch(/dashboard/);
    expect(body.message).toMatch(/project/);
  });

  it('POST /push resolves a project to its working directory, refuses project together with cwd, and maps an unknown project to 404 and a malformed one to 400', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const handler = routes.get('POST /push')!;
    mockResolveProjectCwd.mockReturnValue({ cwd: '/work/app', projectName: 'app' });
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1', subscriberCount: 1 });
    const ok = fakeReply();
    await handler(fakeReq({ body: { event: 'onFoo', payload: {}, project: 'deadbeef' } }), asReply(ok));
    expect(mockPushEvent).toHaveBeenCalledWith(expect.any(String), 'onFoo', {}, { cwd: '/work/app', timeout: undefined });
    expect(ok.send).toHaveBeenCalledWith({ status: 'queued', eventId: 'e1', subscriberCount: 1, message: 'Pushed with the working directory of project "app": /work/app.' });

    mockPushEvent.mockClear();
    const both = fakeReply();
    await handler(fakeReq({ body: { event: 'onFoo', payload: {}, project: 'deadbeef', cwd: '/x' } }), asReply(both));
    expect(both.code).toHaveBeenCalledWith(400);
    expect(mockPushEvent).not.toHaveBeenCalled();

    mockResolveProjectCwd.mockImplementationOnce(() => { throw new UnknownProjectError('No project with id deadbeef'); });
    const unknown = fakeReply();
    await handler(fakeReq({ body: { event: 'onFoo', payload: {}, project: 'deadbeef' } }), asReply(unknown));
    expect(unknown.code).toHaveBeenCalledWith(404);

    mockResolveProjectCwd.mockImplementationOnce(() => { throw new InvalidQueryError('project must be the id of a registered project'); });
    const malformed = fakeReply();
    await handler(fakeReq({ body: { event: 'onFoo', payload: {}, project: 'zz' } }), asReply(malformed));
    expect(malformed.code).toHaveBeenCalledWith(400);
  });

  it('POST /push says which working directory was used: the explicit cwd, or the dashboard process one with the way to push from a project', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const handler = routes.get('POST /push')!;
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1', subscriberCount: 1 });
    const explicit = fakeReply();
    await handler(fakeReq({ body: { event: 'onFoo', payload: {}, cwd: '/some/dir' } }), asReply(explicit));
    expect((explicit.send.mock.calls[0]![0] as { message: string }).message).toBe('Pushed with the working directory /some/dir.');

    const implicit = fakeReply();
    await handler(fakeReq({ body: { event: 'onFoo', payload: {} } }), asReply(implicit));
    const message = (implicit.send.mock.calls[0]![0] as { message: string }).message;
    expect(message).toContain(process.cwd());
    expect(message).toMatch(/dashboard/);
    expect(message).toMatch(/"project"/);
  });

  it('a push that matched no subscriber keeps its own warning and still says the working directory', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1', subscriberCount: 0 });
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: {}, cwd: '/some/dir' } }), asReply(reply));
    const message = (reply.send.mock.calls[0]![0] as { message: string }).message;
    expect(message).toMatch(/no subscriber matches/);
    expect(message).toContain('/some/dir');
  });

  it('POST /dlq/:id/clear, /pending/:id/give-up and /pending/give-up-stuck pass the `message` through when the daemon could not be told, and the operation is a 200', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const note = 'The queue.dlq.removed (1 entry) event could not be sent because the daemon is not running';
    mockClearDlqEntry.mockResolvedValueOnce({ cleared: 1, message: `Entry removed. ${note}` });
    const cleared = fakeReply();
    await routes.get('POST /dlq/:id/clear')!(fakeReq({ params: { id: 'd1' } }), asReply(cleared));
    expect(cleared.code).toHaveBeenCalledWith(200);
    expect(cleared.send).toHaveBeenCalledWith({ cleared: 1, message: `Entry removed. ${note}` });

    mockGiveUpPending.mockResolvedValueOnce({ status: 'moved', message: 'Moved to the dead-letter queue. daemon is not running' });
    const moved = fakeReply();
    await routes.get('POST /pending/:id/give-up')!(fakeReq({ params: { id: 'f1' } }), asReply(moved));
    expect(moved.code).toHaveBeenCalledWith(200);
    expect(moved.send).toHaveBeenCalledWith({ status: 'moved', message: 'Moved to the dead-letter queue. daemon is not running' });

    mockGiveUpStuck.mockResolvedValueOnce({ moved: 2, message: '2 stuck events moved to the dead-letter queue. daemon is not running' });
    const stuck = fakeReply();
    await routes.get('POST /pending/give-up-stuck')!(fakeReq(), asReply(stuck));
    expect(stuck.code).toHaveBeenCalledWith(200);
    expect(stuck.send).toHaveBeenCalledWith({ moved: 2, message: '2 stuck events moved to the dead-letter queue. daemon is not running' });
  });

  it('POST /events/:name/validate-payload answers the verdict for the text of the body, 404 for an event nobody declares, 400 without text', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const handler = routes.get('POST /events/:name/validate-payload')!;
    mockValidateEventPayload.mockReturnValueOnce({ valid: true, errors: [], message: 'The payload matches the schema' });
    const ok = fakeReply();
    await handler(fakeReq({ params: { name: 'job.started' }, body: { payload: '{}' } }), asReply(ok));
    expect(mockValidateEventPayload).toHaveBeenCalledWith(expect.any(String), 'job.started', '{}');
    expect(ok.send).toHaveBeenCalledWith({ valid: true, errors: [], message: 'The payload matches the schema' });

    mockValidateEventPayload.mockImplementationOnce(() => { throw new TestPayloadNotFoundError('x is not declared by any program'); });
    const unknown = fakeReply();
    await handler(fakeReq({ params: { name: 'x' }, body: { payload: '{}' } }), asReply(unknown));
    expect(unknown.code).toHaveBeenCalledWith(404);

    const noBody = fakeReply();
    await handler(fakeReq({ params: { name: 'job.started' }, body: {} }), asReply(noBody));
    expect(noBody.code).toHaveBeenCalledWith(400);
    expect(String((noBody.send.mock.calls[0]![0] as { error: string }).error)).toContain('payload');
  });

  it('GET /daemon answers the daemon state', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetDaemonState.mockResolvedValue({ running: false, hint: 'start it' });
    const reply = fakeReply();
    await routes.get('GET /daemon')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ running: false, hint: 'start it' });
  });

  it('GET /daemon answers 500 with the reason when the check itself fails', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetDaemonState.mockRejectedValue(new Error('unexpected'));
    const reply = fakeReply();
    await routes.get('GET /daemon')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'unexpected' });
  });

  it('GET /relay answers the relay state, and 500 with the reason when it cannot be read', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetRelayInfo.mockResolvedValueOnce({ state: 'stopped', running: false, connected: false, pid: null, uptimeSec: null, lastError: null });
    const ok = fakeReply();
    await routes.get('GET /relay')!(fakeReq(), asReply(ok));
    expect(ok.code).toHaveBeenCalledWith(200);
    expect(ok.send).toHaveBeenCalledWith(expect.objectContaining({ state: 'stopped' }));

    mockGetRelayInfo.mockRejectedValueOnce(new Error('relay answered garbage'));
    const broken = fakeReply();
    await routes.get('GET /relay')!(fakeReq(), asReply(broken));
    expect(broken.code).toHaveBeenCalledWith(500);
    expect(broken.send).toHaveBeenCalledWith({ error: 'relay answered garbage' });
  });

  it('GET /relay/webhooks and /relay/deliveries answer what the remote relay says', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListWebhooks.mockResolvedValueOnce({ webhooks: [] });
    const webhooks = fakeReply();
    await routes.get('GET /relay/webhooks')!(fakeReq(), asReply(webhooks));
    expect(webhooks.code).toHaveBeenCalledWith(200);
    expect(webhooks.send).toHaveBeenCalledWith({ webhooks: [] });

    mockListDeliveries.mockResolvedValueOnce({ deliveries: [] });
    const deliveries = fakeReply();
    await routes.get('GET /relay/deliveries')!(fakeReq({ query: { limit: '5', status: 'rejected' } }), asReply(deliveries));
    expect(mockListDeliveries).toHaveBeenCalledWith(expect.any(String), { limit: '5', status: 'rejected' });
    expect(deliveries.code).toHaveBeenCalledWith(200);
  });

  it.each([
    ['a bad query', new InvalidQueryError('limit must be an integer between 1 and 200, got: "0"'), 400],
    ['a relay that is not configured here', new RelayNotConfiguredError('No relay.yml in /cfg.'), 503],
    ['a remote relay that refuses or fails', new RelayApiError('The relay refused the token', 401, 'unauthorized'), 502],
    ['anything else', new Error('boom'), 500],
  ])('GET /relay/deliveries answers the right status for %s', async (_name, error, status) => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListDeliveries.mockRejectedValueOnce(error);
    const reply = fakeReply();
    await routes.get('GET /relay/deliveries')!(fakeReq({ query: {} }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(status);
    expect(reply.send).toHaveBeenCalledWith({ error: getErrorMessage(error) });
  });

  it('GET /relay/webhooks uses the same status mapping', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListWebhooks.mockRejectedValueOnce(new RelayNotConfiguredError('No relay.yml in /cfg.'));
    const reply = fakeReply();
    await routes.get('GET /relay/webhooks')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
  });

  it('POST /retry/:eventId answers 200 with the daemon answer when the retry was enqueued', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockRetryEvent.mockResolvedValue({ status: 'ok' });
    const reply = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'wal-1' } }), asReply(reply));
    expect(mockRetryEvent).toHaveBeenCalledWith(expect.any(String), 'wal-1');
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('POST /retry/:eventId answers 404 naming the cause when the event is not pending', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockRetryEvent.mockResolvedValue({ status: 'not-found' });
    const reply = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'gone' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({ error: expect.stringContaining('No pending event with id gone') });
  });

  it('POST /retry/:eventId answers 409 with the reason when the daemon refuses an entry already delivered or in the DLQ', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockRetryEvent.mockResolvedValueOnce({ status: 'error', message: 'WAL entry wal-1 was already delivered (status acked)' });
    const reply = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'wal-1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({ error: 'WAL entry wal-1 was already delivered (status acked)' });
  });

  it('POST /retry/:eventId answers 500 when the daemon reports an error, 503 when it is not running', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockRetryEvent.mockResolvedValueOnce({ status: 'error' });
    const failed = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'wal-1' } }), asReply(failed));
    expect(failed.code).toHaveBeenCalledWith(500);

    mockRetryEvent.mockRejectedValueOnce(new DaemonUnreachableError('Daemon is not running -- start it with `queue start`'));
    const down = fakeReply();
    await routes.get('POST /retry/:eventId')!(fakeReq({ params: { eventId: 'wal-1' } }), asReply(down));
    expect(down.code).toHaveBeenCalledWith(503);
  });

  it('GET /status returns 500 when getStatus throws', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetStatus.mockImplementation(() => { throw new Error('Disk read error'); });
    const reply = fakeReply();
    await routes.get('GET /status')!(fakeReq(), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Disk read error' });
  });

  it('GET /history/:eventId returns 500 when getHistoryEntry throws', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockGetHistoryEntry.mockImplementation(() => {
      throw new Error('File system error');
    });
    const reply = fakeReply();
    routes.get('GET /history/:eventId')!(fakeReq({ params: { eventId: 'e1' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'File system error' });
  });

  it('GET /history returns 500 when listHistory throws non-InvalidQueryError', () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListHistory.mockImplementation(() => {
      throw new Error('Unexpected database error');
    });
    const reply = fakeReply();
    routes.get('GET /history')!(fakeReq({ query: {} }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected database error' });
  });

  it('POST /push returns 400 when body is null', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: null }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'POST /push expects a JSON body { event: string, payload?: any, cwd?: string, project?: string, timeout?: number }; got: null',
    });
  });

  it('POST /push returns 400 when body is undefined', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({}), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'POST /push expects a JSON body { event: string, payload?: any, cwd?: string, project?: string, timeout?: number }; got: undefined',
    });
  });

  it('POST /push returns 400 when body is not an object', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: 'string' }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'POST /push expects a JSON body { event: string, payload?: any, cwd?: string, project?: string, timeout?: number }; got: "string"',
    });
  });

  it('POST /push returns 400 when event is missing', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { payload: { a: 1 } } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be a non-empty string',
    });
  });

  it('POST /push returns 400 when event is empty string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: '', payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be a non-empty string',
    });
  });

  it('POST /push returns 400 when event is not a string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 123, payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be a non-empty string',
    });
  });

  it('POST /push returns 400 when cwd is empty string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, cwd: '' } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'cwd must be a non-empty string',
    });
  });

  it('POST /push returns 400 when cwd is not a string', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, cwd: 123 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'cwd must be a non-empty string',
    });
  });

  it('POST /push returns 400 when timeout is 0', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, timeout: 0 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'timeout must be a positive integer (ms)',
    });
  });

  it('POST /push returns 400 when timeout is negative', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, timeout: -5 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'timeout must be a positive integer (ms)',
    });
  });

  it('POST /push returns 400 when timeout is not an integer', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null, timeout: 5.5 } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'timeout must be a positive integer (ms)',
    });
  });

  it('POST /push forwards valid request to pushEvent and returns 200', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: { a: 1 } } }), asReply(reply));
    expect(mockPushEvent).toHaveBeenCalledWith(expect.any(String), 'onFoo', { a: 1 }, { cwd: undefined, timeout: undefined });
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'queued', eventId: 'e1', message: expect.stringMatching(/^Pushed with the working directory of the dashboard process /) });
  });

  it('POST /push returns 503 when DaemonUnreachableError is thrown', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockRejectedValue(new DaemonUnreachableError('Daemon is not running -- start it with `queue start`'));
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Daemon is not running -- start it with `queue start`',
    });
  });

  it('POST /push returns 500 for other errors', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockRejectedValue(new Error('Unexpected error'));
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: null } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unexpected error' });
  });

  it('GET /subscribers returns 400 when cwd is duplicated', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { cwd: ['/path1', '/path2'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'cwd must be given once, got 2 values',
    });
  });

  it('GET /subscribers returns 400 when event is duplicated', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { event: ['onFoo', 'onBar'] } }), asReply(reply));
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'event must be given once, got 2 values',
    });
  });

  it('GET /subscribers uses default cwd when not provided', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListSubscribers.mockResolvedValue([]);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: {} }), asReply(reply));
    // undefined: listSubscribers reads the working directory of the process itself
    expect(mockListSubscribers).toHaveBeenCalledWith(expect.any(String), undefined, undefined, expect.any(String));
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('GET /subscribers uses provided cwd', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockListSubscribers.mockResolvedValue([]);
    const reply = fakeReply();
    await routes.get('GET /subscribers')!(fakeReq({ query: { cwd: '/custom/path' } }), asReply(reply));
    expect(mockListSubscribers).toHaveBeenCalledWith(expect.any(String), '/custom/path', undefined, expect.any(String));
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('POST /push forwards the request body to pushEvent', async () => {
    const { routes, ctx } = collectRoutes();
    backend(ctx);
    mockPushEvent.mockResolvedValue({ status: 'queued', eventId: 'e1' });
    const reply = fakeReply();
    await routes.get('POST /push')!(fakeReq({ body: { event: 'onFoo', payload: { a: 1 } } }), asReply(reply));
    expect(mockPushEvent).toHaveBeenCalledWith(expect.any(String), 'onFoo', { a: 1 }, { cwd: undefined, timeout: undefined });
    expect(reply.code).toHaveBeenCalledWith(200);
  });
});
