import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addProject } from '@wadeck-app/project-sdk';
import { createQueueService } from './QueueService.js';

// The recorded wire contract of push protocol 1.x (packages/queue-sdk/contract/protocol-1.json), replayed against the real
// service. The SDK replays the same file against its own parser (packages/queue-sdk/src/contract.test.ts): a contract change
// has to change the fixture, which makes it visible in review.

interface ContractCase {
  name: string;
  request: Record<string, unknown>;
  response: { status: string; supported?: string; eventId: 'present' | 'absent' };
}

const fixture = join(dirname(fileURLToPath(import.meta.url)), '../../../queue-sdk/contract/protocol-1.json');
const cases = JSON.parse(readFileSync(fixture, 'utf8')) as ContractCase[];

let configDir: string;
let projectDir: string;
let registryDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'queue-contract-config-'));
  projectDir = mkdtempSync(join(tmpdir(), 'queue-contract-project-'));
  registryDir = mkdtempSync(join(tmpdir(), 'queue-contract-registry-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('push protocol 1.x contract (recorded)', () => {
  it('has recorded cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
  });

  it.each(cases.map((contractCase) => [contractCase.name, contractCase] as const))('%s', async (_name, contractCase) => {
    // a registry with one project, which the fixture names with a placeholder (an id is generated at registration)
    const registered = await addProject(registryDir, { name: 'contract', path: projectDir });
    const virtual = await addProject(registryDir, { name: 'contract-virtual' });
    const named = contractCase.request['project'];
    const request = named === '<registered-project>' ? { ...contractCase.request, project: registered.id } : named === '<virtual-project>' ? { ...contractCase.request, project: virtual.id } : contractCase.request;
    // a case may send no working directory: a project without folder, or nothing at all ("cwd": "<none>")
    const sendsNoCwd = named === '<virtual-project>' || request['cwd'] === '<none>';
    const { cwd: _marker, ...rest } = request;
    const service = createQueueService(configDir, { registryDir });
    const answer = await service.commands.push({ ...rest, ...(!sendsNoCwd && { cwd: projectDir }) } as never);

    expect(answer.status).toBe(contractCase.response.status);
    expect(answer.supported).toBe(contractCase.response.supported);
    expect(answer.eventId !== undefined ? 'present' : 'absent').toBe(contractCase.response.eventId);
  });
});
