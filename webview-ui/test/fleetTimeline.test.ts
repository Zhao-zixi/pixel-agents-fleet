import { describe, expect, it } from 'vitest';

import { type FleetTimelineEvent, timelineStateAt } from '../../core/src/fleetTimeline.js';

describe('read-only timeline cursor', () => {
  it('scrubs interleaved conversations without mutating live event state', () => {
    const events: FleetTimelineEvent[] = [
      {
        epoch: 'current',
        sequence: 1,
        timestamp: 1,
        runId: 1,
        conversationId: 2,
        kind: 'tool',
        status: 'running',
      },
      {
        epoch: 'current',
        sequence: 2,
        timestamp: 2,
        runId: 1,
        conversationId: 3,
        kind: 'waiting',
        status: 'waiting',
      },
      {
        epoch: 'current',
        sequence: 3,
        timestamp: 3,
        runId: 1,
        conversationId: 2,
        kind: 'done',
        status: 'done',
      },
    ];
    const original = JSON.stringify(events);
    expect(timelineStateAt(events, 1, 'current').map((s) => s.displayStatus)).toEqual(['running']);
    expect(timelineStateAt(events, 3, 'current').map((s) => s.displayStatus)).toEqual([
      'done',
      'waiting',
    ]);
    expect(timelineStateAt(events, 3, 'restarted').map((s) => s.displayStatus)).toEqual([
      'done',
      'interrupted',
    ]);
    expect(JSON.stringify(events)).toBe(original);
  });
  it('does not merge identical numeric IDs from different server lifetimes', () => {
    const events: FleetTimelineEvent[] = [
      { epoch: 'old', sequence: 1, timestamp: 1, runId: 1, kind: 'launch', status: 'running' },
      { epoch: 'new', sequence: 2, timestamp: 2, runId: 1, kind: 'launch', status: 'running' },
    ];
    expect(timelineStateAt(events, 2, 'new').map((s) => s.displayStatus)).toEqual([
      'interrupted',
      'running',
    ]);
  });
});
