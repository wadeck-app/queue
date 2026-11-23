import { describe, it, expect } from 'vitest';
import { entriesOfRelayDeliveries, type RelayDelivery } from './ciWaitRelayHistory.js';
import { collectRuns } from './ciWait.js';

const SHA = '3106cbc6676be06d0001cefada74ac2a55291da2';

function delivery(over: Partial<RelayDelivery> = {}): RelayDelivery {
  return {
    receivedAt: '2026-11-23T20:12:39.866Z',
    source: 'github',
    eventType: 'workflow_run',
    deliveryId: 'd1',
    verified: true,
    payload: { action: 'requested', workflow_run: { id: 45256966526, name: 'CI / Publish', head_sha: SHA, status: 'queued' }, repository: { full_name: 'wadeck-app/machine' } },
    ...over,
  };
}

describe('entriesOfRelayDeliveries', () => {
  it('turns a verified github workflow_run delivery into a history entry at the time the relay received it, and a run is collected from it', () => {
    const entries = entriesOfRelayDeliveries([delivery()]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ts: '2026-11-23T20:12:39.866Z', event: 'on.github.workflow_run', eventId: 'relay-d1', orphan: false });
    expect(collectRuns(entries, { sha: '3106cbc', repo: 'wadeck-app/machine' })).toMatchObject([{ id: 45256966526, name: 'CI / Publish', status: 'queued' }]);
  });

  it('leaves out what is not a verified github workflow_run with a payload', () => {
    expect(entriesOfRelayDeliveries([
      delivery({ verified: false }),
      delivery({ source: 'gitlab' }),
      delivery({ eventType: 'push' }),
      delivery({ payload: null }),
      delivery({ payload: undefined }),
    ])).toEqual([]);
  });
});
