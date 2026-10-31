/**
 * Command templates of `cli` subscribers. A command that holds `{{ field }}` placeholders is never given to a shell:
 * it is split into arguments first (tokenizeTemplate), then the placeholders are replaced inside each argument (substituteToken),
 * so a payload value can neither split into several arguments nor become shell code. Rules: docs/subscribers.md.
 */

/** One placeholder: `{{ field }}` or `{{ payload.field }}`. Sticky copies are used to match at a given position. */
const PLACEHOLDER_SOURCE = '\\{\\{\\s*([\\w.]+)\\s*\\}\\}';

export interface LiteralPart {
  kind: 'literal';
  text: string;
}

export interface FieldPart {
  kind: 'field';
  /** Payload key, without the optional `payload.` prefix. */
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
  /** Matched against the literal text of an argument (a placeholder counts as empty text). */
  pattern: RegExp;
  scope: CodeScope;
}

interface InterpreterRule {
  /** Arguments that make the program read the next text as code. */
  codeFlags: ReadonlyArray<CodeFlag>;
  /**
   * When set, the program treats its arguments as code unless one of them matches this pattern (PowerShell runs the first plain argument as a command
   * unless `-File` is given): then any placeholder is refused.
   */
  codeUnless?: RegExp;
  /** The safe form shown in the error. */
  safeForm: string;
}

const POSIX_SHELL_RULE: InterpreterRule = {
  // -c, -lc, -ec, ... (a lowercase c in an option cluster); fish also accepts --command
  codeFlags: [{ pattern: /^(?:-[A-Za-z]*c[A-Za-z]*|--command)$/, scope: 'next' }],
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
    safeForm: 'cmd.exe has no safe way to receive a value; start a real program or a script file instead (e.g. node script.js {{ x }}), or read the event envelope on stdin',
  },
  powershell: {
    codeFlags: [],
    codeUnless: /^[/-]f(?:i(?:l(?:e)?)?)?$/i,
    safeForm: 'run a script file with -File and pass the value after it, e.g. powershell -NoProfile -File script.ps1 {{ x }}, or read the event envelope on stdin',
  },
  node: {
    codeFlags: [
      { pattern: /^(?:-e|-p|-pe|-ep|--eval|--print)$/, scope: 'next' },
      { pattern: /^--(?:eval|print)=/, scope: 'self' },
    ],
    safeForm: GENERIC_EVAL_SAFE_FORM('node -e "console.log(process.argv[1])" {{ x }}'),
  },
  bun: {
    codeFlags: [
      { pattern: /^(?:-e|-p|--eval|--print)$/, scope: 'next' },
      { pattern: /^--(?:eval|print)=/, scope: 'self' },
    ],
    safeForm: GENERIC_EVAL_SAFE_FORM('bun -e "console.log(process.argv[2])" {{ x }}'),
  },
  deno: {
    codeFlags: [{ pattern: /^eval$/, scope: 'next' }],
    safeForm: 'run a script file and pass the value after it (deno run script.ts {{ x }}), or read the event envelope on stdin',
  },
  python: {
    codeFlags: [{ pattern: /^-[A-Za-z]*c$/, scope: 'next' }],
    safeForm: GENERIC_EVAL_SAFE_FORM('python -c "import sys; print(sys.argv[1])" {{ x }}'),
  },
  perl: {
    codeFlags: [{ pattern: /^-[A-Za-z]*[eE]$/, scope: 'next' }],
    safeForm: GENERIC_EVAL_SAFE_FORM('perl -e \'print $ARGV[0]\' {{ x }}'),
  },
  ruby: {
    codeFlags: [{ pattern: /^-[A-Za-z]*e$/, scope: 'next' }],
    safeForm: GENERIC_EVAL_SAFE_FORM('ruby -e \'puts ARGV[0]\' {{ x }}'),
  },
  php: {
    codeFlags: [{ pattern: /^-r$/, scope: 'next' }],
    safeForm: GENERIC_EVAL_SAFE_FORM('php -r \'echo $argv[1];\' -- {{ x }}'),
  },
  lua: {
    codeFlags: [{ pattern: /^-e$/, scope: 'next' }],
    safeForm: GENERIC_EVAL_SAFE_FORM('lua -e "print(arg[1])" {{ x }}'),
  },
  rscript: {
    codeFlags: [{ pattern: /^-e$/, scope: 'next' }],
    safeForm: GENERIC_EVAL_SAFE_FORM('Rscript -e "commandArgs(TRUE)" {{ x }}'),
  },
  osascript: {
    codeFlags: [{ pattern: /^-e$/, scope: 'next' }],
    safeForm: 'run a script file and pass the value after it (osascript script.scpt {{ x }}), or read the event envelope on stdin',
  },
};

/** Other names of a rule, by pattern on the normalised program name (versioned or suffixed binaries). */
const INTERPRETER_ALIASES: ReadonlyArray<{ pattern: RegExp; rule: string }> = [
  { pattern: /^(?:python|pypy)[\d.]*w?$/, rule: 'python' },
  { pattern: /^py$/, rule: 'python' },
  { pattern: /^pwsh(?:-preview)?$/, rule: 'powershell' },
  { pattern: /^powershell_ise$/, rule: 'powershell' },
  // The real binary is "Rscript"; names keep their case outside Windows, so the lowercase rule key would never match it there
  { pattern: /^Rscript$/, rule: 'rscript' },
];

const PROGRAM_EXTENSION = /\.(?:exe|cmd|bat)$/i;

/** Program name as matched against the rules: last path segment, without .exe/.cmd/.bat, lowercase on Windows. */
function normalizeProgramName(program: string): string {
  const base = program.slice(Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\')) + 1).replace(PROGRAM_EXTENSION, '');
  return process.platform === 'win32' ? base.toLowerCase() : base;
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

/**
 * Problem when the program is a known shell or interpreter and a placeholder lands in the text it runs as code (the value would be interpreted,
 * which the no-shell mode exists to prevent). A placeholder in a separate argument after the code stays allowed. Best-effort denylist: wrappers
 * (env, sudo, xargs, ssh, docker, ...) and programs missing from INTERPRETER_RULES are not detected (docs/subscribers.md).
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

  if (rule.codeUnless !== undefined) {
    const safe = args.some((token) => rule.codeUnless!.test(literalText(token)));
    if (!safe && args.some((token) => hasField(token))) {
      return `'${program}' runs its arguments as PowerShell code unless a script is given with -File, so a {{ }} placeholder would be run as code. ${fix}`;
    }
  }

  for (let i = 0; i < args.length; i++) {
    const text = literalText(args[i]!);
    const flag = rule.codeFlags.find((candidate) => candidate.pattern.test(text));
    if (flag === undefined) {
      continue;
    }
    const last = flag.scope === 'rest' ? args.length - 1 : flag.scope === 'next' ? i + 1 : i;
    for (let j = i; j <= last && j < args.length; j++) {
      if (hasField(args[j])) {
        return (
          `'${program}' runs the argument after '${text}' as code (${found.name === 'cmd' ? 'a command line' : 'a script'}), so a {{ }} placeholder there would be interpreted ` +
          `instead of staying data. ${fix}`
        );
      }
    }
    // The code is found; what follows is data for it (positional parameters)
    if (flag.scope !== 'rest') {
      return undefined;
    }
  }
  return undefined;
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

/** Replaces the placeholders of one argument with the payload values. A payload that is not an object has no field: every value is empty. */
export function substituteToken(token: TemplateToken, payload: unknown): SubstitutedArgument {
  let text = '';
  const fields: SubstitutedField[] = [];
  for (const part of token) {
    if (part.kind === 'literal') {
      text += part.text;
      continue;
    }
    // Own properties only: `{{ constructor }}` or `{{ toString }}` must not paste the source of an inherited function
    const raw = typeof payload === 'object' && payload !== null && Object.hasOwn(payload, part.field) ? Reflect.get(payload, part.field) : undefined;
    const value = valueToArgument(raw);
    fields.push({ field: part.field, value });
    text += value;
  }
  return { text, fields };
}
