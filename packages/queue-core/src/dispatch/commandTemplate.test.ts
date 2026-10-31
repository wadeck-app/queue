import { describe, it, expect } from 'vitest';
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
  it('strips the optional payload. prefix and takes only top-level keys', () => {
    expect(argv('x {{ payload.a }} {{ a }} {{ a.b }}', { a: 1, 'a.b': 'dotted' })).toEqual(['x', '1', '1', 'dotted']);
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

describe('findCmdMetacharacter', () => {
  it.each(['&', '|', '<', '>', '^', '%', '!', '"', '`', '\r', '\n'])('flags %j', (char) => {
    expect(findCmdMetacharacter(`ab${char}cd`)).toBeDefined();
  });

  it('accepts ordinary text, spaces, unicode and shell characters cmd ignores', () => {
    expect(findCmdMetacharacter("hello world ünï 😀 a=b *.txt $(x) ; ' ( ) { } ~ #")).toBeUndefined();
  });
});
