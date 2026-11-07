import { afterEach, describe, it, expect } from 'vitest';
import { CommandTemplateError, findCmdMetacharacter, findTemplateProblem, hasPlaceholders, substituteToken, tokenizeTemplate, valueToArgument } from './commandTemplate.js';

/** Argument texts of a template once the placeholders are replaced by the payload values. */
function argv(template: string, payload: unknown = {}): string[] {
  return tokenizeTemplate(template).map((token) => substituteToken(token, payload).text);
}

describe('tokenizeTemplate - quoting rules', () => {
  it.each([
    ['plain words', 'a b  c', ['a', 'b', 'c']],
    ['tabs and newlines separate', 'a\tb\nc', ['a', 'b', 'c']],
    ['leading and trailing whitespace', '  a  ', ['a']],
    ['single quotes group and are literal', "a 'b  c' d", ['a', 'b  c', 'd']],
    ['double quotes group', 'a "b  c" d', ['a', 'b  c', 'd']],
    ['quotes join adjacent text into one argument', `--msg="a b"c`, ['--msg=a bc']],
    ['empty double quotes are an empty argument', 'a "" b', ['a', '', 'b']],
    ['empty single quotes are an empty argument', "a '' b", ['a', '', 'b']],
    ['a double quote in single quotes is literal', `'say "hi"'`, ['say "hi"']],
    ['a single quote in double quotes is literal', `"it's"`, ["it's"]],
    ['backslash-quote is a literal double quote inside double quotes', '"a \\"b\\" c"', ['a "b" c']],
    ['backslash-quote is a literal double quote outside quotes', 'a \\"b', ['a', '"b']],
    ['other backslashes are literal (Windows paths)', 'C:\\Users\\me\\tool.exe \\\\server\\share', ['C:\\Users\\me\\tool.exe', '\\\\server\\share']],
    ['backslash in single quotes is literal', "'a\\'", ['a\\']],
    ['shell operators are plain text here', 'a | b && c', ['a', '|', 'b', '&&', 'c']],
  ])('%s', (_label, template, expected) => {
    expect(argv(template)).toEqual(expected);
  });

  it('keeps a placeholder with inner spaces in one argument', () => {
    expect(argv('run {{ payload.a }} {{b}} "{{  c  }}"', { a: '1', b: '2', c: '3' })).toEqual(['run', '1', '2', '3']);
  });

  it('substitutes inside quotes, and inside single quotes too', () => {
    expect(argv(`x '{{ a }}' "pre-{{ a }}-post"`, { a: 'v' })).toEqual(['x', 'v', 'pre-v-post']);
  });

  it('a value with spaces and quotes stays one argument', () => {
    expect(argv('x {{ a }} y', { a: 'one two "three" \'four\'' })).toEqual(['x', 'one two "three" \'four\'', 'y']);
  });

  it('an empty value stays an (empty) argument', () => {
    expect(argv('x {{ a }} y', { a: '' })).toEqual(['x', '', 'y']);
  });

  it.each([
    ['single', "a 'b", /unterminated single quote/],
    ['double', 'a "b', /unterminated double quote/],
    ['a double quote left open by a trailing backslash-quote', '"C:\\dir\\"', /unterminated double quote/],
  ])('an unterminated %s quote is an error that says how to fix it', (_label, template, pattern) => {
    expect(() => tokenizeTemplate(template)).toThrow(pattern);
    expect(() => tokenizeTemplate(template)).toThrow(CommandTemplateError);
    expect(() => tokenizeTemplate(template)).toThrow(/Fix:/);
  });
});

describe('substituteToken', () => {
  it('strips the optional payload. prefix; an own key named like the whole dotted path is read first', () => {
    expect(argv('x {{ payload.a }} {{ a }} {{ a.b }}', { a: 1, 'a.b': 'dotted' })).toEqual(['x', '1', '1', 'dotted']);
  });

  describe('nested paths', () => {
    it('an own dotted key wins over the nesting it could also mean', () => {
      expect(argv('{{ a.b }}|{{ payload.a.b }}', { 'a.b': 'x', a: { b: 'y' } })).toEqual(['x|x']);
    });

    it('without such a key, walks the own properties segment by segment (this used to render empty)', () => {
      expect(argv('{{ a.b }}|{{ payload.a.b.c }}|{{ a.b.c }}', { a: { b: { c: 1 } } })).toEqual(['{"c":1}|1|1']);
      expect(argv('{{ a.b }}', { a: { b: 1 } })).toEqual(['1']);
    });

    it('a dotted key below level one is not tried', () => {
      expect(argv('[{{ a.b.c }}]', { a: { 'b.c': 'hidden' } })).toEqual(['[]']);
    });

    it('a missing step, a step through a primitive or null gives an empty string', () => {
      expect(argv('[{{ a.x.y }}][{{ s.length }}][{{ n.z }}]', { a: {}, s: 'text', n: null })).toEqual(['[][][]']);
    });

    it('an object at the end is JSON, as for a top-level field', () => {
      expect(argv('{{ a.b }}', { a: { b: { k: [1] } } })).toEqual(['{"k":[1]}']);
    });

    it('an array answers its index segments, not its length or its methods', () => {
      expect(argv('{{ list.0 }}|{{ list.1.n }}|{{ list.5 }}|[{{ list.length }}]|[{{ list.map }}]', { list: ['a', { n: 2 }] })).toEqual(['a|2||[]|[]']);
    });

    it.each(['__proto__', 'constructor', 'prototype'])('never reads %s, even from an own property or in the middle of a path', (segment) => {
      const payload = JSON.parse(`{"${segment}": {"x": "leak"}, "a": {"${segment}": {"x": "leak"}}}`) as unknown;
      expect(argv(`[{{ ${segment} }}][{{ ${segment}.x }}][{{ a.${segment}.x }}]`, payload)).toEqual(['[][][]']);
    });

    it('findTemplateProblem refuses such a segment at load time and says what to do', () => {
      for (const segment of ['__proto__', 'constructor', 'prototype']) {
        for (const placeholder of [`{{ ${segment} }}`, `{{ payload.a.${segment}.b }}`]) {
          expect(findTemplateProblem(`tool ${placeholder}`)).toMatch(new RegExp(`'${segment}' is never read from a payload.*Fix: use another payload key`));
        }
      }
      expect(findTemplateProblem('tool {{ a.b.c }} {{ payload.constructors }} {{ myconstructor }}')).toBeUndefined();
    });

    it('substituteToken stays pure: a reference is resolved only through the callback of the caller', () => {
      const token = tokenizeTemplate('{{ payload.original.taskId }}')[0]!;
      const payload = { original: { $eventRef: 'ev-1' } };
      expect(substituteToken(token, payload).text).toBe('');
      const calls: unknown[][] = [];
      const substituted = substituteToken(token, payload, { resolveRef: (ref, walked) => { calls.push([ref, walked]); return { taskId: 42 }; } });
      expect(substituted).toEqual({ text: '42', fields: [{ field: 'original.taskId', value: '42' }] });
      expect(calls).toEqual([['ev-1', ['original']]]);
    });
  });

  it('a missing field, a null field and a payload that is not an object give an empty string', () => {
    expect(argv('x {{ a }} {{ n }}', { n: null })).toEqual(['x', '', '']);
    expect(argv('x {{ a }}', 'text')).toEqual(['x', '']);
    expect(argv('x {{ a }}', null)).toEqual(['x', '']);
  });

  it('does not read inherited properties (no function source pasted for {{ constructor }} or {{ toString }})', () => {
    expect(argv('x {{ constructor }} {{ toString }} {{ __proto__ }}', { a: 1 })).toEqual(['x', '', '', '']);
  });

  it('turns objects and arrays into one JSON argument and primitives into their text', () => {
    expect(valueToArgument({ a: [1, 'b'] })).toBe('{"a":[1,"b"]}');
    expect(valueToArgument([1, 2])).toBe('[1,2]');
    expect(valueToArgument(true)).toBe('true');
    expect(valueToArgument(0)).toBe('0');
    expect(valueToArgument(undefined)).toBe('');
  });

  it('reports which fields were substituted', () => {
    const [token] = tokenizeTemplate('--k={{ a }}-{{ b }}');
    expect(substituteToken(token!, { a: 'x', b: 'y' }).fields).toEqual([{ field: 'a', value: 'x' }, { field: 'b', value: 'y' }]);
  });
});

describe('hasPlaceholders', () => {
  it.each([
    ['{{ a }}', true],
    ['x {{payload.a}}', true],
    ['x {{ a-b }}', false],
    ['x {{ a', false],
    ['echo plain | sort', false],
  ])('%s -> %s', (command, expected) => {
    expect(hasPlaceholders(command)).toBe(expected);
  });
});

describe('findTemplateProblem (load-time guard)', () => {
  it('ignores a command without placeholders, whatever shell syntax it holds', () => {
    expect(findTemplateProblem('echo a | sort > f && echo $HOME `date` %PATH% "unterminated')).toBeUndefined();
  });

  it('accepts a placeholder with plain arguments', () => {
    expect(findTemplateProblem('flow run triage.yml --input taskId={{ payload.taskId }}')).toBeUndefined();
  });

  it.each([
    ['|', 'a {{ x }} | b'],
    ['||', 'a {{ x }} || b'],
    ['&', 'a {{ x }} & b'],
    ['&&', 'a {{ x }} && b'],
    [';', 'a {{ x }}; b'],
    ['>', 'a {{ x }} > f'],
    ['>>', 'a {{ x }} >> f'],
    ['<', 'a {{ x }} < f'],
    ['a backtick', 'a {{ x }} `b`'],
    ['a backtick in double quotes', 'a {{ x }} "`b`"'],
    ['$(', 'a {{ x }} $(b)'],
    ['$( in double quotes', 'a {{ x }} "$(b)"'],
    ['%VAR%', 'a {{ x }} %PATH%'],
    ['$VAR', 'a {{ x }} $HOME'],
    ['${VAR}', 'a {{ x }} ${HOME}'],
  ])('rejects %s next to a placeholder', (_label, command) => {
    const problem = findTemplateProblem(command);
    expect(problem).toBeDefined();
    expect(problem).toContain('stdin');
    expect(problem).toContain('Fix:');
  });

  it.each([
    ['single quotes', "a {{ x }} '| & ; > < ` $( ) %PATH% $HOME'"],
    ['double quotes (operators only)', 'a {{ x }} "| & ; > <"'],
  ])('accepts operators inside %s', (_label, command) => {
    expect(findTemplateProblem(command)).toBeUndefined();
  });

  it('rejects a placeholder as the program', () => {
    expect(findTemplateProblem('{{ x }} arg')).toMatch(/program position/);
    expect(findTemplateProblem('"{{ x }}" arg')).toMatch(/program position/);
  });

  it('rejects an unterminated quote', () => {
    expect(findTemplateProblem('a "{{ x }}')).toMatch(/unterminated/);
  });
});

describe('findTemplateProblem - shells and interpreters (value would land in code)', () => {
  it.each([
    ['bash -c', `bash -c 'echo {{ x }}'`],
    ['bash -c, double quotes', 'bash -c "echo {{ x }}"'],
    ['bash -c, placeholder alone', 'bash -c {{ x }}'],
    ['bash -lc', `bash -lc 'echo {{ x }}'`],
    ['bash -x -c', `bash -x -c 'echo {{ x }}'`],
    ['bash -o pipefail -c', `bash -o pipefail -c 'echo {{ x }}'`],
    ['sh -c', `sh -c 'echo {{ x }}'`],
    ['zsh -c', `zsh -c 'echo {{ x }}'`],
    ['fish --command', `fish --command 'echo {{ x }}'`],
    ['absolute path', `/usr/bin/bash -c 'echo {{ x }}'`],
    ['quoted absolute Windows path with .exe', `"C:\\Program Files\\Git\\bin\\bash.exe" -c 'echo {{ x }}'`],
    ['cmd /c', 'cmd /c echo {{ x }}'],
    ['cmd.exe /d /s /c', 'cmd.exe /d /s /c "echo {{ x }}"'],
    ['cmd /k', 'cmd /k echo {{ x }}'],
    ['cmd /c, placeholder in a later argument (joined into the command line)', 'cmd /c echo hello {{ x }}'],
    ['powershell -Command', 'powershell -Command "Write-Host {{ x }}"'],
    ['powershell -c', 'powershell -c "Write-Host {{ x }}"'],
    ['pwsh -c', 'pwsh -c "Write-Host {{ x }}"'],
    ['pwsh -NoProfile -Command', 'pwsh -NoProfile -Command Write-Host {{ x }}'],
    ['pwsh without -Command (implicit command)', 'pwsh Write-Host {{ x }}'],
    ['pwsh -EncodedCommand', 'pwsh -EncodedCommand {{ x }}'],
    ['node -e', 'node -e "console.log({{ x }})"'],
    ['node -p', 'node -p "{{ x }}"'],
    ['node --eval', 'node --eval "{{ x }}"'],
    ['node --eval=', 'node --eval={{ x }}'],
    ['bun -e', 'bun -e "{{ x }}"'],
    ['deno eval', 'deno eval "{{ x }}"'],
    ['python -c', `python -c 'print("{{ x }}")'`],
    ['python3.11 -c', `python3.11 -c 'print("{{ x }}")'`],
    ['py -c', `py -c 'print("{{ x }}")'`],
    ['perl -e', `perl -e 'print "{{ x }}"'`],
    ['perl -lne', `perl -lne 'print "{{ x }}"'`],
    ['ruby -e', `ruby -e 'puts "{{ x }}"'`],
    ['php -r', `php -r 'echo "{{ x }}";'`],
    ['lua -e', `lua -e 'print("{{ x }}")'`],
    ['Rscript -e', `Rscript -e 'cat("{{ x }}")'`],
    ['osascript -e', `osascript -e 'say "{{ x }}"'`],
  ])('rejects %s', (_label, command) => {
    const problem = findTemplateProblem(command);
    expect(problem).toBeDefined();
    expect(problem).toContain('Fix:');
    expect(problem).toContain('best-effort');
  });

  it('names the program as written and shows the safe form', () => {
    const problem = findTemplateProblem(`bash -c 'echo {{ x }}'`);
    expect(problem).toContain("'bash'");
    expect(problem).toContain(`bash -c 'echo "$1"' _ {{ x }}`);
    expect(findTemplateProblem('node -e "{{ x }}"')).toContain('process.argv[1]');
    expect(findTemplateProblem('cmd /c echo {{ x }}')).toContain('stdin');
  });

  it.each([
    ['bash -c', `bash -c 'echo "$1"' _ {{ x }}`],
    ['bash -c, several positional arguments', `bash -c 'echo "$1" "$2"' _ {{ x }} {{ y }}`],
    ['bash -c, a later literal -c is data', `bash -c 'echo "$@"' _ -c {{ x }}`],
    ['sh -c', `sh -c 'echo "$1"' _ {{ x }}`],
    ['node -e', 'node -e "console.log(process.argv[1])" {{ x }}'],
    ['node script', 'node script.js --id {{ x }}'],
    ['node --eval=', 'node --eval=console.log(1) {{ x }}'],
    ['python -c', `python -c 'import sys; print(sys.argv[1])' {{ x }}`],
    ['python script', 'python script.py {{ x }}'],
    ['perl -e', `perl -e 'print $ARGV[0]' {{ x }}`],
    ['ruby -e', `ruby -e 'puts ARGV[0]' {{ x }}`],
    ['php -r', `php -r 'echo $argv[1];' -- {{ x }}`],
    ['pwsh -File', 'pwsh -NoProfile -File script.ps1 {{ x }}'],
    ['powershell -File', 'powershell -File script.ps1 --id {{ x }}'],
    ['cmd without a command flag', 'cmd /d {{ x }}'],
    ['a shell name as an argument, not as the program', 'tool bash -c {{ x }}'],
    ['a program whose name only starts like a shell', 'bashful -c {{ x }}'],
    ['a code flag with literal-only code', `bash -c 'echo hi'`],
    ['an inherited property name as the program', 'constructor -c {{ x }}'],
  ])('accepts %s', (_label, command) => {
    expect(findTemplateProblem(command)).toBeUndefined();
  });

  it('ignores a command without placeholders (it runs in a shell as written)', () => {
    expect(findTemplateProblem(`bash -c 'echo hi'`)).toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')('Windows only: matches the program and the cmd/PowerShell flags case-insensitively', () => {
    expect(findTemplateProblem('BASH.EXE -c "{{ x }}"')).toBeDefined();
    expect(findTemplateProblem('CMD.EXE /C echo {{ x }}')).toBeDefined();
    expect(findTemplateProblem('PowerShell.exe -COMMAND "{{ x }}"')).toBeDefined();
    expect(findTemplateProblem('C:\\Windows\\System32\\cmd.EXE /c echo {{ x }}')).toBeDefined();
  });

  it.skipIf(process.platform === 'win32')('POSIX only: program names are case-sensitive', () => {
    expect(findTemplateProblem('BASH -c "{{ x }}"')).toBeUndefined();
  });

  it('matches cmd and PowerShell flags case-insensitively on every platform', () => {
    expect(findTemplateProblem('cmd /C echo {{ x }}')).toBeDefined();
    expect(findTemplateProblem('pwsh -COMMAND "{{ x }}"')).toBeDefined();
  });
});

describe('findCmdMetacharacter', () => {
  it.each(['&', '|', '<', '>', '^', '%', '!', '"', '`', '\r', '\n'])('flags %j', (char) => {
    expect(findCmdMetacharacter(`ab${char}cd`)).toBeDefined();
  });

  it('accepts ordinary text, spaces, unicode and shell characters cmd ignores', () => {
    expect(findCmdMetacharacter("hello world ünï 😀 a=b *.txt $(x) ; ' ( ) { } ~ #")).toBeUndefined();
  });
});

describe('findTemplateProblem - program names keep their case outside Windows', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  // Rscript is the real (mixed-case) name of the binary: the rule must match it on POSIX, where names are not lowercased
  it.each(['linux', 'darwin', 'win32'])('rejects Rscript -e on %s', (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    expect(findTemplateProblem(`Rscript -e 'cat("{{ x }}")'`)).toContain('Fix:');
  });
});
