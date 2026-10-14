import { describe, it, expect, vi, afterEach } from 'vitest';
import { runFollowMode } from './QueueIndex.js';
import type { HistoryEntry } from '@wadeck-app/queue-core';

// Helper to create a mock HistoryEntry
function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: '2026-01-01T10:00:00.000Z',
    eventId: 'ev-1',
    event: 'test.event',
    totalCount: 1,
    matchedCount: 1,
    subscribers: [],
    orphan: false,
    ...overrides,
  };
}

describe('follow mode with --limit', () => {
  it('seed 5 entries, --limit 2: only 2 newest printed initially, nothing on first poll', async () => {
    // Create 5 entries with different timestamps
    const entries = [
      makeEntry({ eventId: 'ev-1', ts: '2026-01-01T10:00:00.000Z' }),
      makeEntry({ eventId: 'ev-2', ts: '2026-01-01T10:01:00.000Z' }),
      makeEntry({ eventId: 'ev-3', ts: '2026-01-01T10:02:00.000Z' }),
      makeEntry({ eventId: 'ev-4', ts: '2026-01-01T10:03:00.000Z' }),
      makeEntry({ eventId: 'ev-5', ts: '2026-01-01T10:04:00.000Z' }),
    ];

    const mockReader = {
      read: vi.fn(() => {
        // Always return all 5 entries (no new entries on polls)
        return [...entries].reverse();
      }),
    };

    const printed: string[] = [];

    // Run follow mode with limit=2
    await runFollowMode({
      reader: mockReader,
      filter: {},
      limit: 2,
      json: false,
      write: (text: string) => {
        const match = text.match(/eventId (ev-\d+)/);
        if (match) {
          printed.push(match[1]);
        }
      },
      poll: async (interval: NodeJS.Timeout) => {
        // Run 2 polls (each separated by 500ms)
        await new Promise(r => setTimeout(r, 1050));
        clearInterval(interval);
      },
    });

    // Initial dump should show only ev-4 and ev-5 (the 2 newest)
    // On both polls, no new entries, so nothing else printed
    expect(printed).toEqual(['ev-4', 'ev-5']);
  });

  it('appending a new entry after initial dump shows only the new entry on first poll', async () => {
    const entries = [
      makeEntry({ eventId: 'ev-1', ts: '2026-01-01T10:00:00.000Z' }),
      makeEntry({ eventId: 'ev-2', ts: '2026-01-01T10:01:00.000Z' }),
      makeEntry({ eventId: 'ev-3', ts: '2026-01-01T10:02:00.000Z' }),
      makeEntry({ eventId: 'ev-4', ts: '2026-01-01T10:03:00.000Z' }),
      makeEntry({ eventId: 'ev-5', ts: '2026-01-01T10:04:00.000Z' }),
    ];

    let readCallCount = 0;
    const mockReader = {
      read: vi.fn(() => {
        readCallCount++;
        if (readCallCount <= 2) {
          // First two reads: return 5 entries (initial + first poll)
          return [...entries].reverse();
        } else {
          // Third read (second poll): add a new entry
          const newEntry = makeEntry({ eventId: 'ev-6', ts: '2026-01-01T10:05:00.000Z' });
          return [newEntry, ...entries].reverse();
        }
      }),
    };

    const printed: string[] = [];

    await runFollowMode({
      reader: mockReader,
      filter: {},
      limit: 2,
      json: false,
      write: (text: string) => {
        const match = text.match(/eventId (ev-\d+)/);
        if (match) {
          printed.push(match[1]);
        }
      },
      poll: async (interval: NodeJS.Timeout) => {
        // Run 2 polls (1050ms total: initial + poll at 500ms + poll at 1000ms)
        await new Promise(r => setTimeout(r, 1050));
        clearInterval(interval);
      },
    });

    // Initial 2 entries (ev-4, ev-5), then on second poll the new entry (ev-6)
    expect(printed).toEqual(['ev-4', 'ev-5', 'ev-6']);
  });


  it('snapshot built from FULL read prevents re-printing old entries on first poll', async () => {
    // This is the CRITICAL test for the bug fix: when we have 5 entries
    // and --limit 2, the initial dump shows ev-4 and ev-5 (the 2 newest).
    // The snapshot MUST be built from ALL 5 entries, not just the 2 printed.
    // Otherwise, on the first poll when we read all 5 again (no new entries),
    // the diffNewEntries will think ev-1, ev-2, ev-3 are "new" and re-print them.

    const entries = [
      makeEntry({ eventId: 'ev-1', ts: '2026-01-01T10:00:00.000Z' }),
      makeEntry({ eventId: 'ev-2', ts: '2026-01-01T10:01:00.000Z' }),
      makeEntry({ eventId: 'ev-3', ts: '2026-01-01T10:02:00.000Z' }),
      makeEntry({ eventId: 'ev-4', ts: '2026-01-01T10:03:00.000Z' }),
      makeEntry({ eventId: 'ev-5', ts: '2026-01-01T10:04:00.000Z' }),
    ];

    const mockReader = {
      read: vi.fn(() => {
        // Both first and second read return all 5 entries (no new entries)
        return [...entries].reverse();
      }),
    };

    const printed: string[] = [];

    // Run follow mode with limit=2 and poll callback that runs once then stops
    await runFollowMode({
      reader: mockReader,
      filter: {},
      limit: 2,
      json: false,
      write: (text: string) => {
        // Extract eventId from output like "[10:03:00] test.event (eventId ev-4) - ..."
        const match = text.match(/eventId (ev-\d+)/);
        if (match) {
          printed.push(match[1]);
        }
      },
      poll: async (interval: NodeJS.Timeout) => {
        // Wait for the first interval to fire (500ms)
        await new Promise(r => setTimeout(r, 550));
        clearInterval(interval);
      },
    });

    // Initial dump should show only ev-4 and ev-5 (exactly 2 entries)
    // This ensures the limit was respected and the snapshot was built from all 5
    expect(printed).toEqual(['ev-4', 'ev-5']);

    // ev-1, ev-2, ev-3 should NOT have been printed
    // This is the key assertion: the snapshot was built from ALL 5 entries,
    // so they are not reported as "new" on the first poll
    expect(printed).not.toContain('ev-1');
    expect(printed).not.toContain('ev-2');
    expect(printed).not.toContain('ev-3');

    // The critical assertion: mockReader.read was called twice
    // (once for initial, once during the poll)
    expect(mockReader.read).toHaveBeenCalledTimes(2);
  });
});
