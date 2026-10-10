import type { HistoryEntry, HistorySubscriberOutcome } from './HistoryReader.js';

/** Renders `HistoryEntry[]` for `queue history`, parallel to LogFormatter but for the terse history journal. */
export class HistoryFormatter {
  static format(entry: HistoryEntry): string {
    const time = entry.ts.slice(11, 19);
    const project = entry.project ? `, project: ${entry.project}` : '';
    const replay = entry.replayOf ? `, replay of ${entry.replayOf}` : '';
    const header = entry.orphan
      ? `[${time}] ${entry.event} (eventId ${entry.eventId}${project}${replay}) - orphan outcome, no trigger record (likely a retry)`
      : entry.totalCount === 0
        ? `[${time}] ${entry.event} (eventId ${entry.eventId}${project}${replay}) - no subscribers configured`
        : `[${time}] ${entry.event} (eventId ${entry.eventId}${project}${replay}) - ${entry.matchedCount}/${entry.totalCount} matched`;

    const lines = entry.subscribers.map(sub => `    ${HistoryFormatter.formatSubscriber(sub)}`);
    return [header, ...lines].join('\n');
  }

  private static formatSubscriber(sub: HistorySubscriberOutcome): string {
    const tgt = sub.target ? ` -> ${sub.target}` : '';
    if (sub.status === 'success') return `[ok] ${sub.subscriberId}${tgt}`;
    if (sub.status === 'failed') return `[fail] ${sub.subscriberId}${tgt}`;
    if (sub.status === 'dlq') return `[warn] dlq ${sub.subscriberId}${tgt}`;
    return `[miss] filtered ${sub.subscriberId}${HistoryFormatter.formatFilterDetail(sub)}`;
  }

  private static formatFilterDetail(sub: HistorySubscriberOutcome): string {
    if (!sub.filter) return '';
    const found = sub.actual !== undefined ? ` (found "${sub.actual}")` : '';
    return ` when "${sub.filter}"${found}`;
  }
}
