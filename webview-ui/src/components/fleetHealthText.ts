import type { FleetTransport } from '../../../core/src/fleet.js';

export function fleetTransportText(transport?: FleetTransport): string | null {
  if (!transport || transport.kind !== 'ssh') return null;
  const label =
    transport.state === 'connecting'
      ? '连接结果尚未确认'
      : transport.state === 'output-observed'
        ? '已观察到通道输出'
        : transport.state === 'closed'
          ? '本地 SSH 通道已关闭'
          : '通道已打开';
  return (
    `SSH：${label}。远端进程：${transport.remoteState === 'exited' ? 'SSH 已报告退出' : '存活状态未知'}。` +
    (transport.lastOutputAt
      ? ` 最近输出：${new Date(transport.lastOutputAt).toLocaleTimeString()}。`
      : ' 尚未收到输出。') +
    (transport.reason === 'ssh-exit-255'
      ? '退出码 255 无法区分网络故障与远端退出；不要盲目重跑。'
      : '') +
    (transport.reason === 'local-stop' ? '停止本地 SSH 不保证远端任务已结束。' : '')
  );
}
