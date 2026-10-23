import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePushAnswer, serializePushRequest } from './wire.js';

// The recorded wire contract of push protocol 1.x (contract/protocol-1.json). queue-core replays the same file against the real
// service (packages/queue-core/src/daemon/pushContract.test.ts); here it must be something the SDK can send and read.

interface ContractCase {
  name: string;
  request: { event: string; payload: unknown; protocol?: string };
  response: { status: string; supported?: string; eventId: 'present' | 'absent' };
}

const cases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../contract/protocol-1.json'), 'utf8')) as ContractCase[];

describe('push protocol 1.x contract (recorded)', () => {
  it.each(cases.map((contractCase) => [contractCase.name, contractCase] as const))('the SDK can send and read: %s', (_name, contractCase) => {
    const serialized = serializePushRequest({ ...contractCase.request, cwd: '/project' });
    expect(serialized.ok).toBe(true);

    const answer = parsePushAnswer({
      ok: true,
      result: {
        status: contractCase.response.status,
        ...(contractCase.response.supported !== undefined && { supported: contractCase.response.supported }),
        ...(contractCase.response.eventId === 'present' && { eventId: 'e-1' }),
      },
    });
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.response.status).toBe(contractCase.response.status);
      expect(answer.response.supported).toBe(contractCase.response.supported);
    }
  });
});
