/** Privacy-minimal history: no task text, output, paths, session IDs or tool arguments. */
export interface FleetTimelineEvent {
  sequence: number;
  epoch: string;
  timestamp: number;
  runId: number;
  conversationId?: number;
  kind:
    | 'launch'
    | 'conversation'
    | 'session'
    | 'turnStart'
    | 'text'
    | 'error'
    | 'done'
    | 'waiting'
    | 'tool'
    | 'toolEnd'
    | 'exit'
    | 'stopped'
    | 'unknown';
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'unknown';
  /** One-way, run/conversation-scoped reference; never the raw provider tool ID. */
  toolRef?: string;
}
export interface FleetTimelineSnapshot {
  epoch: string;
  events: FleetTimelineEvent[];
  persistent: boolean;
  truncated: boolean;
  warning: string | null;
  limits: { maxEvents: number; maxBytes: number; maxAgeMs: number };
}
export function timelineStateAt(
  events: readonly FleetTimelineEvent[],
  sequence: number,
  epoch: string,
) {
  const states = new Map<
    string,
    FleetTimelineEvent & { displayStatus: FleetTimelineEvent['status'] | 'interrupted' }
  >();
  for (const event of events) {
    if (event.sequence > sequence) break;
    const key = `${event.epoch}:${event.runId}:${event.conversationId ?? 'run'}`;
    const interrupted =
      event.epoch !== epoch && (event.status === 'running' || event.status === 'waiting');
    states.set(key, { ...event, displayStatus: interrupted ? 'interrupted' : event.status });
  }
  return [...states.values()];
}
