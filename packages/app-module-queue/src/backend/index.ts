// violations-suppress: ts/no-barrel-index app-core requires the backend entry of an app-module to be src/backend/index.ts (app-core-cli check)
import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { getErrorMessage, getQueueConfigDir, isRecord } from '@wadeck-app/queue-core';
import { getStatus } from './status.js';
import { getActivity, getActivitySeries } from './activity.js';
import { getOutcomes } from './outcomes.js';
import { getBreakdown } from './breakdown.js';
import { listPending } from './pending.js';
import { listHistory, getHistoryEntry } from './history.js';
import { replayEvent } from './replay.js';
import { DaemonUnreachableError, ReplayNotFoundError, ReplayError, InvalidQueryError, RelayNotConfiguredError, TestPayloadNotFoundError, InvalidPayloadError, PendingNotFoundError, NotInFlightError } from './errors.js';
import { RelayApiError } from '@wadeck-app/queue-relay-client/dist/relayApi.js';
import { listDlq, replayDlqEntry, clearDlqEntry } from './dlq.js';
import { getLogs } from './logs.js';
import { getEvents, getEventPage, pushTestEvent, validateEventPayload } from './events.js';
import { retryEvent } from './retry.js';
import { giveUpPending, giveUpStuck } from './pending.js';
import { getDaemonState } from './daemon.js';
import { getRelayInfo } from './relay.js';
import { listWebhooks, listDeliveries } from './relayWebhooks.js';
import { listSubscribers } from './subscribers.js';
import { pushEvent } from './push.js';
import { parseHistoryQuery, validateSingleString } from './historyQuery.js';
import { getOverviewRange } from './overviewRange.js';

interface QueryParams { [key: string]: string | string[] | undefined }

/** 400 bad query, 503 relay not configured here, 502 the remote relay failed or refused, 500 anything else. */
function relayErrorStatus(err: unknown): number {
  if (err instanceof InvalidQueryError) {
    return 400;
  }
  if (err instanceof RelayNotConfiguredError) {
    return 503;
  }
  return err instanceof RelayApiError ? 502 : 500;
}

/**
 * backendEntryPath target declared in manifest.json. app-core calls this once at module
 * load with moduleContext, per the registration contract confirmed with app-core-owner
 * (2026-10-11): routes become /api/modules/queue/<subPath>, auto-removed on unload.
 */
export default function (ctx: ModuleContext): void {
  const configDir = getQueueConfigDir();

  ctx.registerRoute('GET', '/status', (_req, reply) => {
    try {
      return reply.code(200).send(getStatus(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/activity', (_req, reply) => {
    try {
      return reply.code(200).send(getActivity(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/activity/series', (_req, reply) => {
    try {
      return reply.code(200).send(getActivitySeries(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/outcomes', (_req, reply) => {
    try {
      return reply.code(200).send(getOutcomes(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/breakdown', (_req, reply) => {
    try {
      return reply.code(200).send(getBreakdown(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // The totals and charts of one period of the Overview page (?range=1h|6h|24h|3d|7d, default 24h)
  ctx.registerRoute('GET', '/overview', (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    try {
      return reply.code(200).send(getOverviewRange(configDir, validateSingleString(query['range'], 'range')));
    } catch (err) {
      return reply.code(err instanceof InvalidQueryError ? 400 : 500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/history', (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    try {
      const { filter, pagination } = parseHistoryQuery(query);
      const page = listHistory(configDir, filter, pagination);
      return reply.code(200).send(page);
    } catch (err) {
      if (err instanceof InvalidQueryError) {
        return reply.code(400).send({ error: getErrorMessage(err) });
      }
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/history/:eventId', (req, reply) => {
    const { eventId } = req.params;
    try {
      const entry = getHistoryEntry(configDir, eventId);
      if (!entry) {
        return reply.code(404).send({ error: `No history entry for eventId ${eventId}` });
      }
      return reply.code(200).send(entry);
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/history/:eventId/replay', async (req, reply) => {
    const { eventId } = req.params;
    try {
      return reply.code(200).send(await replayEvent(configDir, eventId));
    } catch (err) {
      // DaemonUnreachableError => 503 (daemon not running)
      // ReplayNotFoundError => 404 (unknown eventId)
      // ReplayError (not NotFoundError) => 422 (entry exists but no payload)
      // Other errors => 500 (internal server error)
      if (err instanceof DaemonUnreachableError) {
        return reply.code(503).send({ error: getErrorMessage(err) });
      }
      if (err instanceof ReplayNotFoundError) {
        return reply.code(404).send({ error: getErrorMessage(err) });
      }
      if (err instanceof ReplayError) {
        return reply.code(422).send({ error: getErrorMessage(err) });
      }
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/logs', (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    try {
      return reply.code(200).send(getLogs(configDir, query));
    } catch (err) {
      return reply.code(err instanceof InvalidQueryError ? 400 : 500).send({ error: getErrorMessage(err) });
    }
  });

  // The event catalog (what the programs declared) joined with the history; filters: q, source, status, prefix, match, declaredOnly, terminal
  ctx.registerRoute('GET', '/events', (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    try {
      return reply.code(200).send(getEvents(configDir, query));
    } catch (err) {
      return reply.code(err instanceof InvalidQueryError ? 400 : 500).send({ error: getErrorMessage(err) });
    }
  });

  // Everything the page of one event shows (?name=<event name>); an unknown name answers found: false with the closest names
  ctx.registerRoute('GET', '/events/detail', (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    const name = typeof query['name'] === 'string' ? query['name'] : '';
    try {
      return reply.code(200).send(getEventPage(configDir, name));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // Checks the text of an edited example against the schema the event declares (body { payload: "<json text>" })
  ctx.registerRoute('POST', '/events/:name/validate-payload', (req, reply) => {
    const { name } = req.params;
    const body = (req as { body: unknown }).body;
    if (!isRecord(body) || typeof body['payload'] !== 'string') {
      return reply.code(400).send({ error: `POST /events/${name}/validate-payload expects a JSON body { payload: string } (the JSON text to check); got: ${JSON.stringify(body)}` });
    }
    try {
      return reply.code(200).send(validateEventPayload(configDir, name, body['payload']));
    } catch (err) {
      return reply.code(err instanceof TestPayloadNotFoundError ? 404 : 500).send({ error: getErrorMessage(err) });
    }
  });

  // Pushes the declared example of the event through the daemon, or the edited one when the body carries { payload: "<json text>" }:
  // it runs the real subscribers of that event
  ctx.registerRoute('POST', '/events/:name/push-test', async (req, reply) => {
    const { name } = req.params;
    const body = (req as { body?: unknown }).body;
    const payloadText = isRecord(body) && typeof body['payload'] === 'string' ? body['payload'] : undefined;
    try {
      return reply.code(200).send(await pushTestEvent(configDir, name, ...(payloadText === undefined ? [] : [payloadText])));
    } catch (err) {
      if (err instanceof TestPayloadNotFoundError) {
        return reply.code(404).send({ error: getErrorMessage(err) });
      }
      if (err instanceof InvalidPayloadError) {
        return reply.code(400).send({ error: getErrorMessage(err) });
      }
      return reply.code(err instanceof DaemonUnreachableError ? 503 : 500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/retry/:eventId', async (req, reply) => {
    const { eventId } = req.params;
    try {
      const response = await retryEvent(configDir, eventId);
      if (response.status === 'not-found') {
        return reply.code(404).send({ error: `No pending event with id ${eventId} (retry only applies to events still in the WAL)` });
      }
      return reply.code(response.status === 'ok' ? 200 : 500).send(response);
    } catch (err) {
      return reply.code(err instanceof DaemonUnreachableError ? 503 : 500).send({ error: getErrorMessage(err) });
    }
  });

  // Moves every event that waited so long that nobody retries it any more to the dead-letter queue (nothing is deleted; no daemon needed)
  ctx.registerRoute('POST', '/pending/give-up-stuck', (_req, reply) => {
    try {
      return reply.code(200).send(giveUpStuck(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // Moves an event nobody retries any more to the dead-letter queue (nothing is deleted; no daemon needed)
  ctx.registerRoute('POST', '/pending/:id/give-up', (req, reply) => {
    const { id } = req.params;
    try {
      return reply.code(200).send(giveUpPending(configDir, id));
    } catch (err) {
      const status = err instanceof PendingNotFoundError ? 404 : err instanceof NotInFlightError ? 409 : 500;
      return reply.code(status).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/daemon', async (_req, reply) => {
    try {
      return reply.code(200).send(await getDaemonState(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/relay', async (_req, reply) => {
    try {
      return reply.code(200).send(await getRelayInfo(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/relay/webhooks', async (_req, reply) => {
    try {
      return reply.code(200).send(await listWebhooks(configDir));
    } catch (err) {
      return reply.code(relayErrorStatus(err)).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/relay/deliveries', async (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    try {
      return reply.code(200).send(await listDeliveries(configDir, query));
    } catch (err) {
      return reply.code(relayErrorStatus(err)).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/pending', (_req, reply) => {
    try {
      return reply.code(200).send(listPending(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/dlq', (req, reply) => {
    try {
      const project = (req as { query?: QueryParams }).query?.['project'];
      if (project !== undefined && project !== '' && (typeof project !== 'string' || !/^[0-9a-f]{8}$/.test(project))) {
        return reply.code(400).send({ error: `project must be the id of a registered project (8 hexadecimal characters, project list shows them), got: ${JSON.stringify(project)}` });
      }
      const entries = listDlq(configDir, project === undefined || project === '' ? undefined : project);
      return reply.code(200).send({ entries });
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/dlq/:id/replay', async (req, reply) => {
    const { id } = req.params;
    try {
      return reply.code(200).send(await replayDlqEntry(configDir, id));
    } catch (err) {
      return reply.code(err instanceof DaemonUnreachableError ? 503 : 500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/dlq/:id/clear', (req, reply) => {
    const { id } = req.params;
    try {
      return reply.code(200).send(clearDlqEntry(configDir, id));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/subscribers', async (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};

    // Reject repeated cwd values
    const cwdValue = query['cwd'];
    if (Array.isArray(cwdValue)) {
      return reply.code(400).send({ error: `cwd must be given once, got ${cwdValue.length} values` });
    }
    const cwd = cwdValue ?? process.cwd();

    // Reject repeated event values
    const eventValue = query['event'];
    if (Array.isArray(eventValue)) {
      return reply.code(400).send({ error: `event must be given once, got ${eventValue.length} values` });
    }
    const event = eventValue;

    try {
      return reply.code(200).send({ subscribers: listSubscribers(configDir, cwd, event) });
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/push', async (req, reply) => {
    const body = (req as { body: unknown }).body;

    // Validate body before try block
    if (!isRecord(body)) {
      return reply.code(400).send({
        error: `POST /push expects a JSON body { event: string, payload?: any, cwd?: string, timeout?: number }; got: ${JSON.stringify(body)}`,
      });
    }

    const { event, payload, cwd, timeout } = body;

    // Validate event
    if (typeof event !== 'string' || event === '') {
      return reply.code(400).send({ error: 'event must be a non-empty string' });
    }

    // Validate cwd if present
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) {
      return reply.code(400).send({ error: 'cwd must be a non-empty string' });
    }

    // Validate timeout if present
    if (timeout !== undefined && (!Number.isInteger(timeout) || typeof timeout !== 'number' || timeout <= 0)) {
      return reply.code(400).send({ error: 'timeout must be a positive integer (ms)' });
    }

    try {
      return reply.code(200).send(await pushEvent(configDir, event, payload, { cwd: cwd as string | undefined, timeout: timeout as number | undefined }));
    } catch (err) {
      if (err instanceof DaemonUnreachableError) {
        return reply.code(503).send({ error: getErrorMessage(err) });
      }
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });
}
