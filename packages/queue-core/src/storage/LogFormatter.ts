/**
 * Renders one NDJSON line of <configDir>/logs/<date>.ndjson for `queue logs`.
 *
 * Every record type written by EventLogger must have a case here: a record that is persisted but
 * not rendered is a diagnostic a human will not find.
 */
export class LogFormatter {
  /** Prefix used for the captured stdout/stderr blocks of a dispatch. */
  private static readonly OUTPUT_INDENT = '           ';

  /** Characters of the one-line output preview shown for a successful dispatch. */
  private static readonly PREVIEW_CHARS = 200;

  static format(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return '';
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
    const ts = typeof entry['ts'] === 'string' ? entry['ts'].slice(11, 19) : '??:??:??';

    if (typeof entry['msg'] === 'string') {
      // CLI invocation
      const msg = entry['msg'].replace(/^cmd: /, '');
      return `[${ts}] ${msg}`;
    }
    if (entry['type'] === 'dispatch') {
      return LogFormatter.formatDispatch(ts, entry);
    }
    if (entry['type'] === 'filter-miss') {
      return LogFormatter.formatFilterMiss(ts, entry);
    }
    if (entry['type'] === 'diagnostic') {
      return `[${ts}] [info] ${String(entry['source'])}: ${String(entry['message'])}`;
    }
    return trimmed;
  }

  private static formatDispatch(ts: string, entry: Record<string, unknown>): string {
    const status = entry['status'] as string;
    const sub = entry['subscriberId'] as string;
    const tgt = entry['target'] ? ` -> ${String(entry['target'])}` : '';
    const dur = entry['durationMs'] !== undefined ? ` (${String(entry['durationMs'])}ms)` : '';
    const err = entry['error'] ? ` - ${String(entry['error'])}` : '';
    const attempts = entry['attempts'] !== undefined ? ` (attempts: ${String(entry['attempts'])})` : '';
    const output = LogFormatter.formatOutput(entry);

    if (status === 'success') {
      return `[${ts}] [ok] ${sub}${tgt}${dur}${output}${LogFormatter.formatTailsPreview(entry)}`;
    }
    if (status === 'failed') {
      return `[${ts}] [fail] ${sub}${tgt}${err}${dur}${output}${LogFormatter.formatTails(entry)}`;
    }
    if (status === 'dlq') {
      return `[${ts}] [warn] dlq ${sub}${tgt}${err}${attempts}${output}${LogFormatter.formatTails(entry)}`;
    }
    return JSON.stringify(entry);
  }

  /** Failure: the exit code and the full tails (stdoutTail, stderrTail), one prefixed line per output line. */
  private static formatTails(entry: Record<string, unknown>): string {
    let rendered = '';
    if (typeof entry['exitCode'] === 'number') {
      rendered += `\n${LogFormatter.OUTPUT_INDENT}exit | ${String(entry['exitCode'])}`;
    }
    for (const [key, label] of [['stdoutTail', 'stdout'], ['stderrTail', 'stderr']] as const) {
      const value = entry[key];
      if (typeof value !== 'string' || value === '') {
        continue;
      }
      for (const line of value.replace(/\n+$/, '').split('\n')) {
        rendered += `\n${LogFormatter.OUTPUT_INDENT}${label} | ${line}`;
      }
    }
    return rendered;
  }

  /** Success: a one-line preview of the tails, so a quiet success stays one line and a chatty one is still visible. */
  private static formatTailsPreview(entry: Record<string, unknown>): string {
    const parts = [entry['stdoutTail'], entry['stderrTail']].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (parts.length === 0) {
      return '';
    }
    const flat = parts.map((p) => p.replace(/\n+$/, '')).join('\n').replace(/\r?\n/g, ' | ');
    const shown = flat.length > LogFormatter.PREVIEW_CHARS ? `${flat.slice(0, LogFormatter.PREVIEW_CHARS)}...` : flat;
    return `\n${LogFormatter.OUTPUT_INDENT}output: ${shown}`;
  }

  /** Captured child output, one prefixed line per output line so it stays greppable. */
  private static formatOutput(entry: Record<string, unknown>): string {
    let rendered = '';
    for (const stream of ['stdout', 'stderr'] as const) {
      const value = entry[stream];
      if (typeof value !== 'string' || value === '') {
        continue;
      }
      for (const line of value.replace(/\n+$/, '').split('\n')) {
        rendered += `\n${LogFormatter.OUTPUT_INDENT}${stream} | ${line}`;
      }
    }
    return rendered;
  }

  private static formatFilterMiss(ts: string, entry: Record<string, unknown>): string {
    const sub = entry['subscriberId'] as string;
    const filter = entry['filter'] as string;
    const reason = entry['reason'] as string;
    const path = entry['path'] !== undefined ? ` path "${String(entry['path'])}"` : '';
    const expected = entry['expected'] !== undefined ? ` expected "${String(entry['expected'])}"` : '';
    const actual = entry['actual'] !== undefined ? `, found "${String(entry['actual'])}"` : '';
    const details = `${path}${expected}${actual}`;
    return `[${ts}] [miss] filter-miss ${sub} when "${filter}" - ${reason}${details === '' ? '' : `:${details}`}`;
  }
}
