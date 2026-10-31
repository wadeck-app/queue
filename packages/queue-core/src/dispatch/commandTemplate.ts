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
