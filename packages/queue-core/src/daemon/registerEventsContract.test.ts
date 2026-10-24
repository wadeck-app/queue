import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createQueueService } from './QueueService.js';

// The recorded wire contract of `register-events` (protocol 1.1.0: packages/queue-sdk/contract/register-events-1.1.json), replayed
// against the real service. The SDK replays the same file against its own parser (packages/queue-sdk/src/contract.test.ts).

interface ContractCase {
  name: string;
  request: Record<string, unknown>;
  response: { status: string; count?: number; supported?: string; problemPaths?: string[] };
}

const cases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../queue-sdk/contract/register-events-1.1.json'), 'utf8')) as ContractCase[];

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-register-contract-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('register-events contract (protocol 1.1.0, recorded)', () => {
  it('has recorded cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
  });

  it.each(cases.map((contractCase) => [contractCase.name, contractCase] as const))('%s', async (_name, contractCase) => {
    const answer = await createQueueService(configDir).commands['register-events'](contractCase.request);
    expect(answer.status).toBe(contractCase.response.status);
    expect(answer.count).toBe(contractCase.response.count);
    expect(answer.supported).toBe(contractCase.response.supported);
    expect(answer.problems?.map((problem) => problem.path)).toEqual(contractCase.response.problemPaths);
  });
});
