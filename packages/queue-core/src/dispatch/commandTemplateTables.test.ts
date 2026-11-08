import { describe, it, expect } from 'vitest';
import { findTemplateProblem } from './commandTemplate.js';

// The hazard tables of commandTemplate.ts (options that take a value, subcommands, install subcommands) are written out HERE a second time, on purpose: a test that
// walked the tables of the module would lose a case together with the entry that was removed from them. Each case pins one entry through what it changes:
//   - an option that takes a value consumes the next argument, so a placeholder AFTER that value is in script position (refused); if the entry is missing, the
//     value is taken for the script and the placeholder after it is data (accepted);
//   - a subcommand makes the next argument the script: `prog sub {{ x }}` is refused; if the entry is missing, `sub` is taken for the script;
//   - an install subcommand makes every later argument a package: `prog sub pkg {{ x }}` is refused; if the entry is missing, `sub` is taken for the script.

const SCRIPT_POSITION = /where the script is expected/;
const PACKAGES = /every argument names a package to install/;

/** Programs checked without a closed flag list: the option's value is skipped, the next argument is the script. */
const VALUE_OPTIONS: ReadonlyArray<[program: string, options: readonly string[]]> = [
  ['bash', ['-o', '-O', '+o', '+O', '--rcfile', '--init-file']],
  ['zsh', ['-o', '-O', '+o', '+O', '--rcfile', '--init-file']],
  ['node', ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title']],
  ['tsx', ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title', '--tsconfig']],
  ['ts-node', ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title']],
  ['bun', ['-r', '--preload', '--import', '--cwd', '--config', '-c']],
  ['deno', ['-c', '--config', '--import-map', '--lock', '--cert', '--location', '--env-file', '--v8-flags', '--seed', '--tsconfig']],
  ['python', ['-W', '-X', '--check-hash-based-pycs']],
  ['perl', ['-I', '-M', '-m']],
  ['ruby', ['-I', '-r', '-C']],
  ['awk', ['-F', '-v', '-i', '-l', '-E']],
  ['php', ['-c', '-d']],
  ['lua', ['-l']],
  ['osascript', ['-l']],
];

/** Programs with a closed list of flags (strict mode): an option missing from the value list is "unknown", which is refused when a placeholder follows. */
const STRICT_VALUE_OPTIONS: ReadonlyArray<[program: string, options: readonly string[]]> = [
  ['npx', [
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
  ]],
  ['pnpm', ['-C', '--dir', '-F', '--filter', '--filter-prod', '--reporter', '--registry', '--loglevel', '--store-dir', '--config', '--workspace-concurrency', '--resume-from', '--test-pattern']],
  ['yarn', ['--cwd', '--registry', '--network-timeout', '--modules-folder', '--cache-folder', '--mutex', '--link-folder', '--use-yarnrc', '--emoji']],
];

/** `prog sub {{ x }}` is refused: `sub` leads to a script, package or task chosen by the next argument. */
const SUBCOMMANDS: ReadonlyArray<[program: string, subcommands: readonly string[]]> = [
  ['bun', ['run', 'x', 'exec', 'create']],
  ['deno', ['run', 'test', 'bench', 'task', 'serve', 'repl', 'x', 'install']],
  ['npm', ['exec', 'x', 'init', 'create', 'innit', 'run', 'run-script', 'rum', 'urn']],
  ['pnpm', ['exec', 'dlx', 'create', 'run', 'run-script', 'x', 'node', 'init']],
  ['yarn', ['exec', 'dlx', 'create', 'run', 'node', 'init']],
];

/** `prog sub pkg {{ x }}` is refused: after `sub`, every argument names a package to install. */
const INSTALL_SUBCOMMANDS: ReadonlyArray<[program: string, subcommands: readonly string[]]> = [
  ['bun', ['add', 'a', 'install', 'i']],
  ['npm', ['install', 'i', 'add', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'install-test', 'it']],
  ['pnpm', ['add', 'install', 'i']],
  ['yarn', ['add']],
];

const cases = <T>(table: ReadonlyArray<[string, readonly string[]]>, make: (program: string, entry: string) => T): Array<[string, string, T]> =>
  table.flatMap(([program, entries]) => entries.map((entry): [string, string, T] => [program, entry, make(program, entry)]));

describe('an option that takes a value consumes the next argument, so the placeholder after it is in script position', () => {
  it.each(cases(VALUE_OPTIONS, (program, option) => `${program} ${option} value {{ x }}`))('%s %s', (_program, _option, command) => {
    expect(findTemplateProblem(command), command).toMatch(SCRIPT_POSITION);
  });
});

describe('the same, for programs with a closed list of flags: the option is known to take a value, so what follows it is the package and the placeholder is data', () => {
  it.each(cases(STRICT_VALUE_OPTIONS, (program, option) => `${program} ${option} value some-tool {{ x }}`))('%s %s', (_program, _option, command) => {
    expect(findTemplateProblem(command), command).toBeUndefined();
  });
});

describe('a subcommand leads to a script or package named by the next argument', () => {
  it.each(cases(SUBCOMMANDS, (program, subcommand) => `${program} ${subcommand} {{ x }}`))('%s %s', (_program, _subcommand, command) => {
    expect(findTemplateProblem(command), command).toMatch(SCRIPT_POSITION);
  });
});

describe('after an install subcommand every argument names a package', () => {
  it.each(cases(INSTALL_SUBCOMMANDS, (program, subcommand) => `${program} ${subcommand} some-package {{ x }}`))('%s %s', (_program, _subcommand, command) => {
    expect(findTemplateProblem(command), command).toMatch(PACKAGES);
  });
});
