import { useEffect, useState } from 'react';

import { type FleetTimelineSnapshot, timelineStateAt } from '../../../core/src/fleetTimeline.js';
import { serverToken } from '../transport/serverToken.js';
import { Button } from './ui/Button.js';

/** History never calls terminal/action APIs, including when scrubbing or returning to live. */
export function FleetTimelinePanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<FleetTimelineSnapshot | null>(null);
  const [error, setError] = useState('');
  const [run, setRun] = useState('');
  const [conversation, setConversation] = useState('');
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch('/api/fleet/timeline', {
          headers: { Authorization: `Bearer ${serverToken ?? ''}` },
        });
        if (!response.ok) throw new Error('无法读取事件历史');
        const snapshot = (await response.json()) as FleetTimelineSnapshot;
        if (alive) {
          setData(snapshot);
          setError('');
        }
      } catch {
        if (alive) setError('事件历史暂时不可用');
      }
      if (alive) timer = setTimeout(refresh, 3000);
    }
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open]);
  const exportMetadata = () => {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'fleet-timeline-metadata.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const events = data?.events ?? [];
  const runs = [...new Set(events.map((event) => `${event.epoch}:${event.runId}`))];
  const filtered = events.filter(
    (event) =>
      (!run || `${event.epoch}:${event.runId}` === run) &&
      (!conversation || String(event.conversationId) === conversation),
  );
  const ids = [
    ...new Set(
      events
        .filter((event) => !run || `${event.epoch}:${event.runId}` === run)
        .flatMap((event) => (event.conversationId === undefined ? [] : [event.conversationId])),
    ),
  ];
  const latest = events.at(-1)?.sequence ?? 0;
  const position =
    cursor === null ? latest : Math.min(latest, Math.max(events[0]?.sequence ?? 0, cursor));
  const states = timelineStateAt(events, position, data?.epoch ?? '').filter(
    (event) =>
      (!run || `${event.epoch}:${event.runId}` === run) &&
      (!conversation || String(event.conversationId) === conversation),
  );
  return (
    <section aria-label="只读事件时间线" className="fleet-detail">
      <Button size="sm" onClick={() => setOpen(!open)}>
        {open ? '关闭事件时间线' : '事件时间线 / 重启历史'}
      </Button>
      {open && (
        <>
          <p className="fleet-muted">
            只读回放，不启动进程、不发送终端输入。仅记录状态元数据，不保存任务、输出或路径。
          </p>
          {error && <p role="alert">{error}</p>}
          {data && (
            <p>
              {data.persistent ? '本地持久化已开启' : '仅本次运行内存记录'} · 最多{' '}
              {data.limits.maxEvents} 条 / {Math.round(data.limits.maxBytes / 1024)} KiB /{' '}
              {Math.round((data.limits.maxAgeMs / 86400000) * 100) / 100} 天
            </p>
          )}
          {data?.warning && <p role="status">{data.warning}</p>}
          {data?.truncated && (
            <p role="status">部分早期记录已过期、截断或损坏；此处不是完整执行历史。</p>
          )}
          <label>
            进程{' '}
            <select
              value={run}
              onChange={(e) => {
                setRun(e.target.value);
                setConversation('');
              }}
            >
              <option value="">全部</option>
              {runs.map((id) => (
                <option key={id} value={id}>
                  {id.slice(0, 8)} · #{id.split(':')[1]}
                </option>
              ))}
            </select>
          </label>
          <label>
            对话{' '}
            <select value={conversation} onChange={(e) => setConversation(e.target.value)}>
              <option value="">全部</option>
              {ids.map((id) => (
                <option key={id} value={id}>
                  #{id}
                </option>
              ))}
            </select>
          </label>
          {events.length > 0 && (
            <>
              <label>
                时间游标（{cursor === null ? '实时' : '历史'} #{position}）
                <input
                  aria-label="时间游标"
                  type="range"
                  min={events[0].sequence}
                  max={latest}
                  value={position}
                  onChange={(e) => setCursor(Number(e.target.value))}
                />
              </label>
              <Button size="sm" onClick={exportMetadata}>
                导出状态元数据（不含原始输出）
              </Button>
              <Button size="sm" onClick={() => setCursor(null)}>
                返回实时视图
              </Button>
              <ul>
                {states.map((state) => (
                  <li key={`${state.epoch}:${state.runId}:${state.conversationId ?? 'run'}`}>
                    #{state.runId}
                    {state.conversationId !== undefined
                      ? ` / 对话 #${state.conversationId}`
                      : ' / 进程'}
                    ：
                    {state.displayStatus === 'interrupted'
                      ? '执行状态未知 / 已中断待确认（前次运行）'
                      : state.displayStatus}
                  </li>
                ))}
              </ul>
              <ol className="pixel-scrollbar" style={{ maxHeight: 240, overflow: 'auto' }}>
                {filtered
                  .filter((event) => event.sequence <= position)
                  .map((event) => (
                    <li key={event.sequence}>
                      #{event.sequence} · {new Date(event.timestamp).toLocaleString()} · 进程 #
                      {event.runId}
                      {event.conversationId !== undefined
                        ? ` / 对话 #${event.conversationId}`
                        : ''}{' '}
                      · {event.kind} → {event.status}
                      {event.toolRef ? ` · 工具 ${event.toolRef}` : ''}
                    </li>
                  ))}
              </ol>
            </>
          )}
          {data && events.length === 0 && <p>暂无事件记录。</p>}
        </>
      )}
    </section>
  );
}
