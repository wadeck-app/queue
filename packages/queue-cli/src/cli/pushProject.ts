import { extractProjectOption, loadRegistry, NoProjectInScopeError, ProjectOptionError, requirePath, resolveProjectFromArgs, resolveReference } from '@wadeck-app/project-sdk';
import { getErrorMessage } from '@wadeck-app/queue-core';
import { checkPushDirection, PUSH_DIRECTIONS } from '@wadeck-app/queue-sdk/protocol';
import type { PushDirection } from '@wadeck-app/queue-sdk/protocol';

/** The environment variable that names the project of a push when no flag does. */
const PROJECT_ENV = 'QUEUE_PROJECT';

/**
 * `--project <ref>`, `-p <ref>` or `--project=<ref>` out of the arguments of a command, read by the project-sdk (extractProjectOption): the one
 * parser every CLI shares. `args` is what is left; `error` for a flag without value or given twice (nothing is guessed). Nothing after `--` is read.
 * `env`: the process environment, for a command that also honours QUEUE_PROJECT (push); a read command passes none and filters on the flag only.
 */
export function parseProjectFlag(args: string[], env: NodeJS.ProcessEnv = {}): { value?: string; env?: string; args: string[]; error?: string } {
  try {
    const option = extractProjectOption(args, env, PROJECT_ENV);
    return { args: option.args, ...(option.flag !== undefined && { value: option.flag }), ...(option.env !== undefined && { env: option.env }) };
  } catch (err) {
    if (err instanceof ProjectOptionError) {
      return { args, error: getErrorMessage(err) };
    }
    throw err;
  }
}

/** `--direction to-parents|to-children` (repeatable) out of the arguments of `queue push`; `error` for a missing or unknown value. */
export function parseDirectionFlag(args: string[]): { value?: PushDirection[]; error?: string } {
  const given: string[] = [];
  for (let at = args.indexOf('--direction'); at !== -1; at = args.indexOf('--direction', at + 1)) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith('-')) {
      return { error: `--direction needs a value: ${PUSH_DIRECTIONS.join(' or ')} (repeat the flag to give both).` };
    }
    given.push(value);
  }
  if (given.length === 0) {
    return {};
  }
  const checked = checkPushDirection(given);
  return checked.ok ? { value: checked.directions } : { error: `--direction: ${checked.reason}` };
}

export type PushProject = { ok: true; project?: string; cwd?: string } | { ok: false; message: string };

/**
 * The project a push names explicitly: `--project` among the arguments (`argv`), else QUEUE_PROJECT. Neither: nothing is named and the daemon derives the project from
 * the working directory. A named project is resolved here, with the project-sdk (name, alias or id), and the push carries its id plus the
 * registered path that contains the caller's directory, else its main path; one that cannot be resolved stops the push with the reason.
 */
export function resolvePushProject(input: { argv: string[]; cwd: string; registryDir: string; env: NodeJS.ProcessEnv }): PushProject {
  const option = parseProjectFlag(input.argv, input.env);
  if (option.error !== undefined) {
    return { ok: false, message: option.error };
  }
  if (option.value === undefined && option.env === undefined) {
    return { ok: true };
  }
  try {
    const { scope } = resolveProjectFromArgs(loadRegistry(input.registryDir), input.argv, input.env, PROJECT_ENV, input.cwd);
    // A virtual project has no folder: the event carries the project alone
    return { ok: true, project: scope.project.id, ...(scope.project.paths.length > 0 && { cwd: requirePath(scope) }) };
  } catch (err) {
    if (err instanceof NoProjectInScopeError) {
      return { ok: false, message: `${getErrorMessage(err)}\n${err.hint}` };
    }
    // which of the two gave the reference that does not resolve
    const from = option.value !== undefined ? `--project "${option.value}"` : `${PROJECT_ENV}="${option.env}"`;
    return { ok: false, message: `${from}: ${getErrorMessage(err)}` };
  }
}

/** The id of the project a read command (--project of history, dlq, status) filters on: a name, an alias or an id, resolved with the project-sdk. */
export function resolveProjectId(ref: string, registryDir: string): { ok: true; id: string } | { ok: false; message: string } {
  try {
    return { ok: true, id: resolveReference(loadRegistry(registryDir), ref).id };
  } catch (err) {
    return { ok: false, message: `--project "${ref}": ${getErrorMessage(err)}` };
  }
}

/** The entries (WAL, DLQ) of one project, by the id their meta carries; all of them without a project. */
export function onlyProject<T extends { meta: { projectId?: string } }>(entries: T[], projectId: string | undefined): T[] {
  return projectId === undefined ? entries : entries.filter((entry) => entry.meta.projectId === projectId);
}
