// Test helper: a fake `orch` first on the PATH of an isolated environment, so a spawned bundle or daemon can never reach the real orchestrator of whoever runs
// the tests (RetryScheduler looks `orch` up on the PATH and would schedule a REAL job). It records the arguments it was given, one JSON line per call, and exits 0.
//
//  - POSIX: `orch` is a shell script that runs the recorder with node.
//  - Windows: `where orch` + execFile only run a real executable (a .cmd shim fails with EINVAL, an extensionless script with ENOENT), so `orch.exe` is a hard link
//    (a copy when the volumes differ) of node.exe, and the recorder is preloaded through NODE_OPTIONS: it acts only when the process is named orch, so every
//    other node process of the environment is untouched.
import { chmodSync, copyFileSync, linkSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

export interface OrchCall {
  /** What orch was given after its name: `["add", "--once", "<id>", "--delay", "2m", "--command", "queue retry --event <walId>"]`. */
  argv: string[];
}

export interface FakeOrch {
  /** The folder put first on the PATH. */
  binDir: string;
  /** One JSON line per call. */
  callsFile: string;
  /** Environment entries to merge into the environment of the spawned processes. */
  env: Record<string, string>;
  /** The calls recorded so far, oldest first. */
  readCalls(): OrchCall[];
}

const RECORDER = (callsFile: string): string => `'use strict';
// Recorder of the fake orch (see fakeOrch.ts). Only the process named orch records; any other node process that preloads this file does nothing.
const path = require('node:path');
const isOrch = process.platform !== 'win32' || /^orch(\\.exe)?$/i.test(path.basename(process.execPath));
if (isOrch) {
  // On Windows node took the first word ("add") for the script to run and resolved it to a path: its name is the word the caller wrote
  const argv = process.platform === 'win32' ? [path.basename(process.argv[1]), ...process.argv.slice(2)] : process.argv.slice(2);
  require('node:fs').appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv }) + '\\n');
  process.exit(0);
}
`;

/** `path` of the PATH variable as this environment spells it (Windows: usually "Path"). */
export function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

/**
 * Creates the fake under `root` and returns the entries to add to `env` (PATH first, and on Windows NODE_OPTIONS). Throws, with the cause, when it cannot be created:
 * an environment without the fake would let a test reach the real orch.
 */
export function installFakeOrch(root: string, env: NodeJS.ProcessEnv): FakeOrch {
  const binDir = join(root, 'fake-bin');
  const callsFile = join(root, 'orch-calls.ndjson');
  const recorder = join(binDir, 'orch-recorder.cjs');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(callsFile, '');
  writeFileSync(recorder, RECORDER(callsFile));

  const pathKey = pathKeyOf(env);
  const entries: Record<string, string> = { [pathKey]: `${binDir}${delimiter}${env[pathKey] ?? ''}` };
  if (process.platform === 'win32') {
    const exe = join(binDir, 'orch.exe');
    try {
      linkSync(process.execPath, exe);
    } catch {
      // another volume, or no right to link: a copy costs the size of node.exe once per environment
      copyFileSync(process.execPath, exe);
    }
    const preload = `--require=${recorder.replace(/\\/g, '/')}`;
    entries['NODE_OPTIONS'] = [env['NODE_OPTIONS'], preload].filter(Boolean).join(' ');
  } else {
    const script = join(binDir, 'orch');
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`);
    chmodSync(script, 0o755);
  }
  return {
    binDir,
    callsFile,
    env: entries,
    readCalls: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as OrchCall) : []),
  };
}

/** The name the fake answers to on this platform, for messages. */
export const FAKE_ORCH_FILE = process.platform === 'win32' ? 'orch.exe' : basename('orch');
