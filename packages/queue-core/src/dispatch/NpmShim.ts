import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CommandTemplateError } from './commandTemplate.js';
import { findWindowsProgram, isFile } from './windowsProgram.js';

/** What an npm-generated .cmd shim starts: `nodeExe script ...args`, which needs no cmd.exe. */
export interface NpmShimLaunch {
  nodeExe: string;
  script: string;
}

const MAX_SHIM_BYTES = 8 * 1024;
const SCRIPT_EXTENSIONS = ['.js', '.cjs', '.mjs'];

// Relative script path inside a launch line: no quote, percent, or cmd metacharacter
const REL = String.raw`([^"%&|<>^!\r\n]+)`;
const LAUNCH_LINES: readonly RegExp[] = [
  // npm 7+ (cmd-shim 4+), and the same without the trailing `endLocal` prefix (npm 6)
  new RegExp(String.raw`^(?:endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & )?"%_prog%"\s+"%dp0%\\${REL}"\s+%\*$`, 'i'),
  // Older cmd-shim: one launch line with a local node.exe, one with node from PATH
  new RegExp(String.raw`^"%~dp0\\node\.exe"\s+"%~dp0\\${REL}"\s+%\*$`, 'i'),
  new RegExp(String.raw`^node\s+"%~dp0\\${REL}"\s+%\*$`, 'i'),
];

// The standard non-launch lines of the shims, compared lowercase without a leading @ and with single spaces
const STANDARD_LINES: ReadonlySet<string> = new Set([
  'echo off',
  'goto start',
  ':find_dp0',
  'set dp0=%~dp0',
  'exit /b',
  ':start',
  'setlocal',
  'call :find_dp0',
  'if exist "%dp0%\\node.exe" (',
  'set "_prog=%dp0%\\node.exe"',
  ') else (',
  'set "_prog=node"',
  'set pathext=%pathext:;.js;=;%',
  ')',
  'endlocal',
  'exit /b %errorlevel%',
  'if exist "%~dp0\\node.exe" (',
]);

function normalizeLine(line: string): string {
  return line.trim().replace(/^@\s*/, '').replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Pure parser: the script path relative to the shim directory (backslash separated, as written), or undefined when the text is not
 * exactly a standard npm/cmd-shim .cmd (any unrecognised line, several different scripts, extra arguments, a path escaping the directory).
 */
export function parseNpmShim(text: string): string | undefined {
  if (text.includes('\0') || Buffer.byteLength(text) > MAX_SHIM_BYTES) {
    return undefined;
  }
  const scripts = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') {
      continue;
    }
    const withoutAt = raw.trim().replace(/^@\s*/, '');
    const launch = LAUNCH_LINES.map((re) => re.exec(withoutAt)).find((m) => m !== null);
    if (launch) {
      scripts.add(launch[1] ?? '');
      continue;
    }
    if (!STANDARD_LINES.has(normalizeLine(raw))) {
      return undefined;
    }
  }
  if (scripts.size !== 1) {
    return undefined;
  }
  const rel = [...scripts][0] ?? '';
  const segments = rel.split(/[\\/]/);
  if (rel.trim() === '' || isAbsolute(rel) || rel.includes(':') || segments.some((s) => s.trim() === '' || s === '.' || s === '..')) {
    return undefined;
  }
  if (!SCRIPT_EXTENSIONS.includes(extname(rel).toLowerCase())) {
    return undefined;
  }
  return rel;
}

/**
 * The absolute path of the script named by a shim, or undefined when it is not strictly below the shim directory. The parser already refuses '..' and absolute
 * paths; this is the second guard on the resolved path. A folder merely named '..lib' is inside: only '..' as a whole segment climbs out.
 */
export function scriptInside(shimDir: string, rel: string): string | undefined {
  const script = resolve(shimDir, ...rel.split(/[\\/]/));
  const fromShim = relative(shimDir, script);
  if (fromShim === '' || fromShim === '..' || fromShim.startsWith('..' + sep) || isAbsolute(fromShim)) {
    return undefined;
  }
  return script;
}

/**
 * Recognises a standard npm-generated .cmd shim and returns how to start it without cmd.exe, or undefined when `shimPath` is anything else
 * (the caller then keeps the cmd.exe path with its metacharacter refusal). Throws CommandTemplateError when the shim is recognised but node cannot be found.
 */
export function resolveNpmShim(shimPath: string, env: NodeJS.ProcessEnv): NpmShimLaunch | undefined {
  let text: string;
  try {
    if (statSync(shimPath).size > MAX_SHIM_BYTES) {
      return undefined;
    }
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return undefined;
  }
  const rel = parseNpmShim(text);
  if (rel === undefined) {
    return undefined;
  }
  const shimDir = dirname(resolve(shimPath));
  const script = scriptInside(shimDir, rel);
  if (script === undefined || !isFile(script)) {
    return undefined;
  }

  const localNode = join(shimDir, 'node.exe');
  if (isFile(localNode)) {
    return { nodeExe: localNode, script };
  }
  // A bare name is looked up on PATH only: a node.exe dropped in the event's cwd must not be picked up
  const onPath = findWindowsProgram('node', undefined, env);
  const extension = onPath === undefined ? '' : extname(onPath).toLowerCase();
  if (onPath === undefined || (extension !== '.exe' && extension !== '.com')) {
    throw new CommandTemplateError(
      `'${shimPath}' is an npm shim that starts node, but no node.exe was found ` +
      (onPath === undefined ? 'next to it or on PATH' : `next to it, and '${onPath}' on PATH is not an .exe`) +
      `. Fix: put node.exe on PATH of the daemon (restart it afterwards), or give the full path of a program in the command.`
    );
  }
  return { nodeExe: onPath, script };
}
