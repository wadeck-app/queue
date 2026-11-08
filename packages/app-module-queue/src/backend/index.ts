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
import { DaemonUnreachableError, ReplayNotFoundError, ReplayError, InvalidQueryError, RelayNotConfiguredError, TestPayloadNotFoundError, InvalidPayloadError, ReservedEventError, PendingNotFoundError, NotInFlightError, UnknownProjectError, SchemaUnusableError, LogFileNotFoundError, LogFileInUseError, RelayStatusError } from './errors.js';
import { RelayApiError } from '@wadeck-app/queue-relay-client/dist/relayApi.js';
import { listDlq, replayDlqEntry, clearDlqEntry } from './dlq.js';
import { getLogs } from './logs.js';
import { getLogFiles, pruneLogFiles, deleteLogFileEntry } from './logFiles.js';
import { getEvents, getEventPage, pushTestEvent, validateEventPayload } from './events.js';
import { retryEvent } from './retry.js';
import { giveUpPending, giveUpStuck } from './pending.js';
import { getDaemonState } from './daemon.js';
import { getRelayInfo } from './relay.js';
import { listWebhooks, listDeliveries } from './relayWebhooks.js';
import { listSubscribers } from './subscribers.js';
import { listProjectOptions, assertProjectId } from './projects.js';
import { getRelatedForProject } from './related.js';
import { getProjectScope } from './projectScope.js';
import { defaultRegistryDir } from '@wadeck-app/project-sdk';
import { pushEvent } from './push.js';
import { parseHistoryQuery, validateSingleString } from './historyQuery.js';
import { getOverviewRange } from './overviewRange.js';
import { pushAnswer, dlqReplayAnswer, dlqClearAnswer, retryAnswer, withPushOrigin, type PushOrigin } from './httpAnswers.js';
import { resolveProjectCwd } from './projectCwd.js';

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

/** 400 malformed kind/day/variant, 404 no such combination, 409 the file is protected, 500 anything else. */
function logFilesErrorStatus(err: unknown): number {
  if (err instanceof InvalidQueryError) {
    return 400;
  }
  if (err instanceof LogFileNotFoundError) {
    return 404;
  }
  return err instanceof LogFileInUseError ? 409 : 500;
}

/**
 * Where a push is made from: the working directory of the registered project given as `project` (id), else the explicit `cwd`, else the one of this process
 * (where app-core runs, which is in no project). Both `project` and `cwd` is refused: the answer could not say which one was used. An empty `project` is absent
 * (a cleared control of the page).
 */
function originOf(body: unknown, explicitCwd: string | undefined): PushOrigin {
  const project = isRecord(body) && body['project'] !== '' ? body['project'] : undefined;
  if (project !== undefined && explicitCwd !== undefined) {
    throw new InvalidQueryError('Give either "project" (the id of a registered project) or "cwd", not both: the push can only come from one working directory.');
  }
  if (project !== undefined) {
    const { cwd, projectName } = resolveProjectCwd(defaultRegistryDir(process.env), project);
    return { kind: 'project', projectName, cwd };
  }
  return explicitCwd === undefined ? { kind: 'process', cwd: process.cwd() } : { kind: 'cwd', cwd: explicitCwd };
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
      const answer = pushAnswer(await replayEvent(configDir, eventId));
      return reply.code(answer.code).send(answer.body);
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

  // The log and history files with size, date and what the retention would do with each (a missing directory is an empty section)
  ctx.registerRoute('GET', '/log-files', (_req, reply) => {
    try {
      return reply.code(200).send(getLogFiles(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // Deletes what the retention policy would delete now in one directory (kind: logs | history); recomputed here, never the preview.
  // 400 bad kind, 500 unreadable directory. A file that cannot be deleted is a 500 too (the page shows the `error`, a 200 without `successMessage` shows nothing):
  // the body keeps everything the 200 carries (what was deleted, the failures) plus ok: false, failedCount and the same text as `error`
  ctx.registerRoute('POST', '/log-files/:kind/prune', (req, reply) => {
    const { kind } = req.params;
    try {
      const result = pruneLogFiles(configDir, kind);
      if (result.failures.length > 0) {
        return reply.code(500).send({ ...result, ok: false, failedCount: result.failures.length, error: result.message });
      }
      return reply.code(200).send(result);
    } catch (err) {
      return reply.code(logFilesErrorStatus(err)).send({ error: getErrorMessage(err) });
    }
  });

  // Deletes ONE log file named by kind, day and variant (never a path). 400 malformed, 404 no such combination,
  // 409 protected (today, future, recently modified), 500 not deletable; a file already gone is a 200 with deleted: false
  ctx.registerRoute('POST', '/log-files/:kind/:day/:variant/delete', (req, reply) => {
    const { kind, day, variant } = req.params;
    try {
      return reply.code(200).send(deleteLogFileEntry(configDir, kind, day, variant));
    } catch (err) {
      return reply.code(logFilesErrorStatus(err)).send({ error: getErrorMessage(err) });
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
      const status = err instanceof TestPayloadNotFoundError ? 404 : err instanceof SchemaUnusableError ? 422 : 500;
      return reply.code(status).send({ error: getErrorMessage(err) });
    }
  });

  // Pushes the declared example of the event through the daemon, or the edited one when the body carries { payload: "<json text>" }:
  // it runs the real subscribers of that event. A `payload` that is not a string is a 400 (never silently replaced by the example). `project` (id of a registered
  // project) pushes from its working directory, so that the subscribers limited to it match; the answer's `message` says which directory was used.
  ctx.registerRoute('POST', '/events/:name/push-test', async (req, reply) => {
    const { name } = req.params;
    const body = (req as { body?: unknown }).body;
    if (isRecord(body) && 'payload' in body && typeof body['payload'] !== 'string') {
      return reply.code(400).send({ error: `POST /events/${name}/push-test: payload must be a string (the JSON text to push), got ${body['payload'] === null ? 'null' : Array.isArray(body['payload']) ? 'an array' : `a ${typeof body['payload']}`}. Omit it to push the declared example.` });
    }
    const payloadText = isRecord(body) ? (body['payload'] as string | undefined) : undefined;
    try {
      const origin = originOf(body, undefined);
      const pushed = origin.kind === 'process'
        ? await (payloadText === undefined ? pushTestEvent(configDir, name) : pushTestEvent(configDir, name, payloadText))
        : await pushTestEvent(configDir, name, payloadText, { cwd: origin.cwd });
      const answer = withPushOrigin(pushAnswer(pushed), origin);
      return reply.code(answer.code).send(answer.body);
    } catch (err) {
      if (err instanceof TestPayloadNotFoundError || err instanceof UnknownProjectError) {
        return reply.code(404).send({ error: getErrorMessage(err) });
      }
      if (err instanceof InvalidPayloadError || err instanceof ReservedEventError || err instanceof InvalidQueryError) {
        return reply.code(400).send({ error: getErrorMessage(err) });
      }
      if (err instanceof SchemaUnusableError) {
        return reply.code(422).send({ error: getErrorMessage(err) });
      }
      return reply.code(err instanceof DaemonUnreachableError ? 503 : 500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/retry/:eventId', async (req, reply) => {
    const { eventId } = req.params;
    try {
      const answer = retryAnswer(await retryEvent(configDir, eventId), eventId);
      return reply.code(answer.code).send(answer.body);
    } catch (err) {
      return reply.code(err instanceof DaemonUnreachableError ? 503 : 500).send({ error: getErrorMessage(err) });
    }
  });

  // Moves every event that waited so long that nobody retries it any more to the dead-letter queue (nothing is deleted). The daemon does the move and emits queue.dlq.added itself
  // (this module writes nothing); when it is not reachable the move is done on the files and the response `message` says the event could not be sent
  ctx.registerRoute('POST', '/pending/give-up-stuck', async (_req, reply) => {
    try {
      return reply.code(200).send(await giveUpStuck(configDir));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // Moves an event nobody retries any more to the dead-letter queue (nothing is deleted); the daemon does it when it is reachable, see above
  ctx.registerRoute('POST', '/pending/:id/give-up', async (req, reply) => {
    const { id } = req.params;
    try {
      return reply.code(200).send(await giveUpPending(configDir, id));
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

  // The navbar badge reads this route on every page: a failure is always a JSON { error } with what to do (502 when the relay runs but does not answer its status)
  ctx.registerRoute('GET', '/relay', async (_req, reply) => {
    try {
      return reply.code(200).send(await getRelayInfo(configDir));
    } catch (err) {
      return reply.code(err instanceof RelayStatusError ? 502 : 500).send({ error: getErrorMessage(err) });
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
      const entries = listDlq(configDir, project === undefined || project === '' ? undefined : assertProjectId(project));
      return reply.code(200).send({ entries });
    } catch (err) {
      return reply.code(err instanceof InvalidQueryError ? 400 : 500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/dlq/:id/replay', async (req, reply) => {
    const { id } = req.params;
    try {
      const answer = dlqReplayAnswer(await replayDlqEntry(configDir, id), id);
      return reply.code(answer.code).send(answer.body);
    } catch (err) {
      return reply.code(err instanceof DaemonUnreachableError ? 503 : 500).send({ error: getErrorMessage(err) });
    }
  });

  // The daemon clears the rows and emits queue.dlq.removed itself when it is reachable; otherwise the DLQ file is edited here and the response `message` says the event could not be sent
  ctx.registerRoute('POST', '/dlq/:id/clear', async (req, reply) => {
    const { id } = req.params;
    try {
      const answer = dlqClearAnswer(await clearDlqEntry(configDir, id), id);
      return reply.code(answer.code).send(answer.body);
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // The registered projects, for the project selector of the History and DLQ pages
  ctx.registerRoute('GET', '/projects', (_req, reply) => {
    try {
      return reply.code(200).send({ options: listProjectOptions(defaultRegistryDir(process.env)) });
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // The project a page is scoped to by ?project=<id>, for the contributors of the queue:project-header slot: found is false (never an error) for an id the page cannot use
  ctx.registerRoute('GET', '/project-scope', (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    try {
      return reply.code(200).send(getProjectScope(defaultRegistryDir(process.env), query['project']));
    } catch (err) {
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });

  // What the Queue module has about one project, for the detail page of the project module: 400 malformed id, 404 id in no registry (live or deleted), 500 unreadable registry or queue files
  ctx.registerRoute('GET', '/related/project/:projectId', (req, reply) => {
    const { projectId } = req.params;
    try {
      return reply.code(200).send(getRelatedForProject(configDir, defaultRegistryDir(process.env), projectId));
    } catch (err) {
      const status = err instanceof InvalidQueryError ? 400 : err instanceof UnknownProjectError ? 404 : 500;
      return reply.code(status).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('GET', '/subscribers', async (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};

    // Reject repeated cwd values
    const cwdValue = query['cwd'];
    if (Array.isArray(cwdValue)) {
      return reply.code(400).send({ error: `cwd must be given once, got ${cwdValue.length} values` });
    }
    // No cwd (or an empty one, as an unset ?cwd= of the page) means the working directory of this process; listSubscribers checks any other
    const cwd = cwdValue === '' ? undefined : cwdValue;

    // Reject repeated event values
    const eventValue = query['event'];
    if (Array.isArray(eventValue)) {
      return reply.code(400).send({ error: `event must be given once, got ${eventValue.length} values` });
    }
    const event = eventValue;

    try {
      return reply.code(200).send({ subscribers: listSubscribers(configDir, cwd, event, defaultRegistryDir(process.env)) });
    } catch (err) {
      return reply.code(err instanceof InvalidQueryError ? 400 : 500).send({ error: getErrorMessage(err) });
    }
  });

  ctx.registerRoute('POST', '/push', async (req, reply) => {
    const body = (req as { body: unknown }).body;

    // Validate body before try block
    if (!isRecord(body)) {
      return reply.code(400).send({
        error: `POST /push expects a JSON body { event: string, payload?: any, cwd?: string, project?: string, timeout?: number }; got: ${JSON.stringify(body)}`,
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
      const origin = originOf(body, cwd as string | undefined);
      const answer = withPushOrigin(
        pushAnswer(await pushEvent(configDir, event, payload, { cwd: origin.kind === 'process' ? undefined : origin.cwd, timeout: timeout as number | undefined })),
        origin,
      );
      return reply.code(answer.code).send(answer.body);
    } catch (err) {
      if (err instanceof DaemonUnreachableError) {
        return reply.code(503).send({ error: getErrorMessage(err) });
      }
      if (err instanceof UnknownProjectError) {
        return reply.code(404).send({ error: getErrorMessage(err) });
      }
      if (err instanceof InvalidQueryError) {
        return reply.code(400).send({ error: getErrorMessage(err) });
      }
      return reply.code(500).send({ error: getErrorMessage(err) });
    }
  });
}
