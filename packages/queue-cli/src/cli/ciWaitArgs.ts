import { waiterNameProblem } from '@wadeck-app/queue-core';
import { scanFlags, type FlagSpec } from './flagScan.js';

const CI_FLAG_SPEC: FlagSpec = {
  values: ['--repo', '--workflow', '--timeout', '--settle', '--name'],
  repeatable: ['--workflow'],
  switches: ['--json', '--no-infer', '--help', '-h'],
  needs: {
    '--repo': 'a repository, e.g. --repo owner/name',
    '--workflow': 'a workflow name, e.g. --workflow "CI" (repeatable)',
    '--timeout': 'a duration, e.g. --timeout 5m (30s, 5m, 1h)',
    '--settle': 'a duration, e.g. --settle 20s',
    '--name': 'a name like <who>.<what>, e.g. --name w-agent-wake.ab12cd34',
  },
};

export interface CiWaitArgs {
  ok: true;
  sha?: string;
  repo?: string;
  workflows: string[];
  timeout?: string;
  settle?: string;
  /** `--name <who>.<what>`: how this wait is listed and counted by `queue push`. */
  name?: string;
  json: boolean;
  noInfer: boolean;
}

/**
 * The arguments after `queue wait ci`. A value flag without its value (or with an empty one), in the `--flag=value` form or given twice is an error:
 * each used to fall back to the default (30 minutes, the inferred repository...) without a word. An option nobody knows is an error too, with the closest valid option.
 */
export function parseCiWaitArgs(args: readonly string[]): CiWaitArgs | { ok: false; message: string } {
  for (const arg of args) {
    const joined = CI_FLAG_SPEC.values.find((flag) => arg.startsWith(`${flag}=`));
    if (joined !== undefined) {
      return { ok: false, message: `${arg} is not supported: write the flag and its value apart, ${joined} ${arg.slice(joined.length + 1)}` };
    }
  }
  const scan = scanFlags(args, CI_FLAG_SPEC, 'queue wait ci', [], 1);
  const blocking = scan.issues[0];
  if (blocking !== undefined) {
    return { ok: false, message: blocking.message };
  }
  const single = (flag: string): string | undefined => scan.values.get(flag)?.[0];
  const sha = scan.positionals[0];
  const repo = single('--repo');
  const timeout = single('--timeout');
  const settle = single('--settle');
  const name = single('--name');
  if (name !== undefined) {
    const nameProblem = waiterNameProblem(name);
    if (nameProblem !== undefined) {
      return { ok: false, message: nameProblem };
    }
  }
  return {
    ok: true,
    ...(sha !== undefined && { sha }),
    ...(repo !== undefined && { repo }),
    workflows: scan.values.get('--workflow') ?? [],
    ...(timeout !== undefined && { timeout }),
    ...(settle !== undefined && { settle }),
    ...(name !== undefined && { name }),
    json: scan.switches.has('--json'),
    noInfer: scan.switches.has('--no-infer'),
  };
}
