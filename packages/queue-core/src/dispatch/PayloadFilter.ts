import { JSONPath } from 'jsonpath-plus';
import type { EventEnvelope } from '../types.js';
import { getErrorMessage } from '../errors.js';

export interface FilterEvaluation {
  matched: boolean;
  /** Why the filter did not match. Always set when matched === false. */
  reason?: string;
  /** Path that was looked up, when the filter expression contains one. */
  path?: string;
  expected?: string;
  /** Value actually found at `path`, absent when nothing was found there. */
  actual?: string;
}

export class PayloadFilter {
  /**
   * Evaluates a `when:` expression and explains every miss.
   * The explanation is returned instead of written to stderr: the daemon runs with stdio:'ignore',
   * so the caller must persist it through the EventLogger to make a `when:` typo observable.
   */
  static evaluate(filter: string, envelope: EventEnvelope): FilterEvaluation {
    try {
      if (filter.startsWith('$')) {
        return PayloadFilter.evaluateJsonPath(filter, envelope);
      }
      return PayloadFilter.evaluateDotNotation(filter, envelope);
    } catch (err) {
      return { matched: false, reason: `error evaluating filter: ${getErrorMessage(err)}`, path: filter };
    }
  }

  /**
   * Checks the syntax of a `when:` expression without any envelope, so a typo can be reported when the
   * expression is given (e.g. to `queue wait --when`) rather than as a filter that never matches.
   * Returns the problem, or undefined when the expression is well formed.
   * Only the "path=value" form can be checked up front: jsonpath-plus parses a JSONPath lazily, while it
   * walks a document, so a broken JSONPath is only detectable by evaluating it (see `evaluate`).
   */
  static validate(filter: string): string | undefined {
    if (filter.startsWith('$') || filter.includes('=')) {
      return undefined;
    }
    return `invalid filter "${filter}": no '=' found. Expected "path=value" (e.g. payload.exitCode=1) or a JSONPath starting with '$'`;
  }

  static matches(filter: string, envelope: EventEnvelope): boolean {
    return PayloadFilter.evaluate(filter, envelope).matched;
  }

  private static evaluateDotNotation(filter: string, envelope: EventEnvelope): FilterEvaluation {
    const eqIdx = filter.indexOf('=');
    if (eqIdx === -1) {
      return {
        matched: false,
        reason: `invalid filter: no '=' found. Expected "path=value" (e.g. payload.exitCode=1) or a JSONPath starting with '$'`,
      };
    }

    const path = filter.slice(0, eqIdx);
    const expected = filter.slice(eqIdx + 1);

    const actual = PayloadFilter.getByDotPath(envelope, path);

    if (actual === undefined) {
      return {
        matched: false,
        reason: 'path not found in envelope',
        path,
        expected,
      };
    }

    if (typeof actual === 'number') {
      const numExpected = Number(expected);
      if (!isNaN(numExpected)) {
        return PayloadFilter.comparison(actual === numExpected, path, expected, String(actual));
      }
    }

    return PayloadFilter.comparison(String(actual) === expected, path, expected, String(actual));
  }

  private static comparison(matched: boolean, path: string, expected: string, actual: string): FilterEvaluation {
    if (matched) return { matched: true };
    return { matched: false, reason: 'value mismatch', path, expected, actual };
  }

  private static getByDotPath(obj: object, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || typeof current !== 'object') return undefined;
      current = Reflect.get(current, part);
    }
    return current;
  }

  private static evaluateJsonPath(filter: string, envelope: EventEnvelope): FilterEvaluation {
    const results = JSONPath({ path: filter, json: envelope as object, wrap: true }) as unknown[];
    if (results.length === 0) {
      return { matched: false, reason: 'JSONPath matched nothing', path: filter, expected: 'any truthy value' };
    }
    const first = results[0];
    if (!first) {
      return {
        matched: false,
        reason: 'JSONPath matched a falsy value',
        path: filter,
        expected: 'any truthy value',
        actual: JSON.stringify(first) ?? String(first),
      };
    }
    return { matched: true };
  }
}
