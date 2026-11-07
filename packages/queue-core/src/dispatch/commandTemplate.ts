/**
 * Command templates of `cli` subscribers. A command that holds `{{ field }}` placeholders is never given to a shell:
 * it is split into arguments first (tokenizeTemplate), then the placeholders are replaced inside each argument (substituteToken),
 * so a payload value can neither split into several arguments nor become shell code. Rules: docs/subscribers.md.
 */

import { findForbiddenSegment, walkPayloadPath, type WalkOptions } from '../walkPayloadPath.js';
import { EventRefError } from './refResolver.js';

/** One placeholder: `{{ field }}` or `{{ payload.field }}`. Sticky copies are used to match at a given position. */
const PLACEHOLDER_SOURCE = '\\{\\{\\s*([\\w.]+)\\s*\\}\\}';

export interface LiteralPart {
  kind: 'literal';
  text: string;
}

export interface FieldPart {
  kind: 'field';
  /** Payload key or dotted path (see walkPayloadPath), without the optional `payload.` prefix. */
  field: string;
}

export type TemplatePart = LiteralPart | FieldPart;

/** One argument of the command, before substitution. */
export type TemplateToken = TemplatePart[];

/** The template cannot be run (or never will be): the message says what to change. */
export class CommandTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandTemplateError';
  }
}

/** True when the command holds at least one `{{ field }}` placeholder (it then runs without a shell). */
export function hasPlaceholders(command: string): boolean {
  return new RegExp(PLACEHOLDER_SOURCE).test(command);
}

/** A shell construct that the no-shell mode does not perform: kept to refuse the command at load time instead of passing it literally. */
export interface Hazard {
  /** What the user wrote, e.g. `|`. */
  text: string;
  /** What it does in a shell. */
  meaning: string;
}

interface ScanResult {
  tokens: TemplateToken[];
  hazards: Hazard[];
}

const WHITESPACE = /\s/;
const ENV_PERCENT = /%[A-Za-z_][A-Za-z0-9_]*%/y;

function describeOperator(char: string): Hazard | undefined {
  switch (char) {
    case '|': return { text: '|', meaning: 'pipe' };
    case '&': return { text: '&', meaning: 'command separator' };
    case ';': return { text: ';', meaning: 'command separator' };
    case '>': return { text: '>', meaning: 'output redirection' };
    case '<': return { text: '<', meaning: 'input redirection' };
    default: return undefined;
  }
}

/**
 * Splits a command template into arguments and lists the shell constructs it contains.
 * Quoting: whitespace separates arguments; '...' is literal; "..." is literal; a backslash is an ordinary character except in front of a double quote,
 * where `\"` is a literal `"` (outside single quotes). `""` is an empty argument. Placeholders are replaced inside quotes too and are never split.
 * An unterminated quote throws.
 */
function scan(source: string): ScanResult {
  const tokens: TemplateToken[] = [];
  const hazards: Hazard[] = [];
  let parts: TemplatePart[] = [];
  let buffer = '';
  let inToken = false;
  let quote: "'" | '"' | null = null;

  const flushBuffer = (): void => {
    if (buffer !== '') {
      parts.push({ kind: 'literal', text: buffer });
      buffer = '';
    }
  };
  const endToken = (): void => {
    flushBuffer();
    if (inToken) {
      tokens.push(parts);
    }
    parts = [];
    inToken = false;
  };

  let i = 0;
  while (i < source.length) {
    const placeholder = new RegExp(PLACEHOLDER_SOURCE, 'y');
    placeholder.lastIndex = i;
    const match = placeholder.exec(source);
    if (match !== null) {
      flushBuffer();
      const path = match[1]!;
      parts.push({ kind: 'field', field: path.startsWith('payload.') ? path.slice('payload.'.length) : path });
      inToken = true;
      i += match[0].length;
      continue;
    }

    const char = source[i]!;
    const next = source[i + 1];

    // Expansions a shell would do in double quotes or unquoted; literal in single quotes
    if (quote !== "'") {
      if (char === '`') {
        hazards.push({ text: '`', meaning: 'command substitution' });
      } else if (char === '$' && next === '(') {
        hazards.push({ text: '$(', meaning: 'command substitution' });
      } else if (char === '$' && next !== undefined && /[A-Za-z_{]/.test(next)) {
        hazards.push({ text: '$' + (next === '{' ? '{' : next), meaning: 'environment variable expansion' });
      } else if (char === '%') {
        ENV_PERCENT.lastIndex = i;
        const percent = ENV_PERCENT.exec(source);
        if (percent !== null) {
          hazards.push({ text: percent[0], meaning: 'environment variable expansion' });
        }
      }
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        buffer += char;
      }
    } else if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === '\\' && next === '"') {
        buffer += '"';
        i++;
      } else {
        buffer += char;
      }
    } else if (WHITESPACE.test(char)) {
      endToken();
    } else if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
    } else if (char === '\\' && next === '"') {
      buffer += '"';
      inToken = true;
      i++;
    } else {
      const operator = describeOperator(char);
      if (operator !== undefined) {
        hazards.push(operator);
      }
      buffer += char;
      inToken = true;
    }
    i++;
  }

  if (quote !== null) {
    throw new CommandTemplateError(
      `unterminated ${quote === "'" ? 'single' : 'double'} quote (${quote}) in the command. ` +
      `Fix: close the quote. Quoting rules: ${QUOTING_RULES_REF}`
    );
  }
  endToken();
  return { tokens, hazards };
}

const QUOTING_RULES_REF = "whitespace separates arguments, '...' and \"...\" group, \\\" is a literal double quote, any other backslash is literal (docs/subscribers.md)";

/** Splits a template into arguments (placeholders kept apart from the literal text). Throws CommandTemplateError on an unterminated quote. */
export function tokenizeTemplate(source: string): TemplateToken[] {
  return scan(source).tokens;
}

/**
 * Problem that makes a command with placeholders unfit to run without a shell, or undefined when it is fine (also when it has no placeholder:
 * such a command runs in a shell as it always did). Meant for load time; the message names no subscriber, the caller adds it.
 */
export function findTemplateProblem(command: string): string | undefined {
  if (!hasPlaceholders(command)) {
    return undefined;
  }
  let result: ScanResult;
  try {
    result = scan(command);
  } catch (err) {
    if (err instanceof CommandTemplateError) {
      return err.message;
    }
    throw err;
  }
  const program = result.tokens[0];
  if (program === undefined) {
    return `the command is empty. Fix: start the command with the program to run.`;
  }
  if (program.some((part) => part.kind === 'field')) {
    return (
      `a {{ }} placeholder is in the program position (the first word). A payload value must never choose which program runs. ` +
      `Fix: name the program literally and pass the value as an argument.`
    );
  }
  for (const token of result.tokens) {
    for (const part of token) {
      const forbidden = part.kind === 'field' ? findForbiddenSegment(part.field) : undefined;
      if (part.kind === 'field' && forbidden !== undefined) {
        return (
          `the placeholder {{ ${part.field} }} is refused: '${forbidden}' is never read from a payload (it would reach the prototype of an object, not data). ` +
          `Fix: use another payload key, or rename that key at the source.`
        );
      }
    }
  }
  const interpreterProblem = findInterpreterProblem(result.tokens);
  if (interpreterProblem !== undefined) {
    return interpreterProblem;
  }
  if (result.hazards.length > 0) {
    const unique = [...new Map(result.hazards.map((h) => [h.text, h])).values()];
    const listed = unique.map((h) => `'${h.text}' (${h.meaning})`).join(', ');
    return (
      `the command uses {{ }} placeholders AND shell syntax: ${listed}. A command with placeholders runs without a shell (so that a payload value cannot become code), ` +
      `and these would be passed to the program as plain text. ` +
      `Fix: read the event envelope on stdin (it is always sent as one JSON line) and move the shell logic into a script, ` +
      `or remove the shell syntax. To pass such a character literally, put it in single quotes. See docs/subscribers.md.`
    );
  }
  return undefined;
}

/**
 * Which arguments a code flag turns into code: `self` the flag token only (`--eval=...`), `next` the flag and the argument after it,
 * `rest` the flag and every argument after it (cmd.exe joins them all into one command line).
 */
type CodeScope = 'self' | 'next' | 'rest';

interface CodeFlag {
  /**
   * Matched against the START of the literal text of an argument (a placeholder counts as empty text): the code can be attached to the flag
   * (`-cprint(1)`, `-eputs 1`) and flags can be bundled (`-lne`, `-ec`), so an anchored-at-the-end pattern would let both through.
   */
  pattern: RegExp;
  scope: CodeScope;
}

interface InterpreterRule {
  /** Arguments that make the program read the next text as code. */
  codeFlags: ReadonlyArray<CodeFlag>;
  /** Options that take their value as the NEXT argument (that value is not the script). Options written `--name=value` need no entry. */
  valueOptions?: ReadonlySet<string>;
  /** Words that, as the first non-option argument, are a subcommand and not the script (`deno run script.ts`): the script is the next one. */
  subcommands?: ReadonlySet<string>;
  /** The rule applies only when the first non-option argument is one of `subcommands` (`npm exec`, but not `npm install`). */
  subcommandRequired?: boolean;
  /** The program takes no script argument (cmd.exe): only the code flags are checked. */
  noScriptPosition?: boolean;
  /** A script file name of this program, for the example of the error. */
  scriptName?: string;
  /** PowerShell: a placeholder is accepted only after `-File <literal script>` (see findPowerShellProblem). */
  powershell?: boolean;
  /** The safe form shown in the error. */
  safeForm: string;
}

const POSIX_SHELL_RULE: InterpreterRule = {
  // -c, -lc, -ec, ... (a lowercase c in an option cluster, text may follow it); fish also accepts --command
  codeFlags: [{ pattern: /^(?:-[A-Za-z]*c|--command)/, scope: 'next' }],
  valueOptions: new Set(['-o', '-O', '--rcfile', '--init-file']),
  safeForm: `pass the value as a separate argument after the script and read it as a positional parameter, e.g. bash -c 'echo "$1"' _ {{ x }}`,
};

const GENERIC_EVAL_SAFE_FORM = (example: string): string => `pass the value as a separate argument after the code and read it from the program's argument list, e.g. ${example}`;

/** Programs that run one of their arguments as code, by name (lowercase, no extension). Best-effort denylist: see docs/subscribers.md. */
const INTERPRETER_RULES: Readonly<Record<string, InterpreterRule>> = {
  sh: POSIX_SHELL_RULE,
  bash: POSIX_SHELL_RULE,
  zsh: POSIX_SHELL_RULE,
  dash: POSIX_SHELL_RULE,
  ksh: POSIX_SHELL_RULE,
  mksh: POSIX_SHELL_RULE,
  ash: POSIX_SHELL_RULE,
  fish: POSIX_SHELL_RULE,
  csh: POSIX_SHELL_RULE,
  tcsh: POSIX_SHELL_RULE,
  cmd: {
    codeFlags: [{ pattern: /^[/-][ckr]/i, scope: 'rest' }],
    noScriptPosition: true,
    safeForm: 'cmd.exe has no safe way to receive a value; start a real program or a script file instead (e.g. node script.js {{ x }}), or read the event envelope on stdin',
  },
  powershell: {
    codeFlags: [],
    powershell: true,
    safeForm: 'start the command with -File and a literal script path, and put the placeholder after it, e.g. powershell -NoProfile -File script.ps1 {{ x }}, or read the event envelope on stdin',
  },
  node: {
    codeFlags: [
      { pattern: /^--(?:eval|print)=/, scope: 'self' },
      { pattern: /^(?:-e|-p|--eval|--print)/, scope: 'next' },
    ],
    valueOptions: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title']),
    scriptName: 'script.js',
    safeForm: GENERIC_EVAL_SAFE_FORM('node -e "console.log(process.argv[1])" {{ x }}'),
  },
  bun: {
    codeFlags: [
      { pattern: /^--(?:eval|print)=/, scope: 'self' },
      { pattern: /^(?:-e|-p|--eval|--print)/, scope: 'next' },
    ],
    valueOptions: new Set(['-r', '--preload', '--import', '--cwd', '--config', '-c']),
    subcommands: new Set(['run', 'x', 'exec']),
    scriptName: 'script.ts',
    safeForm: GENERIC_EVAL_SAFE_FORM('bun -e "console.log(process.argv[2])" {{ x }}'),
  },
  deno: {
    codeFlags: [{ pattern: /^eval$/, scope: 'next' }],
    subcommands: new Set(['run', 'test', 'bench', 'task', 'serve', 'repl']),
    scriptName: 'script.ts',
    safeForm: 'run a script file and pass the value after it (deno run script.ts {{ x }}), or read the event envelope on stdin',
  },
  python: {
    // -c with text attached or bundled (-Bc), and -m (the module after it is code to import and run)
    codeFlags: [{ pattern: /^-[A-Za-z]*[cm]/, scope: 'next' }],
    valueOptions: new Set(['-W', '-X', '--check-hash-based-pycs']),
    scriptName: 'script.py',
    safeForm: GENERIC_EVAL_SAFE_FORM('python -c "import sys; print(sys.argv[1])" {{ x }}'),
  },
  perl: {
    codeFlags: [{ pattern: /^-[A-Za-z0-9]*[eE]/, scope: 'next' }],
    valueOptions: new Set(['-I', '-M', '-m']),
    safeForm: GENERIC_EVAL_SAFE_FORM('perl -e \'print $ARGV[0]\' {{ x }}'),
  },
  ruby: {
    codeFlags: [{ pattern: /^-[A-Za-z0-9]*e/, scope: 'next' }],
    valueOptions: new Set(['-I', '-r', '-C']),
    safeForm: GENERIC_EVAL_SAFE_FORM('ruby -e \'puts ARGV[0]\' {{ x }}'),
  },
  php: {
    codeFlags: [{ pattern: /^-[A-Za-z]*r/, scope: 'next' }],
    valueOptions: new Set(['-c', '-d']),
    safeForm: GENERIC_EVAL_SAFE_FORM('php -r \'echo $argv[1];\' -- {{ x }}'),
  },
  lua: {
    codeFlags: [{ pattern: /^-e/, scope: 'next' }],
    valueOptions: new Set(['-l']),
    safeForm: GENERIC_EVAL_SAFE_FORM('lua -e "print(arg[1])" {{ x }}'),
  },
  rscript: {
    codeFlags: [{ pattern: /^-e/, scope: 'next' }],
    safeForm: GENERIC_EVAL_SAFE_FORM('Rscript -e "commandArgs(TRUE)" {{ x }}'),
  },
  osascript: {
    codeFlags: [{ pattern: /^-e/, scope: 'next' }],
    valueOptions: new Set(['-l']),
    safeForm: 'run a script file and pass the value after it (osascript script.scpt {{ x }}), or read the event envelope on stdin',
  },
  // npx and `npm exec` download and run a package: the first argument chooses what runs, -c runs a command line
  npx: {
    codeFlags: [{ pattern: /^(?:-c|--call)/, scope: 'next' }],
    valueOptions: new Set(['-p', '--package']),
    safeForm: 'name the package literally and pass the value after it (npx some-tool {{ x }}), or read the event envelope on stdin',
  },
  npm: {
    codeFlags: [{ pattern: /^(?:-c|--call)/, scope: 'next' }],
    valueOptions: new Set(['-p', '--package']),
    subcommands: new Set(['exec', 'x']),
    subcommandRequired: true,
    safeForm: 'name the package literally and pass the value after it (npm exec some-tool -- {{ x }}), or read the event envelope on stdin',
  },
};

/** Other names of a rule, by pattern on the normalised (lowercase) program name (versioned or suffixed binaries). */
const INTERPRETER_ALIASES: ReadonlyArray<{ pattern: RegExp; rule: string }> = [
  { pattern: /^(?:python|pypy)[\d.]*w?$/, rule: 'python' },
  { pattern: /^py$/, rule: 'python' },
  { pattern: /^pwsh(?:-preview)?$/, rule: 'powershell' },
  { pattern: /^powershell_ise$/, rule: 'powershell' },
  { pattern: /^nodejs$/, rule: 'node' },
  { pattern: /^(?:bunx|pnpx)$/, rule: 'npx' },
];

const PROGRAM_EXTENSION = /\.(?:exe|cmd|bat)$/i;

/**
 * Program name as matched against the rules: last path segment, without .exe/.cmd/.bat, lowercase on EVERY platform (Windows and macOS file systems
 * are case-insensitive, so `BASH` runs bash there; a platform-dependent match would let the same subscribers.yml pass on one machine and not on another).
 */
function normalizeProgramName(program: string): string {
  return program.slice(Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\')) + 1).replace(PROGRAM_EXTENSION, '').toLowerCase();
}

function findInterpreterRule(program: string): { name: string; rule: InterpreterRule } | undefined {
  const name = normalizeProgramName(program);
  // Own keys only: a program named `constructor` or `toString` is not a rule
  if (Object.hasOwn(INTERPRETER_RULES, name)) {
    return { name, rule: INTERPRETER_RULES[name]! };
  }
  const alias = INTERPRETER_ALIASES.find((entry) => entry.pattern.test(name));
  return alias === undefined ? undefined : { name, rule: INTERPRETER_RULES[alias.rule]! };
}

function literalText(token: TemplateToken): string {
  return token.map((part) => (part.kind === 'literal' ? part.text : '')).join('');
}

function hasField(token: TemplateToken | undefined): boolean {
  return token !== undefined && token.some((part) => part.kind === 'field');
}

/** Switches PowerShell accepts that change nothing about what runs. `min` is the shortest prefix PowerShell resolves to it (it accepts any unique prefix). */
const POWERSHELL_HARMLESS: ReadonlyArray<{ name: string; min: number; takesValue: boolean }> = [
  { name: 'noprofile', min: 3, takesValue: false },
  { name: 'nologo', min: 3, takesValue: false },
  { name: 'noexit', min: 3, takesValue: false },
  { name: 'noninteractive', min: 4, takesValue: false },
  { name: 'executionpolicy', min: 2, takesValue: true },
  { name: 'windowstyle', min: 1, takesValue: true },
];

function findHarmlessPowerShellSwitch(text: string): { takesValue: boolean } | undefined {
  if (!text.startsWith('-')) {
    return undefined;
  }
  const name = text.slice(1).toLowerCase();
  // -ep is the documented short form of -ExecutionPolicy
  if (name === 'ep') {
    return { takesValue: true };
  }
  return POWERSHELL_HARMLESS.find((entry) => name.length >= entry.min && entry.name.startsWith(name));
}

/** `-f`, `-fi`, `-fil`, `-file`, whatever the case. */
function isPowerShellFileSwitch(text: string): boolean {
  return /^-f(?:i(?:l(?:e)?)?)?$/i.test(text);
}

/**
 * PowerShell runs its first argument that is not a switch as command text, wherever a `-File` shows up later. A placeholder is therefore accepted only in
 * the form `[harmless switches] -File <literal script> ... {{ x }}`: nothing but the allowlisted switches before -File, a script path without placeholder,
 * the placeholders after it. Returns the problem, or undefined.
 */
function findPowerShellProblem(program: string, args: TemplateToken[], fix: string): string | undefined {
  if (!args.some((token) => hasField(token))) {
    return undefined;
  }
  let i = 0;
  while (i < args.length && !hasField(args[i])) {
    const harmless = findHarmlessPowerShellSwitch(literalText(args[i]!));
    if (harmless === undefined) {
      break;
    }
    if (harmless.takesValue && hasField(args[i + 1])) {
      break;
    }
    i += harmless.takesValue ? 2 : 1;
  }
  const fileSwitch = args[i];
  const script = args[i + 1];
  const safe = fileSwitch !== undefined && !hasField(fileSwitch) && isPowerShellFileSwitch(literalText(fileSwitch))
    && script !== undefined && !hasField(script) && literalText(script) !== '';
  if (safe) {
    return undefined;
  }
  return (
    `'${program}' runs the first argument that is not a known switch as PowerShell code, so a {{ }} placeholder would be run as code unless the command ` +
    `starts with -File and a literal script path (only -NoProfile, -NoLogo, -NonInteractive, -NoExit, -ExecutionPolicy <value> and -WindowStyle <value> may come before) ` +
    `and the placeholder comes after that script path. ${fix}`
  );
}

/**
 * Problem when the program is a known shell or interpreter and a placeholder lands where the program would read it as code, as an option, or as the
 * script to run (the value would be interpreted, which the no-shell mode exists to prevent). A placeholder in a separate argument after a literal script
 * (or after the code of a code flag) stays allowed. Best-effort denylist: wrappers (env, sudo, xargs, ssh, docker, ...) and programs missing from
 * INTERPRETER_RULES are not detected (docs/subscribers.md).
 */
function findInterpreterProblem(tokens: TemplateToken[]): string | undefined {
  const programToken = tokens[0];
  if (programToken === undefined) {
    return undefined;
  }
  const program = literalText(programToken);
  const found = findInterpreterRule(program);
  if (found === undefined) {
    return undefined;
  }
  const { rule } = found;
  const args = tokens.slice(1);
  const fix = `Fix: ${rule.safeForm}. This check is a best-effort list of known shells and interpreters (docs/subscribers.md).`;

  if (rule.powershell === true) {
    return findPowerShellProblem(program, args, fix);
  }

  let subcommandSeen = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const text = literalText(token);
    const flag = rule.codeFlags.find((candidate) => candidate.pattern.test(text));
    if (flag !== undefined) {
      const last = flag.scope === 'rest' ? args.length - 1 : flag.scope === 'next' ? i + 1 : i;
      for (let j = i; j <= last && j < args.length; j++) {
        if (hasField(args[j])) {
          return (
            `'${program}' reads '${text}' and ${flag.scope === 'rest' ? 'every argument after it' : 'the argument after it'} as code (${found.name === 'cmd' ? 'a command line' : 'a script'}), so a {{ }} placeholder there would be interpreted ` +
            `instead of staying data. ${fix}`
          );
        }
      }
      // The code is found and holds no placeholder; what follows is data for it (positional parameters)
      return undefined;
    }
    if (rule.noScriptPosition === true) {
      continue;
    }

    if (text.startsWith('-')) {
      if (hasField(token)) {
        return positionProblem(program, rule, `in the option '${text}'`, fix);
      }
      if (rule.valueOptions?.has(text) === true && i + 1 < args.length) {
        if (hasField(args[i + 1])) {
          return positionProblem(program, rule, `as the value of '${text}'`, fix);
        }
        i++;
      }
      continue;
    }

    // First argument that is not an option: the script (or a subcommand in front of it)
    if (hasField(token)) {
      return positionProblem(program, rule, 'where the script is expected', fix);
    }
    if (rule.subcommands?.has(text) === true && !subcommandSeen) {
      subcommandSeen = true;
      continue;
    }
    if (rule.subcommandRequired === true && !subcommandSeen) {
      return undefined;
    }
    // A literal script: everything after it is data for the script
    return undefined;
  }
  return undefined;
}

function positionProblem(program: string, rule: InterpreterRule, where: string, fix: string): string {
  const script = rule.scriptName ?? 'script';
  const example = rule.subcommands !== undefined && rule.subcommandRequired !== true ? `${program} ${[...rule.subcommands][0]!} ${script} {{ x }}` : `${program} ${script} {{ x }}`;
  return (
    `a {{ }} placeholder sits ${where} of '${program}', before the script. The program would read the value as an option, or run it as the script, module or package, ` +
    `instead of taking it as data. The placeholder must come after a literal script (e.g. ${example}). ${fix}`
  );
}


/** Characters of the `{{ }}` values that cmd.exe would interpret, with the name of their class (used for .cmd and .bat targets). */
const CMD_METACHARACTERS: ReadonlyArray<{ char: string; name: string }> = [
  { char: '&', name: 'command separator' },
  { char: '|', name: 'pipe' },
  { char: '<', name: 'input redirection' },
  { char: '>', name: 'output redirection' },
  { char: '^', name: 'escape character' },
  { char: '%', name: 'environment variable expansion' },
  { char: '!', name: 'delayed expansion' },
  { char: '"', name: 'double quote' },
  { char: '`', name: 'backtick' },
  { char: '\r', name: 'line break (CR)' },
  { char: '\n', name: 'line break (LF)' },
];

/** The first cmd.exe metacharacter of a value, or undefined. */
export function findCmdMetacharacter(value: string): { char: string; name: string } | undefined {
  return CMD_METACHARACTERS.find((entry) => value.includes(entry.char));
}

/** Text of a payload value as one argument: strings as they are, objects and arrays as JSON, missing and null as an empty string. */
export function valueToArgument(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

export interface SubstitutedField {
  field: string;
  value: string;
}

export interface SubstitutedArgument {
  text: string;
  /** The placeholders replaced in this argument, in order. */
  fields: SubstitutedField[];
}

/**
 * Replaces the placeholders of one argument with the payload values. A payload that is not an object has no field: every value is empty.
 * A field is read by walkPayloadPath: the whole dotted key as an own key first, else a walk through own properties. Pure: `options.resolveRef`
 * is the only way a value outside the payload can come in, and the caller supplies it. A reference that cannot be followed for good (the base event
 * is gone) throws CommandTemplateError naming the field and the reference; one that failed for now (history unreadable) throws EventRefError (retryable).
 */
export function substituteToken(token: TemplateToken, payload: unknown, options: WalkOptions = {}): SubstitutedArgument {
  let text = '';
  const fields: SubstitutedField[] = [];
  for (const part of token) {
    if (part.kind === 'literal') {
      text += part.text;
      continue;
    }
    // Own properties only: `{{ constructor }}` or `{{ toString }}` must not paste the source of an inherited function
    let value: string;
    try {
      value = valueToArgument(walkPayloadPath(payload, part.field, options));
    } catch (err) {
      if (err instanceof EventRefError) {
        const located = err.withContext(`payload field '${part.field}'`);
        throw located.permanent ? new CommandTemplateError(located.message) : located;
      }
      throw err;
    }
    fields.push({ field: part.field, value });
    text += value;
  }
  return { text, fields };
}
