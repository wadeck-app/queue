import { spawn, type ChildProcess } from 'node:child_process';
import { extname } from 'node:path';
import type { EventEnvelope } from '../types.js';
import type { ResolveRef } from '../walkPayloadPath.js';
import { EventRefError } from './refResolver.js';
import { getErrorMessage } from '../errors.js';
import { CommandTemplateError, findCmdMetacharacter, hasPlaceholders, substituteToken, tokenizeTemplate } from './commandTemplate.js';
import type { DispatchResult } from './DispatchResult.js';
import { resolveNpmShim } from './NpmShim.js';
import { describeSearchPath, envValue, findWindowsProgram } from './windowsProgram.js';

type SpawnOptions = Parameters<typeof spawn>[2];

/** How a command with placeholders is started: the program and its arguments, never through a shell the payload could reach. */
interface DirectLaunch {
  file: string;
  args: string[];
  options: SpawnOptions;
}

/** cmd.exe line for a .cmd/.bat target: `"file" "arg" ...`, every argument double-quoted (the values were checked to hold no quote). */
function quoteForCmd(arg: string): string {
  // Backslashes in front of an inner quote are doubled and the quote escaped; a run before the closing quote is doubled too, or it would escape that quote
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Plans the start of a command that holds `{{ }}` placeholders. Throws CommandTemplateError (a permanent failure) when it cannot be run safely.
 * `subscriber` only labels the errors. `resolveRef` follows the payload references the daemon allows (dispatch/refResolver.ts); absent, none is followed.
 */
function planDirectLaunch(command: string, envelope: EventEnvelope, cwd: string | undefined, env: NodeJS.ProcessEnv | undefined, subscriber: string, baseOptions: SpawnOptions, resolveRef?: ResolveRef): DirectLaunch {
  const label = `subscriber '${subscriber}'`;
  const tokens = tokenizeTemplate(command);
  const programToken = tokens[0];
  if (programToken === undefined || programToken.some((part) => part.kind === 'field')) {
    throw new CommandTemplateError(
      `${label}: the first word of the command must be a literal program name, not empty and not a {{ }} placeholder. Fix: edit the command in subscribers.yml.`
    );
  }
  const program = programToken.map((part) => (part.kind === 'literal' ? part.text : '')).join('');
  let substituted: ReturnType<typeof substituteToken>[];
  try {
    substituted = tokens.slice(1).map((token) => substituteToken(token, envelope.payload, resolveRef === undefined ? {} : { resolveRef }));
  } catch (err) {
    // The label first: which subscriber, then the field and the reference
    if (err instanceof CommandTemplateError) {
      throw new CommandTemplateError(`${label}: ${err.message}`);
    }
    if (err instanceof EventRefError) {
      throw err.withContext(label);
    }
    throw err;
  }

  for (const argument of substituted) {
    for (const { field, value } of argument.fields) {
      if (value.includes('\0')) {
        throw new CommandTemplateError(
          `${label}: payload field '${field}' of event '${envelope.event}' contains a NUL character, which no program can receive as an argument. ` +
          `Fix: send a payload without NUL characters.`
        );
      }
    }
  }
  const args = substituted.map((argument) => argument.text);
  const effectiveEnv = env ?? process.env;

  if (process.platform !== 'win32') {
    return { file: program, args, options: baseOptions };
  }

  const found = findWindowsProgram(program, cwd, effectiveEnv);
  if (found === undefined) {
    throw new CommandTemplateError(
      `${label}: program '${program}' was not found (searched the working directory and the PATH of the queue daemon with the extensions of PATHEXT; ${describeSearchPath(effectiveEnv, 8)}). ` +
      `The daemon keeps the PATH it was started with. Fix: install it, put it on PATH, or give its full path in the command; if it works in your shell, restart the daemon from that shell ("queue stop", the next push starts it again).`
    );
  }
  const extension = extname(found).toLowerCase();
  if (extension === '.exe' || extension === '.com') {
    return { file: found, args, options: baseOptions };
  }
  if (extension !== '.cmd' && extension !== '.bat') {
    throw new CommandTemplateError(
      `${label}: '${found}' is a ${extension} file, which cannot be started without a shell. ` +
      `Fix: start it through its interpreter (e.g. node script.js {{ field }}), or point the command at an .exe, .cmd or .bat.`
    );
  }

  // An npm-generated shim only starts node on a script: run that directly, no shell, so every value stays one inert argument
  const shim = resolveNpmShim(found, effectiveEnv);
  if (shim !== undefined) {
    return { file: shim.nodeExe, args: [shim.script, ...args], options: baseOptions };
  }

  // Any other batch file can only run through cmd.exe, which interprets metacharacters: refuse any value that holds one
  for (const argument of substituted) {
    for (const { field, value } of argument.fields) {
      const offending = findCmdMetacharacter(value);
      if (offending !== undefined) {
        const shown = offending.char === '\r' || offending.char === '\n' ? offending.name : `'${offending.char}' (${offending.name})`;
        throw new CommandTemplateError(
          `${label}: payload field '${field}' of event '${envelope.event}' contains ${shown}, which cmd.exe would run as code, and '${program}' resolves to ${found}, ` +
          `a batch file that Windows can only start through cmd.exe (npm shims are run directly, but this file is not a recognised npm shim). The delivery is refused and not retried. ` +
          `Fix: make the command start a real program (an .exe, or node/your interpreter with a script) instead of a .cmd/.bat, ` +
          `or read the event envelope on stdin, or stop sending these characters in '${field}'.`
        );
      }
    }
  }
  const line = [found, ...args].map(quoteForCmd).join(' ');
  return {
    file: envValue(process.env, 'ComSpec') ?? 'cmd.exe',
    // /s strips the outer pair of quotes and keeps the inner ones as written; /d skips AutoRun
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { ...baseOptions, windowsVerbatimArguments: true },
  };
}

export class CliTransport {
  /**
   * Runs a `cli` subscriber command and feeds the event envelope to its stdin.
   * Without `{{ }}` the command goes to a shell as written (it comes from the trusted subscribers.yml). With `{{ }}` it is split into arguments first and
   * started without a shell, so payload values stay data (docs/subscribers.md). `subscriber` only labels the errors. `resolveRef` is the callback of this
   * dispatch that follows the payload references the daemon allows; only the placeholders of the command use it (never stdin, which is the envelope as it is).
   */
  async dispatch(command: string, envelope: EventEnvelope, timeoutMs: number, cwd?: string, env?: Record<string, string>, subscriber = 'unknown', resolveRef?: ResolveRef): Promise<DispatchResult> {
    const start = Date.now();
    const spawnEnv = env ? { ...process.env, ...env } : undefined;
    const baseOptions: SpawnOptions = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd, env: spawnEnv };

    let launch: () => ChildProcess;
    if (hasPlaceholders(command)) {
      let plan: DirectLaunch;
      try {
        plan = planDirectLaunch(command, envelope, cwd, spawnEnv, subscriber, baseOptions, resolveRef);
      } catch (err) {
        if (err instanceof CommandTemplateError) {
          return { success: false, error: err.message, permanent: true, durationMs: Date.now() - start };
        }
        // The history could not be read right now: a retry can work
        if (err instanceof EventRefError) {
          return { success: false, error: err.message, durationMs: Date.now() - start };
        }
        throw err;
      }
      launch = () => spawn(plan.file, plan.args, { ...plan.options, shell: false });
    } else {
      launch = () => spawn(command, [], { ...baseOptions, shell: true });
    }

    return new Promise<DispatchResult>((resolvePromise) => {
      let child: ChildProcess;
      try {
        child = launch();
      } catch (err) {
        resolvePromise({ success: false, error: `could not start the command of subscriber '${subscriber}': ${getErrorMessage(err)}`, durationMs: Date.now() - start });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        if (timedOut) {
          resolvePromise({ success: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s`, stdout, stderr, durationMs });
          return;
        }

        if (code === 0) {
          resolvePromise({ success: true, stdout, stderr, exitCode: 0, durationMs });
        } else {
          resolvePromise({ success: false, error: `exited with code ${code}`, stdout, stderr, ...(code !== null && { exitCode: code }), durationMs });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT' ? ` (subscriber '${subscriber}': the program was not found. Fix: install it, put it on PATH, or check the working directory '${cwd ?? process.cwd()}')` : '';
        resolvePromise({ success: false, error: getErrorMessage(err) + notFound, durationMs: Date.now() - start });
      });

      // A program that exits before reading its stdin closes the pipe: that must not crash the daemon
      child.stdin?.on('error', () => undefined);

      try {
        child.stdin?.write(JSON.stringify(envelope) + '\n');
        child.stdin?.end();
      } catch {
        // stdin may already be closed
      }
    });
  }
}
