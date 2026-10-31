import { describe, it, expect } from 'vitest';
import { HistoryFormatter } from './HistoryFormatter.js';
import type { HistoryEntry } from '@wadeck-app/queue-core';

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: '2026-01-01T10:00:00.000Z',
    eventId: 'ev-1',
    event: 'onTicket.created',
    totalCount: 1,
    matchedCount: 1,
    subscribers: [],
    orphan: false,
    ...overrides,
  };
}

describe('HistoryFormatter.format', () => {
  it('does not mention replay for a regular (non-replayed) entry', () => {
    const line = HistoryFormatter.format(makeEntry());
    expect(line).not.toMatch(/replay/i);
  });

  it('marks a replayed entry with the parent eventId it replays', () => {
    const line = HistoryFormatter.format(makeEntry({ eventId: 'ev-2', replayOf: 'ev-1' }));
    expect(line).toContain('replay of ev-1');
  });

  it('shows an action subscriber by its action name, for a success, a failure and a dlq entry', () => {
    const line = HistoryFormatter.format(makeEntry({
      subscribers: [
        { subscriberId: 'wake', status: 'success', target: 'action:agent-wake' },
        { subscriberId: 'mirror', status: 'failed', target: 'action:emit' },
        { subscriberId: 'bad', status: 'dlq', target: 'action:nope' },
      ] as HistoryEntry['subscribers'],
    }));
    expect(line).toContain('[ok] wake -> action:agent-wake');
    expect(line).toContain('[fail] mirror -> action:emit');
    expect(line).toContain('[warn] dlq bad -> action:nope');
  });
});
