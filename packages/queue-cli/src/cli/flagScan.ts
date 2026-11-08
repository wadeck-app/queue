import { nearestEventNames } from '@wadeck-app/queue-core';

/** What a command takes: the flags that need a value (some may repeat) and the ones that stand alone. */
export interface FlagSpec {
  values: readonly string[];
  /** The subset of `values` that may be given several times (the others are an error the second time: the first would win silently). */
  repeatable?: readonly string[];
  switches?: readonly string[];
  /** The sentence that follows "<flag> needs " when the value is missing; default "a value, e.g. <flag> <value>". */
  needs?: Readonly<Record<string, string>>;
}

export type FlagIssueKind = 'missing-value' | 'duplicate' | 'unknown' | 'stray';

export interface FlagIssue {
  kind: FlagIssueKind;
  message: string;
}

export interface FlagScan {
  /** Every value of each flag that was given, in order. */
  values: Map<string, string[]>;
  switches: Set<string>;
  issues: FlagIssue[];
  /** The words that are not a flag nor the value of one, in order (up to the number the command accepts; the rest are issues). */
  positionals: string[];
}

/** The flag of `known` that `flag` is most likely a typo of, undefined when none is close. */
export function nearestFlag(flag: string, known: readonly string[]): string | undefined {
  return nearestEventNames(flag, [...known])[0];
}

/** True when `next` cannot be the value of the flag before it: the arguments ended, it is empty, or it is another `--flag`. */
export function isMissingValue(next: string | undefined): boolean {
  return next === undefined || next === '' || next.startsWith('--');
}

/**
 * Reads the flags of one command: nothing is dropped silently. A flag without its value, a flag given twice, an option nobody knows (with the
 * near match) and a stray word (usually the second half of an unquoted value) each become an issue that says what to write.
 * `cmd` is the command as the user typed it ("queue sub add"), `wrongHere` the flags that exist elsewhere but not for this command.
 */
export function scanFlags(args: readonly string[], spec: FlagSpec, cmd: string, wrongHere: readonly string[] = [], maxPositionals = 0): FlagScan {
  const scan: FlagScan = { values: new Map(), switches: new Set(), issues: [], positionals: [] };
  const repeatable = new Set(spec.repeatable ?? []);
  const known = [...spec.values, ...(spec.switches ?? [])];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (spec.values.includes(arg)) {
      const next = args[i + 1];
      if (isMissingValue(next)) {
        const needs = spec.needs?.[arg] ?? `a value, e.g. ${arg} <value>`;
        scan.issues.push({ kind: 'missing-value', message: `${arg} needs ${needs}` });
        // An empty word is the value that is missing, not a stray word of its own
        if (next === '') {
          i++;
        }
        continue;
      }
      i++;
      const seen = scan.values.get(arg);
      if (seen === undefined) {
        scan.values.set(arg, [next!]);
      } else if (repeatable.has(arg)) {
        seen.push(next!);
      } else {
        scan.issues.push({ kind: 'duplicate', message: `${arg} is given twice (${JSON.stringify(seen[0])} and ${JSON.stringify(next)}): give it once, the first would silently win` });
      }
    } else if (spec.switches?.includes(arg) === true) {
      scan.switches.add(arg);
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-[0-9]/.test(arg)) {
      // (a negative number such as a payload `-5` is a word, not an option)
      // The word after an unknown option is most likely its value: it is not reported a second time as a stray
      const after = args[i + 1];
      if (after !== undefined && !after.startsWith('-')) {
        i++;
      }
      if (wrongHere.includes(arg)) {
        scan.issues.push({ kind: 'unknown', message: `'${arg}' does not apply to '${cmd}'. Fix: remove it` });
        continue;
      }
      const near = nearestFlag(arg, known);
      scan.issues.push({ kind: 'unknown', message: `unknown option '${arg}' for '${cmd}'${near === undefined ? '' : ` (did you mean '${near}'?)`}. Fix: correct or remove it` });
    } else if (scan.positionals.length < maxPositionals) {
      scan.positionals.push(arg);
    } else {
      scan.issues.push({
        kind: 'stray',
        message: `unexpected argument '${arg}' for '${cmd}'. If it belongs to the value before it, quote the whole value (e.g. --command "echo hi")`,
      });
    }
  }
  return scan;
}

/**
 * The value of a flag that takes one, read from anywhere in `args`: `{}` when the flag is absent, `{ value }` when given, `{ error }` when it is there
 * without a value (the arguments ended, or the next word is another `--flag`) - never a silent fallback to the default.
 */
export function readFlagValue(args: readonly string[], flag: string, needs: string): { value?: string } | { error: string } {
  const at = args.indexOf(flag);
  if (at === -1) {
    return {};
  }
  const next = args[at + 1];
  return isMissingValue(next) ? { error: `${flag} needs ${needs}` } : { value: next! };
}
