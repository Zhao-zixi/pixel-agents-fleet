import { useCallback, useEffect, useState } from 'react';

import type { FleetConversation, FleetRun, FleetSnapshot } from '../../../core/src/fleet.js';
import { FLEET_REFRESH_MS } from '../constants.js';
import { serverToken } from '../transport/serverToken.js';
import { Button } from './ui/Button.js';

async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/fleet' + path, {
    method,
    headers: {
      Authorization: `Bearer ${serverToken ?? ''}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? data.message ?? 'Request failed');
  return data as T;
}
const statusLabels: Record<FleetConversation['status'], string> = {
  running: '进行中',
  waiting: '等你回复',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
};
type Selection = { kind: 'runs' | 'conversations'; id: number };

export function FleetPanel({ onFocus }: { onFocus: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [profileId, setProfileId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<FleetConversation | FleetRun | null>(null);
  const [history, setHistory] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await request<FleetSnapshot>();
        if (!alive) return;
        setSnapshot(next);
        setConnected(true);
        if (selected) {
          if (next[selected.kind].some((r) => r.id === selected.id)) {
            const item = await request<FleetConversation | FleetRun>(
              `/${selected.kind}/${selected.id}`,
            );
            if (alive) setDetail(item);
          } else {
            setSelected(null);
            setDetail(null);
          }
        }
      } catch (e) {
        if (alive) {
          setConnected(false);
          setError(String(e));
        }
      }
      if (alive) timer = setTimeout(refresh, FLEET_REFRESH_MS);
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, selected]);

  const perform = useCallback(async (action: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await action();
      setSnapshot(await request<FleetSnapshot>());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }, []);
  const select = (kind: Selection['kind'], id: number) => {
    setSelected({ kind, id });
    setDetail(null);
  };
  const currentId = profileId || snapshot?.profiles[0]?.id || '';
  const profile = snapshot?.profiles.find((p) => p.id === currentId);
  const running = snapshot?.runs.filter((r) => r.status === 'running').length ?? 0;
  const conversations = snapshot?.conversations ?? [];
  const active = conversations.filter(
    (c) => c.status === 'running' || c.status === 'waiting',
  ).length;
  const hidden = conversations.filter((c) => !c.visible).length;

  return (
    <div className="fleet-root">
      <Button
        size="md"
        variant={open ? 'active' : 'default'}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? '收起小队' : '多 Agent 小队'}
      </Button>
      {open && (
        <section className="fleet-panel pixel-scrollbar" aria-label="多 Agent 小队">
          <div className="fleet-title">
            <strong>Agent 小队</strong>
            <span>{connected ? `${running} 个进程 · ${active} 个活跃对话` : '连接中…'}</span>
          </div>
          <p className="fleet-muted">一个对话一个小人。同组对话共用终端，各自显示进度。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const result = await request<{ id: number }>('/runs', 'POST', {
                  profileId: currentId,
                  prompt,
                });
                select('conversations', result.id);
              });
            }}
          >
            <label htmlFor="fleet-profile">Agent / 环境</label>
            <select
              id="fleet-profile"
              value={currentId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {snapshot?.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.ssh ?? '本地'} · {p.mode === 'task' ? '任务' : '交互'}
                </option>
              ))}
            </select>
            {profile && (
              <p className="fleet-path" title={profile.cwd}>
                {profile.cwd}
              </p>
            )}
            {profile?.mode !== 'interactive' && (
              <>
                <label htmlFor="fleet-prompt">交给它的任务</label>
                <textarea
                  id="fleet-prompt"
                  placeholder="例如：检查项目的测试，分析失败原因"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  maxLength={16000}
                  rows={3}
                  required
                />
              </>
            )}
            <Button
              type="submit"
              variant="accent"
              size="md"
              disabled={
                pending ||
                !connected ||
                !snapshot?.available ||
                !profile ||
                running >= (snapshot?.maxRunning ?? 0)
              }
            >
              {pending ? '处理中…' : '+ 启动 Agent'}
            </Button>
          </form>
          {!snapshot?.available && snapshot?.reason && <p role="status">{snapshot.reason}</p>}
          {error && (
            <p className="fleet-error" role="alert">
              {error}
            </p>
          )}
          <div className="fleet-title fleet-history">
            <span>完成后 15 秒自动收起</span>
            <Button
              size="sm"
              variant={history ? 'active' : 'default'}
              onClick={() => setHistory(!history)}
            >
              {history ? '隐藏历史' : `历史 / 已收起 (${hidden})`}
            </Button>
          </div>
          <div className="fleet-runs">
            {[...(snapshot?.runs ?? [])].reverse().map((run) => {
              const group = conversations.filter((c) => c.runId === run.id);
              return (
                <div key={run.id} className="fleet-run" data-run-id={run.id}>
                  <div className="fleet-group-title">
                    <strong>
                      #{run.id} {run.name}
                    </strong>
                    <span>{statusLabels[run.status]}</span>
                  </div>
                  <p className="fleet-muted">
                    {run.provider} · {run.host} · {group.length} 个对话
                  </p>
                  <div className="fleet-actions">
                    <Button size="sm" onClick={() => select('runs', run.id)}>
                      进程日志
                    </Button>
                    {run.status === 'running' ? (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            onFocus(run.id);
                            setOpen(false);
                          }}
                        >
                          共享终端
                        </Button>
                        <Button
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            void perform(() => request(`/runs/${run.id}/stop`, 'POST'))
                          }
                        >
                          停止整个 Agent（{group.length} 个对话）
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => void perform(() => request(`/runs/${run.id}`, 'DELETE'))}
                      >
                        移除分组
                      </Button>
                    )}
                  </div>
                  {group
                    .filter((c) => c.visible || history)
                    .map((c) => (
                      <div
                        key={c.id}
                        data-conversation-id={c.id}
                        className={`fleet-conversation ${selected?.kind === 'conversations' && selected.id === c.id ? 'fleet-selected' : ''}`}
                      >
                        <button
                          className="fleet-run-select"
                          onClick={() => select('conversations', c.id)}
                        >
                          <strong>
                            #{c.id} {c.title}
                          </strong>
                          <span>
                            {statusLabels[c.status]}
                            {!c.visible && ' · 已收起'}
                          </span>
                          <small className="fleet-activity">{c.activity}</small>
                        </button>
                        <div className="fleet-actions">
                          {c.visible && (
                            <Button
                              size="sm"
                              onClick={() => {
                                onFocus(c.id);
                                setOpen(false);
                              }}
                            >
                              定位 / 终端
                            </Button>
                          )}
                          <Button
                            size="sm"
                            disabled={pending}
                            onClick={() =>
                              void perform(() =>
                                request(`/conversations/${c.id}/visibility`, 'POST', {
                                  visible: !c.visible,
                                }),
                              )
                            }
                          >
                            {c.visible ? '收起小人' : '显示小人'}
                          </Button>
                        </div>
                      </div>
                    ))}
                  {!history && group.every((c) => !c.visible) && (
                    <p className="fleet-muted">本组小人已收起，可在历史中查看。</p>
                  )}
                </div>
              );
            })}
            {snapshot?.runs.length === 0 && (
              <p className="fleet-muted">选择环境，启动第一个 Agent。</p>
            )}
          </div>
          {detail && (
            <div className="fleet-detail">
              <strong>
                #{detail.id} {selected?.kind === 'runs' ? '进程日志（包含所有对话）' : '对话输出'}
              </strong>
              {detail.sessionId && <p className="fleet-path">会话：{detail.sessionId}</p>}
              <pre className="pixel-scrollbar">{detail.output || '等待 Agent 输出…'}</pre>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
