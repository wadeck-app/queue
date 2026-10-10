import { describe, it, expect } from 'vitest';
import { diffNewEntries } from './HistoryFollower.js';
import type { HistoryEntry } from './HistoryReader.js';

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

describe('diffNewEntries', () => {
  it('reports every entry as changed when there is no prior snapshot', () => {
    const entry = makeEntry();
    const { changed, snapshot } = diffNewEntries(new Map(), [entry]);
    expect(changed).toEqual([entry]);
    expect(snapshot.get('ev-1')).toBe(JSON.stringify(entry));
  });

  it('reports nothing when the entry is identical to the snapshot', () => {
    const entry = makeEntry();
    const previous = new Map([['ev-1', JSON.stringify(entry)]]);
    const { changed } = diffNewEntries(previous, [entry]);
    expect(changed).toEqual([]);
  });

  it('reports an entry whose subscribers grew since the snapshot (async outcome landed late)', () => {
    const before = makeEntry({ subscribers: [] });
    const after = makeEntry({ subscribers: [{ subscriberId: 'onTicket.created[0]', status: 'success' }] });
    const previous = new Map([['ev-1', JSON.stringify(before)]]);
    const { changed } = diffNewEntries(previous, [after]);
    expect(changed).toEqual([after]);
  });

  it('does not report an unrelated unchanged entry alongside a new one', () => {
    const unchanged = makeEntry({ eventId: 'ev-1' });
    const brandNew = makeEntry({ eventId: 'ev-2', ts: '2026-01-01T10:05:00.000Z' });
    const previous = new Map([['ev-1', JSON.stringify(unchanged)]]);
    const { changed } = diffNewEntries(previous, [unchanged, brandNew]);
    expect(changed).toEqual([brandNew]);
  });

  it('orders changed entries chronologically (oldest first), unlike HistoryReader.read()\'s newest-first order', () => {
    const older = makeEntry({ eventId: 'ev-1', ts: '2026-01-01T10:00:00.000Z' });
    const newer = makeEntry({ eventId: 'ev-2', ts: '2026-01-01T11:00:00.000Z' });
    const { changed } = diffNewEntries(new Map(), [newer, older]);
    expect(changed.map(e => e.eventId)).toEqual(['ev-1', 'ev-2']);
  });

  it('returns a full snapshot covering every current entry, including unchanged ones', () => {
    const entry = makeEntry();
    const previous = new Map([['ev-1', JSON.stringify(entry)]]);
    const { snapshot } = diffNewEntries(previous, [entry]);
    expect(snapshot.size).toBe(1);
    expect(snapshot.get('ev-1')).toBe(JSON.stringify(entry));
  });
});
