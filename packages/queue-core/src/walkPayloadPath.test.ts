import { describe, it, expect, vi } from 'vitest';
import { EVENT_REF_KEY, KEEP_AS_DATA, findForbiddenSegment, walkPayloadPath } from './walkPayloadPath.js';

describe('walkPayloadPath', () => {
  it('reads a top-level key', () => {
    expect(walkPayloadPath({ a: 1 }, 'a')).toBe(1);
  });

  it('an own key named like the whole dotted path wins over the nesting', () => {
    expect(walkPayloadPath({ 'a.b': 'x', a: { b: 'y' } }, 'a.b')).toBe('x');
  });

  it('walks own properties segment by segment otherwise', () => {
    expect(walkPayloadPath({ a: { b: { c: 3 } } }, 'a.b.c')).toBe(3);
    expect(walkPayloadPath({ a: { b: 1 } }, 'a.b')).toBe(1);
  });

  it('does not try a dotted key below level one', () => {
    expect(walkPayloadPath({ a: { 'b.c': 'hidden' } }, 'a.b.c')).toBeUndefined();
  });

  it('gives undefined for a missing step, a primitive or null on the way, and a payload that is not an object', () => {
    expect(walkPayloadPath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(walkPayloadPath({ a: 'text' }, 'a.length')).toBeUndefined();
    expect(walkPayloadPath({ a: null }, 'a.b')).toBeUndefined();
    expect(walkPayloadPath('text', 'a')).toBeUndefined();
    expect(walkPayloadPath(null, 'a')).toBeUndefined();
    expect(walkPayloadPath(undefined, 'a')).toBeUndefined();
  });

  it('returns a falsy value as it is (0, false, empty string, null)', () => {
    expect(walkPayloadPath({ a: { z: 0, f: false, e: '', n: null } }, 'a.z')).toBe(0);
    expect(walkPayloadPath({ a: { z: 0, f: false, e: '', n: null } }, 'a.f')).toBe(false);
    expect(walkPayloadPath({ a: { z: 0, f: false, e: '', n: null } }, 'a.e')).toBe('');
    expect(walkPayloadPath({ a: { z: 0, f: false, e: '', n: null } }, 'a.n')).toBeNull();
  });

  describe('arrays', () => {
    it('answers canonical index segments', () => {
      expect(walkPayloadPath({ l: ['a', { n: 2 }] }, 'l.0')).toBe('a');
      expect(walkPayloadPath({ l: ['a', { n: 2 }] }, 'l.1.n')).toBe(2);
    });

    it('does not answer length, methods, a non-canonical index or an out-of-range one', () => {
      const payload = { l: ['a', 'b'] };
      for (const path of ['l.length', 'l.map', 'l.01', 'l.-1', 'l.2', 'l.1.5']) {
        expect(walkPayloadPath(payload, path), path).toBeUndefined();
      }
    });
  });

  describe('forbidden segments', () => {
    it.each(['__proto__', 'constructor', 'prototype'])('%s is never read, as the whole key, first segment or inner segment, own property or not', (segment) => {
      const payload = JSON.parse(`{"${segment}": {"x": "leak"}, "a": {"${segment}": {"x": "leak"}}}`) as unknown;
      expect(walkPayloadPath(payload, segment)).toBeUndefined();
      expect(walkPayloadPath(payload, `${segment}.x`)).toBeUndefined();
      expect(walkPayloadPath(payload, `a.${segment}`)).toBeUndefined();
      expect(walkPayloadPath(payload, `a.${segment}.x`)).toBeUndefined();
    });

    it('inherited properties are not read either', () => {
      expect(walkPayloadPath({}, 'toString')).toBeUndefined();
      expect(walkPayloadPath({ a: {} }, 'a.hasOwnProperty')).toBeUndefined();
    });

    it('findForbiddenSegment names the first one, and ignores names that merely contain one', () => {
      expect(findForbiddenSegment('a.constructor.b')).toBe('constructor');
      expect(findForbiddenSegment('__proto__')).toBe('__proto__');
      expect(findForbiddenSegment('a.constructors.myprototype')).toBeUndefined();
    });
  });

  describe('resolveRef (a callback of the caller; the walker follows a reference only through it)', () => {
    const payload = { original: { [EVENT_REF_KEY]: 'ev-1' }, other: 1 };

    it('is not called without remaining segments: a terminal reference is returned as it is', () => {
      const resolveRef = vi.fn();
      expect(walkPayloadPath(payload, 'original', { resolveRef })).toEqual({ [EVENT_REF_KEY]: 'ev-1' });
      expect(resolveRef).not.toHaveBeenCalled();
    });

    it('continues in the payload the callback returns, and tells it the reference and where it was found', () => {
      const resolveRef = vi.fn().mockReturnValue({ taskId: 7, nested: { k: 'v' } });
      expect(walkPayloadPath(payload, 'original.taskId', { resolveRef })).toBe(7);
      expect(walkPayloadPath(payload, 'original.nested.k', { resolveRef })).toBe('v');
      expect(resolveRef).toHaveBeenNthCalledWith(1, 'ev-1', ['original']);
    });

    it('without a callback the reference object is plain data: nothing is read through it', () => {
      expect(walkPayloadPath(payload, 'original.taskId')).toBeUndefined();
      expect(walkPayloadPath(payload, 'original.$eventRef')).toBe('ev-1');
    });

    it('one level only: a reference inside a resolved payload is not followed', () => {
      const resolveRef = vi.fn().mockReturnValue({ again: { [EVENT_REF_KEY]: 'ev-2' } });
      expect(walkPayloadPath(payload, 'original.again.deep', { resolveRef })).toBeUndefined();
      expect(resolveRef).toHaveBeenCalledTimes(1);
      // ... and a terminal one inside it comes back as it is
      expect(walkPayloadPath(payload, 'original.again', { resolveRef })).toEqual({ [EVENT_REF_KEY]: 'ev-2' });
    });

    it('a callback result of undefined means nothing found', () => {
      expect(walkPayloadPath(payload, 'original.taskId', { resolveRef: () => undefined })).toBeUndefined();
    });

    it('an error of the callback goes up to the caller', () => {
      expect(() => walkPayloadPath(payload, 'original.taskId', { resolveRef: () => { throw new Error('base event gone'); } })).toThrow('base event gone');
    });

    it('only an own string $eventRef counts: a number, an inherited one or an array does not call the callback', () => {
      const resolveRef = vi.fn().mockReturnValue({ x: 1 });
      expect(walkPayloadPath({ o: { [EVENT_REF_KEY]: 5 } }, 'o.x', { resolveRef })).toBeUndefined();
      expect(walkPayloadPath({ o: Object.create({ [EVENT_REF_KEY]: 'ev-1' }) as object }, 'o.x', { resolveRef })).toBeUndefined();
      expect(walkPayloadPath({ o: [] }, 'o.x', { resolveRef })).toBeUndefined();
      expect(resolveRef).not.toHaveBeenCalled();
    });

    it('KEEP_AS_DATA: the walk continues in the object itself, as plain data, and a reference deeper is still a candidate', () => {
      const resolveRef = vi.fn().mockReturnValue(KEEP_AS_DATA);
      expect(walkPayloadPath({ x: { [EVENT_REF_KEY]: 'ev-1', own: 'mine' } }, 'x.own', { resolveRef })).toBe('mine');
      expect(walkPayloadPath({ x: { [EVENT_REF_KEY]: 'ev-1' } }, 'x.missing', { resolveRef })).toBeUndefined();
      expect(resolveRef).toHaveBeenCalledWith('ev-1', ['x']);
      // not resolved, so a second reference below is offered to the callback too (it decides again)
      expect(walkPayloadPath({ x: { [EVENT_REF_KEY]: 'ev-1', y: { [EVENT_REF_KEY]: 'ev-2', z: 1 } } }, 'x.y.z', { resolveRef })).toBe(1);
      expect(resolveRef).toHaveBeenCalledWith('ev-2', ['x', 'y']);
    });

    it('a null $eventRef is a reference to nothing: the callback is called with null (it decides, e.g. a legacy dead-letter entry)', () => {
      const resolveRef = vi.fn().mockImplementation(() => { throw new Error('no base event'); });
      expect(() => walkPayloadPath({ original: { [EVENT_REF_KEY]: null } }, 'original.taskId', { resolveRef })).toThrow('no base event');
      expect(resolveRef).toHaveBeenCalledWith(null, ['original']);
      // at the end of the path it is returned as it is
      expect(walkPayloadPath({ original: { [EVENT_REF_KEY]: null } }, 'original', { resolveRef })).toEqual({ [EVENT_REF_KEY]: null });
    });

    it('an own dotted key still wins, with no resolution', () => {
      const resolveRef = vi.fn();
      expect(walkPayloadPath({ 'original.taskId': 'literal', original: { [EVENT_REF_KEY]: 'ev-1' } }, 'original.taskId', { resolveRef })).toBe('literal');
      expect(resolveRef).not.toHaveBeenCalled();
    });
  });
});
