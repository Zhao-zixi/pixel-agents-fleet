import type { FleetProvider } from '../../../core/src/fleet.js';
import { FLEET_MAX_SESSION_ID } from './profiles.js';

export type FleetEvent =
  | { kind: 'tool'; id: string; name: string; detail: string }
  | { kind: 'toolEnd'; id: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'session'; id: string }
  | { kind: 'turnStart' }
  | { kind: 'waiting'; message: string }
  | { kind: 'done' };

function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}
function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}
function detail(x: unknown): string {
  const input = obj(x);
  return str(input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query).slice(
    0,
    200,
  );
}

/** Pure per-provider adapters. Unknown events are ignored, never interpreted as completion. */
export function normalizeFleetEvent(provider: FleetProvider, raw: unknown): FleetEvent[] {
  const r = obj(raw);
  const type = r.type;
  const events: FleetEvent[] = [];
  const session = str(r.session_id ?? r.sessionID ?? r.thread_id ?? r.conversationId);
  if (session) events.push({ kind: 'session', id: session });
  const tool = (id: unknown, name: unknown, input: unknown) => {
    if (typeof id === 'string')
      events.push({ kind: 'tool', id, name: str(name) || 'Tool', detail: detail(input) });
  };
  if (provider === 'codex') {
    if (type === 'turn.started') events.push({ kind: 'turnStart' });
    const item = obj(r.item);
    if (type === 'item.started' && !['agent_message', 'reasoning'].includes(str(item.type)))
      tool(item.id, item.type, item);
    if (type === 'item.completed') {
      if (typeof item.id === 'string') events.push({ kind: 'toolEnd', id: item.id });
      if (item.type === 'agent_message') events.push({ kind: 'text', text: str(item.text) });
    }
    if (type === 'turn.completed') events.push({ kind: 'done' });
    if (type === 'error' || type === 'turn.failed')
      events.push({
        kind: 'error',
        message: str(r.message ?? obj(r.error).message) || 'Codex failed',
      });
  } else if (provider === 'claude') {
    const content = obj(r.message).content;
    if (Array.isArray(content))
      for (const part of content) {
        const c = obj(part);
        if (c.type === 'tool_use') tool(c.id, c.name, c.input);
        if (c.type === 'tool_result' && typeof c.tool_use_id === 'string')
          events.push({ kind: 'toolEnd', id: c.tool_use_id });
        if (c.type === 'text' && type === 'assistant')
          events.push({ kind: 'text', text: str(c.text) });
      }
    if (type === 'result')
      events.push(
        r.is_error
          ? { kind: 'error', message: str(r.result) || JSON.stringify(r.errors ?? r.subtype) }
          : { kind: 'done' },
      );
  } else if (provider === 'gemini') {
    if (type === 'tool_use') tool(r.tool_id, r.tool_name, r.parameters);
    if (type === 'tool_result' && typeof r.tool_id === 'string')
      events.push({ kind: 'toolEnd', id: r.tool_id });
    if (type === 'message' && r.role === 'assistant')
      events.push({ kind: 'text', text: str(r.content) });
    if (type === 'result')
      events.push(
        r.status === 'error' || r.error
          ? { kind: 'error', message: str(obj(r.error).message) || 'Gemini failed' }
          : { kind: 'done' },
      );
    if (type === 'error')
      events.push({
        kind: 'error',
        message: str(r.message ?? obj(r.error).message) || 'Gemini error',
      });
  } else if (provider === 'opencode') {
    const part = obj(r.part);
    if (type === 'text') events.push({ kind: 'text', text: str(part.text) });
    if (type === 'tool_use') {
      tool(part.callID ?? part.id, part.tool, obj(part.state).input);
      if (['completed', 'error'].includes(str(obj(part.state).status)))
        events.push({ kind: 'toolEnd', id: str(part.callID ?? part.id) });
    }
    if (type === 'error')
      events.push({
        kind: 'error',
        message: str(obj(obj(r.error).data).message ?? obj(r.error).message) || 'OpenCode failed',
      });
    // step_finish ends ONE model step, not the whole run. Process exit is authoritative.
  } else {
    if (type === 'conversation_start' || type === 'turn_start') events.push({ kind: 'turnStart' });
    if (type === 'waiting')
      events.push({ kind: 'waiting', message: str(r.message) || 'Waiting for input' });
    if (type === 'tool_start') tool(r.id, r.name, r.input);
    if (type === 'tool_end' && typeof r.id === 'string') events.push({ kind: 'toolEnd', id: r.id });
    if (type === 'text') events.push({ kind: 'text', text: str(r.text) });
    if (type === 'error') events.push({ kind: 'error', message: str(r.message) || 'Agent failed' });
    if (type === 'done') events.push({ kind: 'done' });
  }
  return events;
}

export interface FleetPacket {
  conversationId?: string;
  title?: string;
  events: FleetEvent[];
}

/** Explicit envelopes make interleaved streams unambiguous. Never guess from tool IDs. */
export function parseFleetPacket(provider: FleetProvider, raw: unknown): FleetPacket {
  const record = obj(raw);
  const envelope = record.type === 'fleet.event';
  if (
    envelope &&
    (!record.event || typeof record.event !== 'object' || Array.isArray(record.event))
  ) {
    throw new Error('fleet.event needs an event object');
  }
  const payload = envelope ? obj(record.event) : record;
  const suppliedId = envelope
    ? record.conversationId
    : (payload.conversationId ?? payload.session_id ?? payload.sessionID ?? payload.thread_id);
  if (
    (envelope && suppliedId === undefined) ||
    (suppliedId !== undefined &&
      (typeof suppliedId !== 'string' ||
        !suppliedId.trim() ||
        suppliedId.length > FLEET_MAX_SESSION_ID ||
        /[\x00-\x1f]/.test(suppliedId)))
  ) {
    throw new Error('Invalid conversationId / session ID');
  }
  const title = record.title;
  if (
    title !== undefined &&
    (typeof title !== 'string' || title.length > FLEET_MAX_SESSION_ID || /[\x00-\x1f]/.test(title))
  ) {
    throw new Error('Invalid conversation title');
  }
  return {
    conversationId: suppliedId as string | undefined,
    title: typeof title === 'string' ? title : undefined,
    events: normalizeFleetEvent(provider, payload).filter((event) => event.kind !== 'session'),
  };
}

/** Normalize animation categories without coupling the office to every CLI's tool vocabulary. */
export function animationTool(name: string): string {
  if (/read|search|glob|grep|list|web|fetch/i.test(name)) return 'Read';
  if (/edit|write|patch|file_change/i.test(name)) return 'Edit';
  return 'Bash';
}
