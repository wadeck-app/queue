import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliTransport, MAX_CLI_OUTPUT_HEAD_BYTES, MAX_CLI_OUTPUT_TAIL_BYTES } from './CliTransport.js';
import type { EventEnvelope } from '../types.js';

const NODE = process.execPath;

let workDir: string;
let noisy: string;

// Writes 20 MiB to the stream named by argv[2], first line START, last line END, and exits 0
const NOISY_SOURCE = `
const stream = process.argv[2] === 'stderr' ? process.stderr : process.stdout;
const line = 'x'.repeat(1023) + '\\n';
stream.write('START\\n');
let left = 20 * 1024;
const next = () => {
  while (left > 0) {
    left--;
    if (!stream.write(line)) { stream.once('drain', next); return; }
  }
  stream.write('END\\n');
};
next();
`;

const envelope = (): EventEnvelope => ({ id: 'evt-1', timestamp: '2026-01-01T00:00:00.000Z', event: 'onTest', payload: {}, meta: { cwd: workDir } });

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'queue-clioutput-'));
  noisy = join(workDir, 'noisy.js');
  writeFileSync(noisy, NOISY_SOURCE);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10 });
});

describe('CliTransport - the output kept in memory is capped', () => {
  it.each(['stdout', 'stderr'] as const)('a program that writes 20 MiB on %s keeps its start and its end, and says what was dropped', async (stream) => {
    const result = await new CliTransport().dispatch(`"${NODE}" "${noisy}" ${stream}`, envelope(), 60_000, workDir, undefined, 'noisy');
    expect(result.success).toBe(true);
    const text = (stream === 'stdout' ? result.stdout : result.stderr) ?? '';
    expect(text.length).toBeLessThanOrEqual(MAX_CLI_OUTPUT_HEAD_BYTES + MAX_CLI_OUTPUT_TAIL_BYTES + 1_000);
    expect(text.startsWith('START\n')).toBe(true);
    expect(text.endsWith('END\n')).toBe(true);
    expect(text).toMatch(/\[output truncated: \d+ bytes dropped, kept the first \d+ and the last \d+ bytes\]/);
  });

  it('keeps small output as it is, with no marker', async () => {
    const result = await new CliTransport().dispatch(`"${NODE}" -e "process.stdout.write('hello')"`, envelope(), 60_000, workDir, undefined, 'small');
    expect(result.stdout).toBe('hello');
  });
});
