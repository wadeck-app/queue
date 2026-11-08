import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_PUSH_PAYLOAD_BYTES } from '@wadeck-app/queue-sdk/protocol';
import { createQueueService } from './QueueService.js';
import { Wal } from '../storage/Wal.js';
import { HistoryReader } from '../storage/HistoryReader.js';

// Push protocol 1.6.0: a push carries a payload (null is one) of at most 1 MiB. A refusal is a `rejected` answer that says why and records nothing.
let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-pushrules-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-pushrules-project-'));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const push = (body: Record<string, unknown>): ReturnType<ReturnType<typeof createQueueService>['commands']['push']> =>
  createQueueService(configDir).commands.push({ event: 'onThing', cwd: projectDir, ...body } as never);
const nothingRecorded = (): boolean => new Wal(join(configDir, 'wal.ndjson')).readAll().length === 0 && new HistoryReader(join(configDir, 'history')).read({ event: 'onThing' }).length === 0;

describe('a push without payload', () => {
  it('is rejected with a reason that says to send null for none, and nothing is recorded', async () => {
    const answer = await push({});
    expect(answer.status).toBe('rejected');
    expect(answer.reason).toContain("'payload'");
    expect(answer.reason).toContain('null');
    expect(answer.eventId).toBeUndefined();
    expect(nothingRecorded()).toBe(true);
  });

  it.each([null, 0, '', false, [], {}])('a payload of %j is a payload', async (payload) => {
    expect((await push({ payload })).status).toBe('queued');
  });

  it('a client of a future protocol gets the protocol refusal, not this one', async () => {
    const answer = await push({ protocol: '2.0.0' });
    expect(answer.status).toBe('rejected');
    expect(answer.supported).toBeDefined();
  });

  it('a before* event needs one too', async () => {
    expect((await push({ event: 'beforeThing' })).status).toBe('rejected');
  });
});

describe('the payload limit', () => {
  it('a payload of exactly the limit is accepted', async () => {
    expect((await push({ payload: 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES - 2) })).status).toBe('queued');
  });

  it('one byte more is rejected with the size, the limit and what to send instead; nothing is recorded', async () => {
    const answer = await push({ payload: 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES - 1) });
    expect(answer.status).toBe('rejected');
    expect(answer.reason).toContain(String(MAX_PUSH_PAYLOAD_BYTES + 1));
    expect(answer.reason).toContain('1 MiB');
    expect(answer.reason).toContain('reference');
    expect(answer.reason).toContain('not recorded');
    expect(nothingRecorded()).toBe(true);
    expect(existsSync(join(configDir, 'history'))).toBe(false);
  });

  it('counts bytes, not characters', async () => {
    expect((await push({ payload: '\u20ac'.repeat(Math.ceil(MAX_PUSH_PAYLOAD_BYTES / 3)) })).status).toBe('rejected');
  });

  it('applies to a before* event as well', async () => {
    expect((await push({ event: 'beforeThing', payload: 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES) })).status).toBe('rejected');
  });
});
