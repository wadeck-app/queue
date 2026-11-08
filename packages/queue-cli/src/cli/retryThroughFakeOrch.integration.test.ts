/**
 * A real daemon (the bundled CLI, a throwaway environment) whose subscriber fails with tries left schedules its retry with `orch add --once <id> --delay <d> --command "queue retry --event <walId>"`
 * (guiding-principles: "Retries are orch jobs"). The orch it reaches is the fake first on the PATH of the isolated environment (createIsolatedCliEnv): the recorded
 * arguments are what was asked of the orchestrator, and the real one of the machine is never involved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Wal } from '@wadeck-app/queue-core';
import { createIsolatedCliEnv, type IsolatedCliEnv } from '../testing/isolatedCliEnv.js';
import { runQueueCli } from '../testing/runCli.js';
import { waitFor, waitForPortFree } from '../testWaitFor.js';

let iso: IsolatedCliEnv | undefined;

afterEach(async () => {
  if (iso !== undefined) {
    runQueueCli(iso.env, ['stop'], { cwd: iso.root });
    await waitForPortFree(iso.daemonPort);
    iso.cleanup();
    iso = undefined;
  }
});

describe('the retry of a failed delivery goes through the orch of the environment', () => {
  it('schedules one job: add --once queue-retry-<walId>-<attempts>-<suffix> --delay <minutes>m --command "queue retry --event <walId>"', async () => {
    iso = createIsolatedCliEnv();
    const work = join(iso.root, 'work');
    mkdirSync(work, { recursive: true });
    // The guard of the subscribers refuses `node -e`: a script file
    writeFileSync(join(work, 'fail.cjs'), 'process.exit(3);\n');
    writeFileSync(join(iso.configDir, 'subscribers.yml'), ['subscribers:', '  demo.retry:', '    - type: cli', '      name: failing', `      command: ${JSON.stringify(`"${process.execPath}" "${join(work, 'fail.cjs')}"`)}`, '      retries: 3', ''].join('\n'));

    const pushed = runQueueCli(iso.env, ['push', 'demo.retry', '{"n":1}'], { cwd: work });
    expect(pushed.exitCode, `queue push failed: ${pushed.stderr}`).toBe(0);

    const orch = iso.orch;
    const calls = await waitFor(() => (orch.readCalls().length >= 1 ? orch.readCalls() : undefined), `the daemon to ask orch for the retry (orch calls file ${orch.callsFile})`);

    expect(calls).toHaveLength(1);
    const walId = new Wal(join(iso.configDir, 'wal.ndjson')).readAll()[0]!.id;
    const argv = calls[0]!.argv;
    expect(argv.slice(0, 2)).toEqual(['add', '--once']);
    expect(argv[2]).toMatch(new RegExp(`^queue-retry-${walId}-1-[0-9a-f]{8}$`));
    expect(argv[3]).toBe('--delay');
    expect(argv[4]).toMatch(/^\d+m$/);
    expect(argv.slice(5)).toEqual(['--command', `queue retry --event ${walId}`]);
  });
});
