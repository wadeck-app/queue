import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { extname, join } from 'node:path';
import type { EventEnvelope } from '../types.js';
import type { ResolveRef } from '../walkPayloadPath.js';
import { EventRefError } from './refResolver.js';
import { getErrorMessage } from '../errors.js';
import { CommandTemplateError, findCmdMetacharacter, hasPlaceholders, substituteToken, tokenizeTemplate } from './commandTemplate.js';
import type { DispatchResult } from './DispatchResult.js';
import { resolveNpmShim } from './NpmShim.js';
import { formatDuration } from './formatDuration.js';
import { describePathEntryCount, envValue, findWindowsProgram } from './windowsProgram.js';

type SpawnOptions = Parameters<typeof spawn>[2];

/** How a command with placeholders is started: the program and its arguments, never through a shell the payload could reach. */
interface DirectLaunch {
  file: string;
  args: string[];
  options: SpawnOptions;
}

/** cmd.exe line for a .cmd/.bat target: `"file" "arg" ...`, every argument double-quoted (the values were checked to hold no quote). */
function quoteForCmd(arg: string): string {
  // Backslashes in front of an inner quote are doubled and the quote escaped (only a literal part of the template can hold a quote). A run of backslashes
  // at the end stays as it is: cmd.exe and the batch parameter %~1 do not treat a backslash before the closing quote specially (doubling it delivered C:\dir\\ for C:\dir\)
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  return `"${escaped}"`;
}

/** Whether a whole-argument value would be read by the program as an option (`-x`, `--long`; a negative number is data) or as a file to read (`@file`). */
function looksLikeOption(value: string): boolean {
  return /^-[A-Za-z-]/.test(value) || value.startsWith('@');
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
  // A placeholder that is the WHOLE argument lets the value start it: `--help` or `-rf` would be read by the program as an option, `@file` by many as a file to read
  const templateArguments = tokens.slice(1);
  substituted.forEach((argument, index) => {
    const wholeToken = templateArguments[index]!.every((part) => part.kind === 'field');
    if (wholeToken && looksLikeOption(argument.text)) {
      const fields = argument.fields.map((entry) => entry.field);
      const shown = argument.text.length > 40 ? `${argument.text.slice(0, 40)}...` : argument.text;
      throw new CommandTemplateError(
        `${label}: payload field '${fields.join("', '")}' of event '${envelope.event}' fills a whole argument of the command and its value (${JSON.stringify(shown)}) starts like an option or a file reference, ` +
        `so it would be read as an option by the program instead of staying data. The delivery is refused and not retried. ` +
        `Fix: write the option name in front so that the value cannot start the argument, e.g. --name={{ ${fields[0]!} }} (the name your program expects), or validate the field at the source.`
      );
    }
  });
  const args = substituted.map((argument) => argument.text);
  const effectiveEnv = env ?? process.env;

  if (process.platform !== 'win32') {
    return { file: program, args, options: baseOptions };
  }

  const found = findWindowsProgram(program, cwd, effectiveEnv);
  if (found === undefined) {
    throw new CommandTemplateError(
      `${label}: program '${program}' was not found on the PATH of the queue daemon (${describePathEntryCount(effectiveEnv)}, tried with the extensions of PATHEXT; the working directory is not searched, so a file planted there cannot run in place of a tool). ` +
      `The daemon keeps the PATH it was started with; the list is in "queue logs" (written when the daemon started). A program of the working directory is written with its directory (./${program}). Fix: install it, put it on PATH, or give its full path in the command; if it works in your shell, restart the daemon from that shell ("queue stop", the next push starts it again).`
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
      // cmd.exe cannot pass a final backslash faithfully: a batch file reading %~1 wants it as it is, a program parsing %* like the C runtime wants it doubled
      if (value.endsWith('\\')) {
        throw new CommandTemplateError(
          `${label}: payload field '${field}' of event '${envelope.event}' ends with a backslash, and '${program}' resolves to ${found}, a batch file that Windows can only start through cmd.exe, ` +
          `which cannot pass a trailing backslash faithfully (a batch file reading %~1 and a program parsing %* like the C runtime disagree on it). The delivery is refused and not retried. ` +
          `Fix: do not end the value with a backslash (strip it at the source), or make the command start a real program (an .exe, or node/your interpreter with a script) or an npm shim instead of the batch file.`
        );
      }
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

/** How long to wait for the pipes to close after the process exited, before resolving with what was read. */
const EXIT_CLOSE_GRACE_MS = 3000;
/** Outside Windows: how long after SIGTERM the process group gets SIGKILL. */
const KILL_ESCALATION_MS = 2000;
/** After a timeout: the dispatch ends at the latest this long after the kill, even if the process never reports its end. */
const KILL_DEADLINE_MS = 5000;

/**
 * Stops the child AND everything it started: `taskkill /T /F` on Windows, a signal to the process group outside it (the child was spawned detached, so it leads one).
 * `report` receives what went wrong when the child is still running afterwards; nothing is thrown (this runs from a timer).
 */
function killProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL', report: (problem: string) => void): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(signal);
    return;
  }
  if (process.platform === 'win32') {
    // The system copy, not a name looked up on PATH or in the working directory of the daemon
    const taskkill = join(envValue(process.env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, (err, _stdout, stderr) => {
      if (err !== null && child.exitCode === null) {
        report(`taskkill failed: ${(stderr.trim() || getErrorMessage(err))}`);
        child.kill();
      }
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // ESRCH: the group is already gone
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      report(`could not signal the process group ${pid}: ${getErrorMessage(err)}`);
      child.kill(signal);
    }
  }
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
    // Outside Windows the child leads its own process group, so that a timeout can signal the whole tree (killProcessTree)
    const baseOptions: SpawnOptions = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd, env: spawnEnv, detached: process.platform !== 'win32' };

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
      let killProblem: string | undefined;
      let settled = false;
      const pending: NodeJS.Timeout[] = [];

      // One resolution only; it releases the pipes so that a grandchild that keeps them open cannot keep this dispatch (and the daemon) alive
      const settle = (result: DispatchResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        pending.forEach(clearTimeout);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolvePromise(result);
      };

      const settleWithCode = (code: number | null): void => {
        const durationMs = Date.now() - start;

        if (timedOut) {
          const detail = killProblem === undefined ? '' : ` (the process tree may still run: ${killProblem})`;
          settle({ success: false, error: `timeout after ${formatDuration(timeoutMs)}${detail}`, stdout, stderr, durationMs });
          return;
        }

        if (code === 0) {
          settle({ success: true, stdout, stderr, exitCode: 0, durationMs });
        } else {
          settle({ success: false, error: `exited with code ${code}`, stdout, stderr, ...(code !== null && { exitCode: code }), durationMs });
        }
      };

      pending.push(setTimeout(() => {
        timedOut = true;
        // The shell (cmd.exe, sh) is only the root of the tree: killing it alone leaves its children running and holding the pipes
        killProcessTree(child, 'SIGTERM', (problem) => { killProblem = problem; });
        if (process.platform !== 'win32') {
          pending.push(setTimeout(() => killProcessTree(child, 'SIGKILL', (problem) => { killProblem = problem; }), KILL_ESCALATION_MS));
        }
        // Neither exit nor close may come if the kill failed: the dispatch must still end
        pending.push(setTimeout(() => settleWithCode(null), KILL_DEADLINE_MS));
      }, timeoutMs));

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      // 'close' comes once the pipes are closed, which a grandchild that inherited them can delay for as long as it lives: after 'exit', wait for it only a bounded time
      child.on('exit', (code) => {
        pending.push(setTimeout(() => settleWithCode(code), EXIT_CLOSE_GRACE_MS));
      });

      child.on('close', (code) => {
        settleWithCode(code);
      });

      child.on('error', (err) => {
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT' ? ` (subscriber '${subscriber}': the program was not found. Fix: install it, put it on PATH, or check the working directory '${cwd ?? process.cwd()}')` : '';
        settle({ success: false, error: getErrorMessage(err) + notFound, durationMs: Date.now() - start });
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
