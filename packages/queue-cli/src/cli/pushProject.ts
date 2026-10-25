import { loadRegistry, requirePath, resolveScope, NoProjectInScopeError } from '@wadeck-app/project-sdk';
import { getErrorMessage } from '@wadeck-app/queue-core';

/** `--project <ref>` / `-p <ref>` out of the arguments of a command; `error` when the flag has no value. */
export function parseProjectFlag(args: string[]): { value?: string; error?: string } {
  for (const flag of ['--project', '-p']) {
    const at = args.indexOf(flag);
    if (at === -1) {
      continue;
    }
    const value = args[at + 1];
    if (value === undefined || value.startsWith('-')) {
      return { error: `${flag} needs a value: the name, an alias or the id of a project (project list shows them).` };
    }
    return { value };
  }
  return {};
}

export type PushProject = { ok: true; project?: string; cwd?: string } | { ok: false; message: string };

/**
 * The project a push names explicitly: `--project`, else QUEUE_PROJECT. Neither: nothing is named and the daemon derives the project from
 * the working directory. A named project is resolved here, with the project-sdk (name, alias or id), and the push carries its id plus the
 * registered path that contains the caller's directory, else its main path; one that cannot be resolved stops the push with the reason.
 */
export function resolvePushProject(input: { flag?: string; cwd: string; registryDir: string; env: NodeJS.ProcessEnv }): PushProject {
  const fromEnv = input.env['QUEUE_PROJECT'];
  const named = input.flag !== undefined || (fromEnv !== undefined && fromEnv.trim() !== '');
  if (!named) {
    return { ok: true };
  }
  try {
    const scope = resolveScope(loadRegistry(input.registryDir), {
      ...(input.flag !== undefined && { flag: input.flag }),
      ...(fromEnv !== undefined && { env: fromEnv }),
      envName: 'QUEUE_PROJECT',
      cwd: input.cwd,
    });
    return { ok: true, project: scope.project.id, cwd: requirePath(scope) };
  } catch (err) {
    if (err instanceof NoProjectInScopeError) {
      return { ok: false, message: `${getErrorMessage(err)}\n${err.hint}` };
    }
    // which of the two gave the reference that does not resolve
    const from = input.flag !== undefined ? `--project "${input.flag}"` : `QUEUE_PROJECT="${fromEnv}"`;
    return { ok: false, message: `${from}: ${getErrorMessage(err)}` };
  }
}
