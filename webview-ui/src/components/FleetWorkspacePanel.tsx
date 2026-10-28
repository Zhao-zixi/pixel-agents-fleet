import { useState } from 'react';

import type { FleetWorkspaceReport } from '../../../core/src/fleetWorkspace.js';
import { serverToken } from '../transport/serverToken.js';
import { Button } from './ui/Button.js';

const changeLabels = {
  'pre-existing': '启动前已有，未观察到新差异',
  'changed-since-start': '启动后变化（来源未确认）',
  'new-since-start': '启动后新观察到的变化',
  resolved: '原有变化已消失',
};
export function FleetWorkspacePanel({ runId }: { runId: number }) {
  const [report, setReport] = useState<FleetWorkspaceReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => {
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/fleet/runs/${runId}/workspace`, {
        headers: { Authorization: `Bearer ${serverToken ?? ''}` },
      });
      if (!response.ok) throw new Error('无法读取工作区');
      setReport((await response.json()) as FleetWorkspaceReport);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="fleet-detail" aria-label="只读工作区改动">
      <strong>工作区改动（只读）</strong>
      <p className="fleet-muted">
        变化归属未知；共享目录不代表某个对话造成了修改。不会暂存、提交、回滚或合并文件。
      </p>
      <Button size="sm" disabled={pending} onClick={() => void refresh()}>
        {pending ? '读取中…' : '读取 / 刷新 diff'}
      </Button>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p className="fleet-path">
            {report.current.host} · {report.current.root}
          </p>
          <p>
            共享工作区的进程：{report.relatedRunIds.map((id) => `#${id}`).join(' ↔ ') || '未知'}
          </p>
          {report.overlapRisk && (
            <p role="status">
              可能重叠修改：多个进程同时使用此工作区。请检查下列文件；尚无逐文件归属证据。
            </p>
          )}
          {report.current.status !== 'ready' && <p>{report.current.reason}</p>}
          {(report.baseline.status !== 'ready' || report.baseline.truncated) && (
            <p>启动前基线不完整，无法确认未记录文件是否为本次任务新增变化。</p>
          )}
          {report.current.truncated && <p>读取已达到文件数、时间或输出上限；此列表并不完整。</p>}
          {report.current.status === 'ready' && !report.current.files.length && (
            <p>没有观察到未提交变化。</p>
          )}
          {report.current.files.map((file) => (
            <details key={file.path}>
              <summary>
                {file.path} [{file.index}/{file.worktree}] ·{' '}
                {file.change ? changeLabels[file.change] : '基线未知'}
              </summary>
              {file.kind === 'hidden' ? (
                <p>敏感路径内容默认隐藏；请在自己的终端审查。</p>
              ) : file.kind === 'text' ? (
                <>
                  {file.baselinePatch && (
                    <details>
                      <summary>启动前基线</summary>
                      <pre>{file.baselinePatch}</pre>
                    </details>
                  )}
                  <pre
                    className="pixel-scrollbar"
                    style={{ maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}
                  >
                    {file.patch || '当前无文本差异'}
                  </pre>
                </>
              ) : (
                <p>
                  {file.kind === 'binary'
                    ? '二进制文件，仅显示状态'
                    : file.kind === 'symlink'
                      ? '符号链接不读取目标内容'
                      : '内容未读取（远程新增文件、超大文件或读取限制）'}
                </p>
              )}
              {file.truncated && <p>差异内容已截断。</p>}
            </details>
          ))}
        </>
      )}
    </section>
  );
}
