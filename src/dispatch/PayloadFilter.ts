import { JSONPath } from 'jsonpath-plus';
import type { EventEnvelope } from '../types.js';
import { getErrorMessage } from '../errors.js';

export class PayloadFilter {
  static matches(filter: string, envelope: EventEnvelope): boolean {
    try {
      if (filter.startsWith('$')) {
        return PayloadFilter.matchJsonPath(filter, envelope);
      }
      return PayloadFilter.matchDotNotation(filter, envelope);
    } catch (err) {
      process.stderr.write(
        `[queue] filter miss — error evaluating filter "${filter}": ${getErrorMessage(err)}\n`
      );
      return false;
    }
  }

  private static matchDotNotation(filter: string, envelope: EventEnvelope): boolean {
    const eqIdx = filter.indexOf('=');
    if (eqIdx === -1) {
      process.stderr.write(`[queue] filter miss — invalid dot-notation filter (no '='): "${filter}"\n`);
      return false;
    }

    const path = filter.slice(0, eqIdx);
    const expected = filter.slice(eqIdx + 1);

    const actual = PayloadFilter.getByDotPath(envelope, path);

    if (actual === undefined) {
      process.stderr.write(`[queue] filter miss — path "${path}" not found in envelope\n`);
      return false;
    }

    if (typeof actual === 'number') {
      const numExpected = Number(expected);
      if (!isNaN(numExpected)) return actual === numExpected;
    }

    return String(actual) === expected;
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

  private static matchJsonPath(filter: string, envelope: EventEnvelope): boolean {
    const results = JSONPath({ path: filter, json: envelope as object, wrap: true }) as unknown[];
    if (results.length === 0) {
      process.stderr.write(`[queue] filter miss — JSONPath "${filter}" matched nothing\n`);
      return false;
    }
    const first = results[0];
    return Boolean(first);
  }
}
