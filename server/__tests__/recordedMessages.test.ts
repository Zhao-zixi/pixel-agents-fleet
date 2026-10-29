import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type RecordedServerMessage,
  waitForRecordedMessage,
} from '../../e2e/helpers/recordedMessages.js';

afterEach(() => vi.useRealTimers());

describe('E2E recorded WebSocket message waits', () => {
  it('waits for the exact delayed tool/agent identity without draining other messages', async () => {
    vi.useFakeTimers();
    const messages: RecordedServerMessage[] = [
      { type: 'agentToolDone', id: 2, toolId: 'same' },
      { type: 'agentToolDone', id: 1, toolId: 'other' },
      { type: 'agentStatus', id: 1, status: 'active' },
    ];
    const waiting = waitForRecordedMessage(
      async () => messages.slice(),
      { type: 'agentToolDone', id: 1, toolId: 'same' },
      500,
    );
    await vi.advanceTimersByTimeAsync(100);
    const expected = { type: 'agentToolDone', id: 1, toolId: 'same' };
    messages.push(expected);
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toEqual(expected);
    expect(messages).toHaveLength(4);
    expect(messages[0].id).toBe(2);
  });

  it('fails within its deadline for a genuinely missing message with identity diagnostics', async () => {
    vi.useFakeTimers();
    const messages = [{ type: 'agentStatus', id: 7, body: 'private output' }];
    const failure = waitForRecordedMessage(
      async () => messages,
      { type: 'agentToolDone', id: 7 },
      125,
    ).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(125);
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('agentToolDone');
    expect(String(error)).toContain('agentStatus');
    expect(String(error)).not.toContain('private output');
    expect(vi.getTimerCount()).toBe(0);
    expect(messages).toHaveLength(1);
  });

  it('rejects an empty matcher rather than accepting an unrelated message', async () => {
    await expect(waitForRecordedMessage(async () => [{ type: 'unrelated' }], {})).rejects.toThrow(
      'matcher',
    );
  });
});
