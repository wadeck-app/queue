// violations-suppress: ts/no-barrel-index app-core requires the backend entry of an app-module to be src/backend/index.ts (app-core-cli check)
import type { ModuleContext } from '@wadeck-app/app-core-sdk';
import { getErrorMessage, getQueueConfigDir, isRecord } from '@wadeck-app/queue-core';
import { getStatus } from './status.js';
import { getActivity } from './activity.js';
import { listHistory, getHistoryEntry } from './history.js';
import { replayEvent } from './replay.js';
import { DaemonUnreachableError, ReplayNotFoundError, ReplayError, InvalidQueryError } from './errors.js';
import { listDlq, replayDlqEntry, clearDlqEntry } from './dlq.js';
import { getLogs } from './logs.js';
import { retryEvent } from './retry.js';
import { listSubscribers } from './subscribers.js';
import { pushEvent } from './push.js';
import { parseHistoryQuery } from './historyQuery.js';

interface QueryParams { [key: string]: string | string[] | undefined }

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

  ctx.registerRoute('GET', '/dlq', (_req, reply) => {
    try {
      return reply.code(200).send({ entries: listDlq(configDir) });
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
