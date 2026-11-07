/**
 * How a `{{ path }}` placeholder reads a payload, shared by the `cli` command templates and the `action` templates so the two cannot drift:
 * 1. the whole dotted path as an OWN key of the payload (`{"a.b": 1}` answers `a.b`): the original, top-level-only behaviour keeps winning;
 * 2. otherwise the path is walked segment by segment through OWN properties. A dotted key below level one (`{"a": {"b.c": 1}}`) is not tried.
 * A segment in {@link FORBIDDEN_PATH_SEGMENTS} is never read, and an array answers its index segments only (not `length`).
 * A missing step gives undefined.
 */

/** Segments that reach the prototype chain: refused at load time by the template checks, and never read here whatever the payload holds. */
export const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The first forbidden segment of a dotted path, or undefined. */
export function findForbiddenSegment(path: string): string | undefined {
  return path.split('.').find((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment));
}

/**
 * Key that marks a payload object as a reference to the payload of another event (`{ "$eventRef": "<eventId>" }`). The walker only calls
 * {@link WalkOptions.resolveRef} for it; what the reference means (and whether it may be followed) is the callback's decision.
 */
export const EVENT_REF_KEY = '$eventRef';

/** Returned by a `resolveRef` callback to say "this object is not a reference here": the walk continues in the object itself, as in plain data. */
export const KEEP_AS_DATA: unique symbol = Symbol('walkPayloadPath.keepAsData');

/** The callback of {@link WalkOptions.resolveRef}. */
export type ResolveRef = (ref: string | null, walked: readonly string[]) => unknown;

export interface WalkOptions {
  /**
   * Called when the walk meets an object with an own `$eventRef` that is a string (or null: a reference to nothing, e.g. of a legacy entry)
   * and path segments remain after it. `ref` is that value, `walked` the segments read to reach the object (so the callback can refuse a
   * reference found anywhere but where it allows). It returns the payload to continue in (undefined: nothing found, the result is undefined),
   * {@link KEEP_AS_DATA} (the object is plain data, the walk continues in it), or throws. At most once per walk: a reference met inside a
   * resolved payload is not followed, and a reference at the end of the path is returned as it is, not resolved.
   */
  resolveRef?: ResolveRef;
}

const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/** The own property `key` of `container`, `found: false` when it is not readable data (absent, inherited, forbidden, or a non-index key of an array). */
function readOwn(container: unknown, key: string): { found: boolean; value?: unknown } {
  if (container === null || typeof container !== 'object' || FORBIDDEN_PATH_SEGMENTS.has(key)) {
    return { found: false };
  }
  if (Array.isArray(container) && !ARRAY_INDEX.test(key)) {
    return { found: false };
  }
  if (!Object.hasOwn(container, key)) {
    return { found: false };
  }
  return { found: true, value: Reflect.get(container, key) };
}

/** The reference an object holds: its string, null for `{ "$eventRef": null }`, undefined when it is not a reference (any other value of the key is plain data). */
function refOf(value: unknown): string | null | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, EVENT_REF_KEY)) {
    return undefined;
  }
  const ref = Reflect.get(value, EVENT_REF_KEY);
  return typeof ref === 'string' || ref === null ? ref : undefined;
}

/** The value at `path` in `payload` (see the file comment), undefined when there is none. Pure: it reads nothing but its arguments and the callback. */
export function walkPayloadPath(payload: unknown, path: string, options: WalkOptions = {}): unknown {
  const whole = readOwn(payload, path);
  if (whole.found && findForbiddenSegment(path) === undefined) {
    return whole.value;
  }
  const segments = path.split('.');
  let current = payload;
  // Becomes true once the walk continues inside a resolved payload: one level only
  let inResolved = false;
  for (let i = 0; i < segments.length; i++) {
    const ref = inResolved ? undefined : refOf(current);
    if (ref !== undefined && options.resolveRef !== undefined) {
      const resolved = options.resolveRef(ref, segments.slice(0, i));
      if (resolved !== KEEP_AS_DATA) {
        current = resolved;
        inResolved = true;
      }
    }
    const step = readOwn(current, segments[i]!);
    if (!step.found) {
      return undefined;
    }
    current = step.value;
  }
  return current;
}
