import { useState } from 'react';

import type { FleetDiagnostic, FleetTransport } from '../../../core/src/fleet.js';
import { fleetTransportText } from './fleetHealthText.js';
import { Button } from './ui/Button.js';

const reasons: Record<FleetDiagnostic['reason'], string> = {
  ok: 'SSH 可达，目录和 CLI 可用（不代表任务健康）',
  timeout: '诊断超时；远端任务状态未知',
  'cwd-unavailable': 'SSH 已连接，但工作目录不可访问',
  'executable-unavailable': '目录可访问，但 CLI 不可用',
  'host-key-unverified': '主机指纹未通过校验；未接受新指纹',
  'authentication-failed': 'SSH 身份验证失败',
  'connection-unconfirmed': '无法确认 SSH 连接，请检查本机 SSH 配置',
  unknown: '诊断未正常结束，原因无法确认',
};

export function FleetDiagnosticPanel({ diagnose }: { diagnose: () => Promise<FleetDiagnostic> }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<FleetDiagnostic | null>(null);
  const [error, setError] = useState('');
  const run = async () => {
    setPending(true);
    setError('');
    try {
      setResult(await diagnose());
    } catch (e) {
      setError(e instanceof Error ? e.message : '诊断失败');
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="fleet-muted">
      <Button type="button" size="sm" disabled={pending} onClick={() => void run()}>
        {pending ? '诊断中…' : '只读 SSH 诊断'}
      </Button>
      <p>只检查连接、目录与 CLI；不运行任务、不自动重连或重启。</p>
      {result && (
        <p role="status">
          {reasons[result.reason]} · {new Date(result.checkedAt).toLocaleTimeString()}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function FleetTransportHealth({ transport }: { transport?: FleetTransport }) {
  const text = fleetTransportText(transport);
  return text ? (
    <p className="fleet-muted" aria-label="SSH 通道状态">
      {text}
    </p>
  ) : null;
}
