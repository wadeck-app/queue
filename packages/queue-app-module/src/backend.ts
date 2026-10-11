import type { ModuleContext } from './moduleContext.js';
import { getQueueConfigDir } from './configDir.js';
import { getStatus } from './status.js';
import { listHistory, getHistoryEntry } from './history.js';
import { replayEvent } from './replay.js';
import { listDlq, replayDlqEntry, clearDlqEntry } from './dlq.js';
import { listSubscribers } from './subscribers.js';
import { pushEvent } from './push.js';

interface QueryParams { [key: string]: string | undefined }

/**
 * backendEntryPath target declared in manifest.json. app-core calls this once at module
 * load with moduleContext, per the registration contract confirmed with app-core-owner
 * (2026-10-11): routes become /api/modules/queue/<subPath>, auto-removed on unload.
 */
export default function (ctx: ModuleContext): void {
  const configDir = getQueueConfigDir();

  ctx.registerRoute('GET', '/status', async (_req, reply) => {
    return reply.code(200).send(await getStatus(configDir));
  });

  ctx.registerRoute('GET', '/history', (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    const entries = listHistory(configDir, {
      event: query['event'],
      subscriberId: query['subscriberId'],
      status: query['status'] as 'success' | 'failed' | 'dlq' | 'filtered' | undefined,
      sinceMs: query['sinceMs'] ? Number(query['sinceMs']) : undefined,
    });
    return reply.code(200).send({ entries });
  });

  ctx.registerRoute('GET', '/history/:eventId', (req, reply) => {
    const { eventId } = (req as { params: { eventId: string } }).params;
    const entry = getHistoryEntry(configDir, eventId);
    if (!entry) return reply.code(404).send({ error: `No history entry for eventId ${eventId}` });
    return reply.code(200).send(entry);
  });

  ctx.registerRoute('POST', '/history/:eventId/replay', async (req, reply) => {
    const { eventId } = (req as { params: { eventId: string } }).params;
    try {
      return reply.code(200).send(await replayEvent(configDir, eventId));
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  ctx.registerRoute('GET', '/dlq', async (_req, reply) => {
    try {
      return reply.code(200).send({ entries: await listDlq(configDir) });
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  ctx.registerRoute('POST', '/dlq/:id/replay', async (req, reply) => {
    const { id } = (req as { params: { id: string } }).params;
    try {
      return reply.code(200).send(await replayDlqEntry(configDir, id));
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  ctx.registerRoute('POST', '/dlq/:id/clear', async (req, reply) => {
    const { id } = (req as { params: { id: string } }).params;
    try {
      return reply.code(200).send(await clearDlqEntry(configDir, id));
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  ctx.registerRoute('GET', '/subscribers', async (req, reply) => {
    const query = (req as { query?: QueryParams }).query ?? {};
    const cwd = query['cwd'] ?? process.cwd();
    try {
      return reply.code(200).send({ subscribers: await listSubscribers(configDir, cwd, query['event']) });
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  ctx.registerRoute('POST', '/push', async (req, reply) => {
    const body = (req as { body: { event: string; payload: unknown; cwd?: string; timeout?: number } }).body;
    try {
      return reply.code(200).send(await pushEvent(configDir, body.event, body.payload, { cwd: body.cwd, timeout: body.timeout }));
    } catch (err) {
      return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
