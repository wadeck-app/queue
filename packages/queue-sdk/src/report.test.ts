import { describe, expect, it, vi } from 'vitest';
import { createReporter, describeHttpError, excerpt, type QueueFailure } from './report.js';

function failure(overrides: Partial<QueueFailure> = {}): QueueFailure {
  return { kind: 'http-error', message: 'HTTP 400: bad', event: 'a.b', outcome: 'dropped', ...overrides };
}

describe('createReporter', () => {
  it('calls onError for every failure, even duplicates', () => {
    const onError = vi.fn();
    const reporter = createReporter({ onError, sink: () => undefined });
    reporter.failure(failure());
    reporter.failure(failure());
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(failure());
  });

  it('writes to the sink once per kind and message', () => {
    const sink = vi.fn();
    const reporter = createReporter({ sink });
    reporter.failure(failure());
    reporter.failure(failure({ event: 'other.event' }));
    expect(sink).toHaveBeenCalledTimes(1);
    reporter.failure(failure({ message: 'different' }));
    reporter.failure(failure({ kind: 'aborted' }));
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it('mentions the event and the outcome in the line', () => {
    const sink = vi.fn();
    createReporter({ sink }).failure(failure({ outcome: 'unknown', message: 'timed out' }));
    const line = String(sink.mock.calls[0]?.[0]);
    expect(line).toContain('queue-sdk');
    expect(line).toContain('a.b');
    expect(line).toContain('timed out');
    expect(line).toContain('may');
  });

  it('words a declaration failure as a declaration of the source, not as an event', () => {
    const sink = vi.fn();
    const reporter = createReporter({ sink });
    reporter.failure(failure({ operation: 'register-events', event: 'demo', message: 'update queue-cli' }));
    reporter.failure(failure({ operation: 'register-events', event: 'demo2', kind: 'unknown-outcome', outcome: 'unknown', message: 'reset' }));
    expect(String(sink.mock.calls[0]?.[0])).toBe('[queue-sdk] the declaration of the events of "demo" was not stored: update queue-cli');
    expect(String(sink.mock.calls[1]?.[0])).toContain('may or may not have been stored');
  });

  it('prints again after the first success', () => {
    const sink = vi.fn();
    const reporter = createReporter({ sink });
    reporter.failure(failure());
    reporter.success();
    reporter.failure(failure());
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('prints nothing when silent but still calls onError', () => {
    const sink = vi.fn();
    const onError = vi.fn();
    const reporter = createReporter({ silent: true, onError, sink });
    reporter.failure(failure());
    expect(sink).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('uses console.warn as the default sink', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createReporter({}).failure(failure());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('survives an onError that throws and says so on the sink', () => {
    const sink = vi.fn();
    const reporter = createReporter({
      onError: () => {
        throw new Error('callback bug');
      },
      sink,
    });
    expect(() => reporter.failure(failure())).not.toThrow();
    expect(sink.mock.calls.map((call) => String(call[0])).join('\n')).toContain('callback bug');
  });

  it('survives an onError that throws when silent', () => {
    const reporter = createReporter({
      silent: true,
      onError: () => {
        throw new Error('callback bug');
      },
    });
    expect(() => reporter.failure(failure())).not.toThrow();
  });

  it('sends each warning once to onWarning', () => {
    const onWarning = vi.fn();
    const reporter = createReporter({ onWarning, sink: () => undefined });
    reporter.warnings(['old protocol', 'other']);
    reporter.warnings(['old protocol']);
    expect(onWarning.mock.calls.map((call) => call[0])).toEqual(['old protocol', 'other']);
  });

  it('prints warnings on the sink when there is no onWarning, unless silent', () => {
    const sink = vi.fn();
    createReporter({ sink }).warnings(['deprecated']);
    expect(String(sink.mock.calls[0]?.[0])).toContain('deprecated');
    const quiet = vi.fn();
    createReporter({ silent: true, sink: quiet }).warnings(['deprecated']);
    expect(quiet).not.toHaveBeenCalled();
  });

  it('does not print a warning to the sink when onWarning handles it', () => {
    const sink = vi.fn();
    createReporter({ onWarning: () => undefined, sink }).warnings(['deprecated']);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('createReporter notice (about the SDK own configuration)', () => {
  it('goes once to onWarning', () => {
    const onWarning = vi.fn();
    const reporter = createReporter({ onWarning, sink: () => undefined });
    reporter.notice('X is set');
    reporter.notice('X is set');
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith('X is set');
  });

  it('is printed with the SDK prefix when there is no onWarning, unless silent', () => {
    const sink = vi.fn();
    createReporter({ sink }).notice('X is set');
    expect(sink).toHaveBeenCalledWith('[queue-sdk] X is set');

    const quiet = vi.fn();
    createReporter({ silent: true, sink: quiet }).notice('X is set');
    expect(quiet).not.toHaveBeenCalled();
  });

  it('survives an onWarning that throws', () => {
    const sink = vi.fn();
    const reporter = createReporter({ onWarning: () => { throw new Error('boom'); }, sink });
    expect(() => reporter.notice('X is set')).not.toThrow();
    expect(sink).toHaveBeenCalledWith(expect.stringContaining('the onWarning callback threw: boom'));
  });
});

describe('excerpt', () => {
  it('truncates long text', () => {
    const out = excerpt('x'.repeat(1000), []);
    expect(out.length).toBeLessThan(400);
    expect(out).toContain('...');
  });

  it('keeps short text and collapses whitespace', () => {
    expect(excerpt('a\n  b', [])).toBe('a b');
  });

  it('never prints a secret', () => {
    const out = excerpt('Unauthorized: Bearer s3cr3tT0ken was refused', ['s3cr3tT0ken']);
    expect(out).not.toContain('s3cr3tT0ken');
    expect(out).toContain('***');
  });

  it('ignores empty secrets', () => {
    expect(excerpt('abc', [''])).toBe('abc');
  });
});

describe('describeHttpError', () => {
  it('gives status and an excerpt of the body', () => {
    const text = describeHttpError(400, '{"error":"missing cwd"}', []);
    expect(text).toContain('400');
    expect(text).toContain('missing cwd');
  });

  it('explains a 404 as an older daemon', () => {
    expect(describeHttpError(404, '{"error":"unknown command"}', [])).toContain('update queue-cli');
  });

  it('shows the daemon error of a 500 verbatim', () => {
    expect(describeHttpError(500, '{"error":"Command failed: invalid subscribers.yml"}', [])).toContain('Command failed: invalid subscribers.yml');
  });

  it('copes with an empty or non-JSON body', () => {
    expect(describeHttpError(502, '', [])).toContain('502');
    expect(describeHttpError(502, '<html>bad gateway</html>', [])).toContain('bad gateway');
  });

  it('explains a 401 after retry as a token problem', () => {
    expect(describeHttpError(401, '{"error":"Unauthorized"}', [])).toContain('health_token');
  });
});
