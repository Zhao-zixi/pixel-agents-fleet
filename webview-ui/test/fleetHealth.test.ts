import { describe, expect, it } from 'vitest';

import { fleetTransportText } from '../src/components/fleetHealthText.js';
describe('Fleet transport evidence presentation', () => {
  it('does not show SSH health for local or legacy runs', () => {
    expect(fleetTransportText()).toBeNull();
    expect(fleetTransportText({ kind: 'local', state: 'open', remoteState: 'unknown' })).toBeNull();
  });
  it('shows uncertainty and warns against repeating execution after SSH exit255', () => {
    const text = fleetTransportText({
      kind: 'ssh',
      state: 'closed',
      remoteState: 'unknown',
      reason: 'ssh-exit-255',
    });
    expect(text).toContain('存活状态未知');
    expect(text).toContain('不要盲目重跑');
    expect(text).not.toContain('任务失败');
  });
  it('labels output as evidence, not a liveness claim', () => {
    const text = fleetTransportText({
      kind: 'ssh',
      state: 'output-observed',
      remoteState: 'unknown',
      lastOutputAt: 123,
    });
    expect(text).toContain('已观察到通道输出');
    expect(text).toContain('存活状态未知');
    expect(text).toContain('最近输出');
  });
});
