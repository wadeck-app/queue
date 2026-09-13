import { describe, it, expect } from 'vitest';
import { OutputCapture, MAX_CAPTURED_BYTES } from './OutputCapture.js';

describe('OutputCapture.tail', () => {
  it('short text is kept verbatim without marker', () => {
    expect(OutputCapture.tail('boom\n')).toBe('boom\n');
  });

  it('oversized text keeps the tail and states what was dropped', () => {
    const text = 'x'.repeat(100) + 'CAUSE';
    const result = OutputCapture.tail(text, 10);
    expect(result).toContain('[truncated: kept last 10 of 105 bytes]');
    expect(result.endsWith('CAUSE')).toBe(true);
    // marker line + exactly maxBytes of payload
    expect(result.split('\n')[1]).toHaveLength(10);
  });

  it('text exactly at the limit is not truncated', () => {
    const text = 'y'.repeat(MAX_CAPTURED_BYTES);
    expect(OutputCapture.tail(text)).toBe(text);
  });

  it('maxBytes <= 0 throws instead of silently keeping nothing', () => {
    expect(() => OutputCapture.tail('anything', 0)).toThrow(/maxBytes must be > 0/);
  });
});

describe('OutputCapture.forLog', () => {
  it('failure keeps both streams', () => {
    const captured = OutputCapture.forLog(false, 'on stdout', 'on stderr');
    expect(captured).toEqual({ stdout: 'on stdout', stderr: 'on stderr' });
  });

  it('failure with blank streams omits them', () => {
    expect(OutputCapture.forLog(false, '', '   \n')).toEqual({});
  });

  it('success drops stdout but keeps a non-empty stderr', () => {
    const captured = OutputCapture.forLog(true, 'chatty output', 'deprecation warning');
    expect(captured).toEqual({ stderr: 'deprecation warning' });
  });

  it('success with empty stderr captures nothing', () => {
    expect(OutputCapture.forLog(true, 'chatty output', '')).toEqual({});
  });

  it('undefined streams are tolerated', () => {
    expect(OutputCapture.forLog(false, undefined, undefined)).toEqual({});
  });

  it('captured streams are truncated', () => {
    const captured = OutputCapture.forLog(false, undefined, 'z'.repeat(MAX_CAPTURED_BYTES + 10));
    expect(captured.stderr).toContain('[truncated: kept last');
  });
});
