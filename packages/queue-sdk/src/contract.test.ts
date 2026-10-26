import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePushAnswer, parseRegisterAnswer, serializePushRequest, serializeRegisterRequest, type RegisterRequest } from './wire.js';

// The recorded wire contract of push protocol 1.x (contract/protocol-1.json). queue-core replays the same file against the real
// service (packages/queue-core/src/daemon/pushContract.test.ts); here it must be something the SDK can send and read.

interface ContractCase {
  name: string;
  request: { event: string; payload: unknown; protocol?: string; project?: string; cwd?: string };
  response: { status: string; supported?: string; eventId: 'present' | 'absent' };
}

const cases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../contract/protocol-1.json'), 'utf8')) as ContractCase[];

describe('push protocol 1.x contract (recorded)', () => {
  it.each(cases.map((contractCase) => [contractCase.name, contractCase] as const))('the SDK can send and read: %s', (_name, contractCase) => {
    // the placeholder stands for the id of a project the harness of the daemon registers
    const isPlaceholder = contractCase.request.project === '<registered-project>' || contractCase.request.project === '<virtual-project>';
    const project = isPlaceholder ? '64f4ae91' : contractCase.request.project;
    // a case may send no working directory (a project without folder, or nothing at all)
    const sendsNoCwd = contractCase.request.project === '<virtual-project>' || contractCase.request.cwd === '<none>';
    const { cwd: _marker, ...rest } = contractCase.request;
    const serialized = serializePushRequest({ ...rest, ...(project !== undefined && { project }), ...(!sendsNoCwd && { cwd: '/project' }) });
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

// Protocol 1.1.0 (contract/register-events-1.1.json), replayed by queue-core against the real service in
// registerEventsContract.test.ts.

interface RegisterContractCase {
  name: string;
  request: RegisterRequest;
  response: { status: string; count?: number; supported?: string; problemPaths?: string[] };
}

const registerCases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../contract/register-events-1.1.json'), 'utf8')) as RegisterContractCase[];

describe('register-events 1.1 contract (recorded)', () => {
  it('has recorded cases', () => {
    expect(registerCases.length).toBeGreaterThanOrEqual(4);
  });

  it.each(registerCases.map((contractCase) => [contractCase.name, contractCase] as const))('the SDK can send and read: %s', (_name, contractCase) => {
    const serialized = serializeRegisterRequest(contractCase.request);
    expect(serialized.ok).toBe(true);
    if (serialized.ok) {
      expect(JSON.parse(serialized.body)).toEqual(contractCase.request);
    }

    const answer = parseRegisterAnswer({
      ok: true,
      result: {
        status: contractCase.response.status,
        ...(contractCase.response.count !== undefined && { count: contractCase.response.count }),
        ...(contractCase.response.supported !== undefined && { supported: contractCase.response.supported }),
        ...(contractCase.response.problemPaths !== undefined && { problems: contractCase.response.problemPaths.map((path) => ({ path, message: 'm' })) }),
      },
    });
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(answer.response.status).toBe(contractCase.response.status);
      expect(answer.response.count).toBe(contractCase.response.count);
      expect(answer.response.supported).toBe(contractCase.response.supported);
      expect(answer.response.problems?.map((problem) => problem.path)).toEqual(contractCase.response.problemPaths);
    }
  });
});
