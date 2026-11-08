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

/** Which arguments a code flag turns into code: `self` the flag token only (`--eval=...`), `next` the flag and the argument after it. */
type CodeScope = 'self' | 'next';

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
  /** The rule applies only when the first non-option argument is one of `subcommands` (`npm exec`, but not `npm view`). */
  subcommandRequired?: boolean;
  /** Subcommands after which EVERY positional argument names a package to install (`npm install a b`): a placeholder anywhere after one is refused. */
  allPositionalSubcommands?: ReadonlySet<string>;
  /** The program has no safe form for a payload value in any argument (cmd.exe, mshta): any placeholder is refused. */
  refuseAnyPlaceholder?: boolean;
  /** Prefixes, besides `-`, that make an argument an option (`+x` of POSIX shells, `//B` of the Windows script hosts). */
  optionPrefixes?: ReadonlyArray<string>;
  /**
   * Closed list of the options that take NO value (strict mode): an option that is in neither this pattern, `valueOptions` nor written `--name=value`
   * could take the next argument as its value, so the position of the package or script is unknown; a placeholder after it is refused.
   */
  knownFlags?: RegExp;
  /** The program runs another program given as argument: `env prog`, `busybox applet`. The rule is then applied to that program. */
  wrapper?: 'env' | 'busybox';
  /** A script file name of this program, for the example of the error. */
  scriptName?: string;
  /** Example of the form the error recommends, when `program script {{ x }}` does not fit. */
  example?: string;
  /** PowerShell: a placeholder is accepted only after `-File <literal script>` (see findPowerShellProblem). */
  powershell?: boolean;
  /** The safe form shown in the error. */
  safeForm: string;
}

const GENERIC_EVAL_SAFE_FORM = (example: string): string => `pass the value as a separate argument after the code and read it from the program's argument list, e.g. ${example}`;

const POSIX_SHELL_RULE: InterpreterRule = {
  // -c, -lc, -ec, ... (a lowercase c in an option cluster, text may follow it); fish also accepts --command
  codeFlags: [{ pattern: /^(?:-[A-Za-z]*c|--command)/, scope: 'next' }],
  // +o and +O take a value like -o and -O; every shell reads +x as an option too
  valueOptions: new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']),
  optionPrefixes: ['+'],
  safeForm: `pass the value as a separate argument after the script and read it as a positional parameter, e.g. bash -c 'echo "$1"' _ {{ x }}`,
};

const NODE_RULE: InterpreterRule = {
  codeFlags: [
    { pattern: /^--(?:eval|print)=/, scope: 'self' },
    { pattern: /^(?:-e|-p|--eval|--print)/, scope: 'next' },
  ],
  valueOptions: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title']),
  scriptName: 'script.js',
  safeForm: GENERIC_EVAL_SAFE_FORM('node -e "console.log(process.argv[1])" {{ x }}'),
};

/** Options of npm that take no value (from the config definitions of npm 11), plus the short clusters. Anything else is unknown (strict mode). */
const NPM_FLAGS = new RegExp(
  '^(?:--?|' +
    '-(?:[aflgSBDEOPvhHynsqd?]+|ws|iwr)|' +
    '--(?:no-[\\w-]+|all|allow-same-version|audit|bin-links|dangerously-allow-all-scripts|description|dev|dry-run|engine-strict|force|foreground-scripts|' +
    'format-package-lock|fund|git-tag-version|global|global-style|if-present|ignore-scripts|include-staged|include-workspace-root|include-attestations|' +
    'init-private|install-links|json|legacy-bundling|legacy-peer-deps|link|long|offline|omit-lockfile-registry-resolved|package-lock|package-lock-only|' +
    'parseable|prefer-dedupe|prefer-offline|prefer-online|progress|provenance|read-only|rebuild-bundle|save|save-bundle|save-dev|save-exact|save-optional|' +
    'save-peer|save-prod|shrinkwrap|sign-git-commit|sign-git-tag|strict-peer-deps|strict-allow-scripts|strict-ssl|timing|unicode|update-notifier|usage|' +
    'version|versions|workspaces|yes|color|optional|production|silent|quiet|verbose|help|ignore-existing|no-install))$'
);

/** Options of npm that take their value as the next argument (config definitions of npm 11). */
const NPM_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-p', '--package', '-w', '--workspace', '-C', '--prefix', '-L', '--location', '-m', '--message',
  ...[
    '_auth', 'access', 'allow-directory', 'allow-file', 'allow-git', 'allow-remote', 'allow-scripts', 'also', 'audit-level', 'auth-type', 'before', 'browser',
    'ca', 'cache', 'cache-max', 'cache-min', 'cafile', 'cert', 'cidr', 'cpu', 'depth', 'diff', 'diff-dst-prefix', 'diff-src-prefix', 'diff-unified', 'editor',
    'expect-result-count', 'expect-results', 'expires', 'fetch-retries', 'fetch-retry-factor', 'fetch-retry-maxtimeout', 'fetch-retry-mintimeout',
    'fetch-timeout', 'git', 'globalconfig', 'heading', 'https-proxy', 'include', 'init-author-email', 'init-author-name', 'init-author-url', 'init-license',
    'init-module', 'init-type', 'init-version', 'init.author.email', 'init.author.name', 'init.author.url', 'init.license', 'init.module', 'init.version',
    'install-strategy', 'key', 'libc', 'local-address', 'lockfile-version', 'loglevel', 'logs-dir', 'logs-max', 'name', 'maxsockets', 'min-release-age',
    'min-release-age-exclude', 'node-gyp', 'node-options', 'noproxy', 'omit', 'only', 'orgs', 'os', 'otp', 'pack-destination', 'packages', 'preid',
    'provenance-file', 'proxy', 'registry', 'replace-registry-host', 'save-prefix', 'sbom-format', 'sbom-type', 'scope', 'scopes', 'script-shell',
    'searchexclude', 'searchlimit', 'searchopts', 'searchstaleness', 'shell', 'tag', 'tag-version-prefix', 'umask', 'user-agent', 'userconfig', 'viewer',
    'which', 'cwd',
  ].map((name) => `--${name}`),
]);

const PNPM_FLAGS = new RegExp(
  '^(?:--?|-[rwsDgPEOyn]+|--(?:no-[\\w-]+|recursive|workspace-root|silent|offline|prefer-offline|frozen-lockfile|ignore-scripts|global|dev|prod|production|' +
    'if-present|stream|parallel|sequential|color|help|version|fix-lockfile|shamefully-hoist|force|use-stderr|aggregate-output|report-summary|yes))$'
);

const YARN_FLAGS = new RegExp(
  '^(?:--?|-[sDWgPEOy]+|--(?:no-[\\w-]+|silent|verbose|offline|prefer-offline|frozen-lockfile|ignore-scripts|dev|peer|optional|exact|tilde|json|' +
    'immutable|check-cache|help|version|production|ignore-engines|ignore-platform|non-interactive|no-progress|force|flat|pure-lockfile|skip-integrity-check))$'
);

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
  // cmd.exe reads /c, /k, /r (any case, also attached to other switches) anywhere in its arguments and joins all of them into one command line
  cmd: {
    codeFlags: [],
    refuseAnyPlaceholder: true,
    safeForm: 'cmd.exe has no safe way to receive a value; start a real program or a script file instead (e.g. node script.js {{ x }}), or read the event envelope on stdin',
  },
  mshta: {
    codeFlags: [],
    refuseAnyPlaceholder: true,
    safeForm: 'mshta runs its argument as an HTML application or inline script and has no data argument; run a script with cscript (cscript //nologo script.vbs {{ x }}) or read the event envelope on stdin',
  },
  wscript: {
    codeFlags: [],
    optionPrefixes: ['//'],
    scriptName: 'script.vbs',
    safeForm: 'name the script literally and pass the value after it (wscript script.vbs {{ x }}), or read the event envelope on stdin',
  },
  busybox: {
    codeFlags: [],
    wrapper: 'busybox',
    safeForm: 'name the applet literally (busybox sh script.sh {{ x }}), or read the event envelope on stdin',
  },
  env: {
    codeFlags: [],
    wrapper: 'env',
    safeForm: 'name the program literally after env and follow the rules of that program (env bash script.sh {{ x }}), or read the event envelope on stdin',
  },
  // awk runs its first non-option argument as a program; -f names a program file
  awk: {
    codeFlags: [{ pattern: /^(?:-f|-e|--file|--source)/, scope: 'next' }],
    valueOptions: new Set(['-F', '-v', '-i', '-l', '-E']),
    scriptName: 'prog.awk',
    safeForm: GENERIC_EVAL_SAFE_FORM(`awk 'BEGIN { print ARGV[1] }' {{ x }}`),
  },
  powershell: {
    codeFlags: [],
    powershell: true,
    safeForm: 'start the command with -File and a literal script path, and put the placeholder after it, e.g. powershell -NoProfile -File script.ps1 {{ x }}, or read the event envelope on stdin',
  },
  node: NODE_RULE,
  tsx: { ...NODE_RULE, valueOptions: new Set([...NODE_RULE.valueOptions!, '--tsconfig']), scriptName: 'script.ts', safeForm: GENERIC_EVAL_SAFE_FORM('tsx -e "console.log(process.argv[1])" {{ x }}') },
  'ts-node': { ...NODE_RULE, scriptName: 'script.ts', safeForm: GENERIC_EVAL_SAFE_FORM('ts-node -e "console.log(process.argv[1])" {{ x }}') },
  bun: {
    codeFlags: [
      { pattern: /^--(?:eval|print)=/, scope: 'self' },
      { pattern: /^(?:-e|-p|--eval|--print)/, scope: 'next' },
    ],
    valueOptions: new Set(['-r', '--preload', '--import', '--cwd', '--config', '-c']),
    subcommands: new Set(['run', 'x', 'exec', 'create']),
    allPositionalSubcommands: new Set(['add', 'a', 'install', 'i']),
    scriptName: 'script.ts',
    safeForm: GENERIC_EVAL_SAFE_FORM('bun -e "console.log(process.argv[2])" {{ x }}'),
  },
  deno: {
    codeFlags: [{ pattern: /^eval$/, scope: 'next' }],
    // -c/--config and the like take their value as the next argument; x runs a package, install installs a script
    valueOptions: new Set(['-c', '--config', '--import-map', '--lock', '--cert', '--location', '--env-file', '--v8-flags', '--seed', '--tsconfig']),
    subcommands: new Set(['run', 'test', 'bench', 'task', 'serve', 'repl', 'x', 'install']),
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
    valueOptions: NPM_VALUE_OPTIONS,
    knownFlags: NPM_FLAGS,
    safeForm: 'name the package literally and pass the value after it (npx some-tool {{ x }}), or read the event envelope on stdin',
  },
  // init/create run create-<name>; run runs the script <name> of the package.json: the first argument after them is chosen by the payload
  npm: {
    codeFlags: [{ pattern: /^(?:-c|--call)/, scope: 'next' }],
    valueOptions: NPM_VALUE_OPTIONS,
    knownFlags: NPM_FLAGS,
    subcommands: new Set(['exec', 'x', 'init', 'create', 'innit', 'run', 'run-script', 'rum', 'urn']),
    allPositionalSubcommands: new Set(['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'install-test', 'it']),
    subcommandRequired: true,
    example: 'npm exec some-tool -- {{ x }}',
    safeForm: 'name the package or script literally and pass the value after it (npm exec some-tool -- {{ x }}), or read the event envelope on stdin',
  },
  pnpm: {
    codeFlags: [],
    valueOptions: new Set(['-C', '--dir', '-F', '--filter', '--filter-prod', '--reporter', '--registry', '--loglevel', '--store-dir', '--config', '--workspace-concurrency', '--resume-from', '--test-pattern']),
    knownFlags: PNPM_FLAGS,
    subcommands: new Set(['exec', 'dlx', 'create', 'run', 'run-script', 'x', 'node', 'init']),
    allPositionalSubcommands: new Set(['add', 'install', 'i']),
    example: 'pnpm exec some-tool {{ x }}',
    safeForm: 'name the script, package or tool literally and pass the value after it (pnpm exec some-tool {{ x }}), or read the event envelope on stdin',
  },
  yarn: {
    codeFlags: [],
    valueOptions: new Set(['--cwd', '--registry', '--network-timeout', '--modules-folder', '--cache-folder', '--mutex', '--link-folder', '--use-yarnrc', '--emoji']),
    knownFlags: YARN_FLAGS,
    subcommands: new Set(['exec', 'dlx', 'create', 'run', 'node', 'init']),
    allPositionalSubcommands: new Set(['add']),
    example: 'yarn exec some-tool {{ x }}',
    safeForm: 'name the script, package or tool literally and pass the value after it (yarn exec some-tool {{ x }}), or read the event envelope on stdin',
  },
};

/** Other names of a rule, by pattern on the normalised (lowercase) program name (versioned or suffixed binaries). */
const INTERPRETER_ALIASES: ReadonlyArray<{ pattern: RegExp; rule: string }> = [
  { pattern: /^(?:python|pypy)[\d.]*w?$/, rule: 'python' },
  { pattern: /^py$/, rule: 'python' },
  { pattern: /^pwsh(?:-preview)?$/, rule: 'powershell' },
  { pattern: /^powershell_ise$/, rule: 'powershell' },
  { pattern: /^nodejs$/, rule: 'node' },
  { pattern: /^cscript$/, rule: 'wscript' },
  { pattern: /^(?:gawk|mawk|nawk)$/, rule: 'awk' },
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

/** A version glued to the name: `node18`, `perl5.36`, `lua5.4`, `php8.2`, `bash-5`. */
const VERSION_SUFFIX = /[-_]?\d[\d.]*$/;

function findInterpreterRule(program: string): { name: string; rule: InterpreterRule } | undefined {
  const base = normalizeProgramName(program);
  const stripped = base.replace(VERSION_SUFFIX, '');
  for (const name of stripped === base || stripped === '' ? [base] : [base, stripped]) {
    // Own keys only: a program named `constructor` or `toString` is not a rule
    if (Object.hasOwn(INTERPRETER_RULES, name)) {
      return { name, rule: INTERPRETER_RULES[name]! };
    }
    const alias = INTERPRETER_ALIASES.find((entry) => entry.pattern.test(name));
    if (alias !== undefined) {
      return { name, rule: INTERPRETER_RULES[alias.rule]! };
    }
  }
  return undefined;
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
  if (rule.refuseAnyPlaceholder === true) {
    return args.some((token) => hasField(token))
      ? `'${program}' would read a {{ }} placeholder as part of a command line or a document it runs, whatever the position and the quoting, so no placeholder is accepted in this command. ${fix}`
      : undefined;
  }
  if (rule.wrapper !== undefined) {
    return findWrapperProblem(program, rule.wrapper, args, fix);
  }

  const isOption = (text: string): boolean => text.startsWith('-') || (rule.optionPrefixes?.some((prefix) => text.startsWith(prefix)) ?? false);
  let subcommandSeen = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const text = literalText(token);
    const flag = rule.codeFlags.find((candidate) => candidate.pattern.test(text));
    if (flag !== undefined) {
      const last = flag.scope === 'next' ? i + 1 : i;
      for (let j = i; j <= last && j < args.length; j++) {
        if (hasField(args[j])) {
          return (
            `'${program}' reads '${text}' and ${flag.scope === 'next' ? 'the argument after it' : 'it'} as code (a script), so a {{ }} placeholder there would be interpreted ` +
            `instead of staying data. ${fix}`
          );
        }
      }
      // The code is found and holds no placeholder; what follows is data for it (positional parameters)
      return undefined;
    }

    if (isOption(text)) {
      if (hasField(token)) {
        return positionProblem(program, rule, `in the option '${text}'`, fix);
      }
      if (rule.valueOptions?.has(text) === true) {
        if (i + 1 < args.length) {
          if (hasField(args[i + 1])) {
            return positionProblem(program, rule, `as the value of '${text}'`, fix);
          }
          i++;
        }
        continue;
      }
      if (rule.knownFlags !== undefined && !text.includes('=') && !rule.knownFlags.test(text) && args.slice(i + 1).some((later) => hasField(later))) {
        return (
          `'${program}' is followed by the option '${text}', which this check does not know: it cannot tell whether the option takes the next argument as its value, ` +
          `so it cannot tell where the package or script starts, and a {{ }} placeholder after it might be run as one. ` +
          `Fix: write the option as ${text}=value if it takes a value, or remove it, or name the package or script before the placeholder. ${fix}`
        );
      }
      continue;
    }

    // First argument that is not an option: the script (or a subcommand in front of it)
    if (hasField(token)) {
      return positionProblem(program, rule, 'where the script is expected', fix);
    }
    if (!subcommandSeen && rule.allPositionalSubcommands?.has(text) === true) {
      if (args.slice(i + 1).some((later) => hasField(later))) {
        return (
          `a {{ }} placeholder follows '${program} ${text}', where every argument names a package to install (and install scripts run code). ` +
          `A payload value must not choose what gets installed. ${fix}`
        );
      }
      return undefined;
    }
    if (rule.subcommands?.has(text) === true && !subcommandSeen) {
      subcommandSeen = true;
      continue;
    }
    // A literal script (or a subcommand that does not run what follows): everything after it is data
    return undefined;
  }
  return undefined;
}

/** Switches of `env` that take the next argument as their value. */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir']);

/**
 * `env prog args` and `busybox applet args` run the next word as a program: a placeholder there lets the payload choose the program, and a known
 * shell or interpreter behind them is checked as if it were the program of the command.
 */
function findWrapperProblem(program: string, wrapper: 'env' | 'busybox', args: TemplateToken[], fix: string): string | undefined {
  const chosen = (): string => `a {{ }} placeholder is where '${program}' reads the program to run. A payload value must never choose which program runs. ${fix}`;
  let i = 0;
  if (wrapper === 'env') {
    for (; i < args.length; i++) {
      const token = args[i]!;
      const text = literalText(token);
      if (/^(?:-S|--split-string)/.test(text)) {
        // -S splits its value into a command line (program and arguments)
        return hasField(token) || hasField(args[i + 1])
          ? `'${program}' ${text.startsWith('--') ? '--split-string' : '-S'} splits its value into a command line, so a {{ }} placeholder in it would be parsed as program and arguments. ${fix}`
          : undefined;
      }
      if (text === '--') {
        i++;
        break;
      }
      if (text.startsWith('-') && text !== '-') {
        if (ENV_VALUE_OPTIONS.has(text)) {
          i++;
        }
        continue;
      }
      // NAME=value sets a variable and is data; anything else (also a placeholder, which reads as empty text) is the program
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
        break;
      }
    }
  }
  const next = args[i];
  if (next === undefined) {
    return undefined;
  }
  if (hasField(next)) {
    return chosen();
  }
  return findInterpreterProblem(args.slice(i));
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
