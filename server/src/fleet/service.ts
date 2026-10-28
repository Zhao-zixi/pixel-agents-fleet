import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

import type {
  FleetConversation,
  FleetProfile,
  FleetRun,
  FleetSnapshot,
} from '../../../core/src/fleet.js';
import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import type { PtySessionManager } from '../terminal/ptySessionManager.js';
import type { AgentState } from '../types.js';
import { animationTool, type FleetEvent, parseFleetPacket } from './events.js';
import {
  buildFleetCommand,
  FLEET_ACTIVITY_TIMEOUT,
  FLEET_ARCHIVE_DELAY,
  FLEET_MAX_CONVERSATIONS,
  FLEET_MAX_CONVERSATIONS_PER_RUN,
  FLEET_MAX_HISTORY,
  FLEET_MAX_LINE,
  FLEET_MAX_OUTPUT,
  FLEET_MAX_RUNNING,
} from './profiles.js';
import { FleetTimeline, type FleetTimelineOptions } from './timeline.js';

interface ConversationState {
  conversation: FleetConversation;
  agent: AgentState;
  manuallyHidden: boolean;
  archiveTimer?: ReturnType<typeof setTimeout>;
}
interface RunState {
  run: FleetRun;
  conversations: Map<number, ConversationState>;
  bySession: Map<string, number>;
  buffer: string;
  droppingLine: boolean;
  stopped: boolean;
  warnedUnscoped: boolean;
  telemetry: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** A run owns ONE PTY. Each conversation owns ONE character and its own tool/output state. */
export class FleetService {
  readonly timeline: FleetTimeline;
  private readonly runs = new Map<number, RunState>();
  private readonly conversations = new Map<number, ConversationState>();
  private readonly internalRemovals = new Set<number>();
  private readonly onRemoved = (id: number) => {
    if (this.internalRemovals.has(id)) return;
    const state = this.conversations.get(id);
    if (state) {
      state.conversation.visible = false;
      state.manuallyHidden = true;
      clearTimeout(state.archiveTimer);
    }
  };

  constructor(
    readonly profiles: readonly FleetProfile[],
    private readonly store: AgentStateStore,
    private readonly pty: PtySessionManager,
    private readonly reserveClaudeSession?: (sessionId: string, cwd: string) => void,
    timelineOptions: FleetTimelineOptions = FleetTimeline.fromEnvironment(),
  ) {
    this.timeline = new FleetTimeline(timelineOptions);
    store.on('agentRemoved', this.onRemoved);
  }

  snapshot(): FleetSnapshot {
    return {
      available: this.pty.isAvailable(),
      reason: this.pty.unavailableReason(),
      profiles: this.profiles.map(({ id, name, provider, mode, cwd, ssh }) => ({
        id,
        name,
        provider,
        mode,
        cwd,
        ssh,
      })),
      runs: [...this.runs.values()].map(({ run: { output: _output, ...run } }) => run),
      conversations: [...this.conversations.values()].map(
        ({ conversation: { output: _output, ...conversation } }) => conversation,
      ),
      maxRunning: FLEET_MAX_RUNNING,
    };
  }

  get(id: number): FleetRun | undefined {
    return this.runs.get(id)?.run;
  }
  getConversation(id: number): FleetConversation | undefined {
    return this.conversations.get(id)?.conversation;
  }
  liveRunIds(): number[] {
    return [...this.runs.values()].filter((r) => r.run.status === 'running').map((r) => r.run.id);
  }
  ownsSession(sessionId: unknown): boolean {
    return (
      typeof sessionId === 'string' &&
      [...this.conversations.values()].some(
        (s) => s.conversation.sessionId === sessionId || s.agent.sessionId === sessionId,
      )
    );
  }

  launch(profileId: string, prompt: string): number {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error('Unknown profile');
    if (!this.pty.isAvailable())
      throw new Error(this.pty.unavailableReason() ?? 'Terminal unavailable');
    if (this.liveRunIds().length >= FLEET_MAX_RUNNING)
      throw new Error('Concurrent agent limit reached');
    // Plan eviction without mutating history. A rejected request or failed spawn must
    // leave all existing runs, conversations and their logs intact.
    const evictions = [...this.runs.values()]
      .filter(({ run }) => run.status !== 'running')
      .slice(0, Math.max(0, this.runs.size - FLEET_MAX_HISTORY + 1));
    if (this.runs.size - evictions.length >= FLEET_MAX_HISTORY)
      throw new Error('Fleet history is full');
    const retainedConversations =
      this.conversations.size -
      evictions.reduce((count, state) => count + state.conversations.size, 0);
    if (retainedConversations >= FLEET_MAX_CONVERSATIONS)
      throw new Error('Conversation limit reached; remove finished Agent groups');
    const sessionId = randomUUID();
    const launchProfile =
      profile.provider === 'claude'
        ? { ...profile, args: [...(profile.args ?? []), '--session-id', sessionId] }
        : profile;
    const command = buildFleetCommand(launchProfile, prompt);
    if (profile.provider === 'claude' && !profile.ssh)
      this.reserveClaudeSession?.(sessionId, profile.cwd);
    const id = this.store.nextAgentId.current++;
    const session = this.pty.create({ agentId: id, ...command });
    for (const eviction of evictions) this.dismiss(eviction.run.id);
    const run: FleetRun = {
      id,
      profileId,
      name: profile.name,
      provider: profile.provider,
      mode: profile.mode,
      host: profile.ssh ?? 'local',
      cwd: profile.cwd,
      status: 'running',
      activity: profile.ssh ? 'SSH connecting' : 'Starting',
      startedAt: Date.now(),
      output: '',
      ...(profile.provider === 'claude' ? { sessionId } : {}),
    };
    const state: RunState = {
      run,
      conversations: new Map(),
      bySession: new Map(),
      buffer: '',
      droppingLine: false,
      stopped: false,
      warnedUnscoped: false,
      telemetry: false,
    };
    this.runs.set(id, state);
    this.timeline.record({ runId: id, kind: 'launch', status: 'running' });
    // Reuse this placeholder for the first observed session: no duplicate startup character.
    this.createConversation(state, id, run.sessionId, prompt.trim().slice(0, 80) || profile.name);
    this.store.broadcast({ type: 'terminalSessionOpened', agentId: id });
    session.onData((chunk) => this.onData(state, chunk));
    session.onExit((exit) => {
      clearTimeout(state.idleTimer);
      if (!this.runs.has(id)) return;
      if (state.buffer && !state.droppingLine) this.onLine(state, state.buffer);
      state.buffer = '';
      run.exitCode = exit.exitCode;
      run.endedAt = Date.now();
      const failed = [...state.conversations.values()].some(
        (s) => s.conversation.status === 'failed',
      );
      run.status = state.stopped ? 'stopped' : exit.exitCode !== 0 || failed ? 'failed' : 'done';
      run.activity = run.status === 'failed' ? `Failed (exit ${exit.exitCode})` : run.status;
      for (const conversation of state.conversations.values()) {
        // Completed conversations stay completed if a sibling or the transport later fails.
        if (['running', 'waiting'].includes(conversation.conversation.status)) {
          this.finish(
            conversation,
            state.stopped ? 'stopped' : exit.exitCode !== 0 ? 'failed' : 'done',
            run.activity,
          );
        }
      }
      this.store.broadcast({ type: 'terminalSessionClosed', agentId: id, exitCode: exit.exitCode });
      this.appendRun(state, `\n[${run.activity}]\n`);
      this.timeline.record({ runId: id, kind: 'exit', status: run.status });
    });
    return id;
  }

  /** Normalized ingestion also serves integrations which emit tagged events over HTTP. */
  ingest(runId: number, raw: unknown): number | null {
    const state = this.runs.get(runId);
    if (!state || state.run.status !== 'running') throw new Error('Agent process is not running');
    const packet = parseFleetPacket(state.run.provider, raw);
    if (packet.events.length === 0) {
      this.appendRawEvent(state, 'Unknown event', raw);
      if (!packet.conversationId) return null;
    }
    let target: ConversationState | undefined;
    if (packet.conversationId) {
      const known = state.bySession.get(packet.conversationId);
      if (known !== undefined) target = state.conversations.get(known);
      else {
        const first = state.conversations.values().next().value as ConversationState;
        if (state.conversations.size === 1 && !first.conversation.sessionId) {
          target = first;
          target.conversation.sessionId = packet.conversationId;
          target.agent.sessionId = packet.conversationId;
          state.bySession.set(packet.conversationId, target.conversation.id);
          state.run.sessionId = packet.conversationId;
        } else {
          if (
            state.conversations.size >= FLEET_MAX_CONVERSATIONS_PER_RUN ||
            this.conversations.size >= FLEET_MAX_CONVERSATIONS
          )
            throw new Error('Conversation limit reached');
          target = this.createConversation(
            state,
            this.store.nextAgentId.current++,
            packet.conversationId,
            packet.title || `Conversation ${state.conversations.size + 1}`,
          );
        }
      }
    } else if (state.conversations.size === 1) target = state.conversations.values().next().value;
    else {
      if (!state.warnedUnscoped) {
        this.appendRun(
          state,
          '[Unassigned event] Multiple conversations: supply conversationId on every event.\n',
        );
        state.warnedUnscoped = true;
      }
      this.appendRawEvent(state, 'Unassigned event', raw);
      return null;
    }
    if (!target) return null;
    if (packet.conversationId) {
      state.telemetry = true;
      clearTimeout(state.idleTimer);
    }
    if (packet.title?.trim()) {
      target.conversation.title = packet.title;
      this.sendInfo(target);
    }
    for (const event of packet.events) this.apply(state, target, event);
    return target.conversation.id;
  }

  /** Hide/show is a presentation operation. It NEVER kills a shared process. */
  setConversationVisible(id: number, visible: boolean, manual = true): void {
    const state = this.conversations.get(id);
    if (!state) throw new Error('Unknown conversation');
    clearTimeout(state.archiveTimer);
    state.manuallyHidden = manual && !visible;
    if (state.conversation.visible === visible) return;
    state.conversation.visible = visible;
    if (!visible) {
      this.internalRemovals.add(id);
      this.store.delete(id);
      this.internalRemovals.delete(id);
    } else {
      this.store.set(id, state.agent);
      this.sendInfo(state);
      this.replay(state);
    }
  }

  stop(id: number): void {
    const state = this.runs.get(id);
    if (!state) throw new Error('Unknown run');
    if (state.run.status !== 'running') return;
    state.stopped = true;
    state.run.activity = 'Stopping';
    this.pty.dispose(id);
  }

  dismiss(id: number): void {
    const state = this.runs.get(id);
    if (!state) throw new Error('Unknown run');
    clearTimeout(state.idleTimer);
    this.stop(id);
    for (const [conversationId, conversation] of state.conversations) {
      clearTimeout(conversation.archiveTimer);
      this.setConversationVisible(conversationId, false);
      this.conversations.delete(conversationId);
    }
    this.runs.delete(id);
  }

  dispose(): void {
    for (const id of [...this.runs.keys()]) this.dismiss(id);
    this.store.off('agentRemoved', this.onRemoved);
  }

  private createConversation(
    run: RunState,
    id: number,
    sessionId: string | undefined,
    title: string,
  ): ConversationState {
    const now = Date.now();
    const conversation: FleetConversation = {
      id,
      runId: run.run.id,
      sessionId,
      title,
      provider: run.run.provider,
      host: run.run.host,
      cwd: run.run.cwd,
      status: 'running',
      activity: 'Starting',
      visible: true,
      startedAt: now,
      updatedAt: now,
      output: '',
    };
    const agent = createAgentState({
      id,
      sessionId: sessionId ?? randomUUID(),
      isExternal: false,
      hooksOnly: true,
      managedFleet: true,
      projectDir: run.run.cwd,
      jsonlFile: '',
      providerId: run.run.provider,
      directoryName: `${run.run.name} · ${run.run.host}`,
      hookDelivered: true,
    });
    assignPaletteIfNeeded(agent, this.store);
    const state: ConversationState = { conversation, agent, manuallyHidden: false };
    run.conversations.set(id, state);
    if (sessionId) run.bySession.set(sessionId, id);
    this.conversations.set(id, state);
    this.timeline.record({
      runId: run.run.id,
      conversationId: id,
      kind: 'conversation',
      status: 'running',
    });
    this.store.set(id, agent);
    this.sendInfo(state);
    this.store.broadcast({ type: 'agentStatus', id, status: 'active' });
    return state;
  }

  private sendInfo(state: ConversationState): void {
    const c = state.conversation;
    state.agent.fleetConversation = {
      runId: c.runId,
      title: c.title,
      provider: c.provider,
      host: c.host,
    };
    if (c.visible)
      this.store.broadcast({
        type: 'fleetConversationInfo',
        id: c.id,
        ...state.agent.fleetConversation,
      });
  }

  private replay(state: ConversationState): void {
    const { agent, conversation: c } = state;
    for (const [toolId, status] of agent.activeToolStatuses)
      this.store.broadcast({
        type: 'agentToolStart',
        id: c.id,
        toolId,
        status,
        toolName: agent.activeToolNames.get(toolId),
      });
    this.store.broadcast({
      type: 'agentStatus',
      id: c.id,
      status: agent.isWaiting ? 'waiting' : 'active',
      awaitingInput: agent.fleetAwaitingInput,
    });
  }

  private appendRawEvent(state: RunState, label: string, raw: unknown): void {
    // JSON escaping keeps embedded control characters inert; terminal escapes in
    // any resulting text are stripped as an additional safeguard.
    const text = JSON.stringify(raw) ?? String(raw);
    this.appendRun(state, `[${label}] ${stripVTControlCharacters(text)}\n`);
  }

  private appendRun(state: RunState, text: string): void {
    state.run.output = (state.run.output + text).slice(-FLEET_MAX_OUTPUT);
  }
  private append(state: RunState, target: ConversationState, text: string): void {
    target.conversation.output = (target.conversation.output + text).slice(-FLEET_MAX_OUTPUT);
    this.appendRun(state, `[${target.conversation.title}] ${text}`);
  }

  private onData(state: RunState, chunk: string): void {
    if (!this.runs.has(state.run.id)) return;
    if (state.run.mode === 'interactive') {
      // Terminal traffic cannot identify conversations. Use estimates only until a tagged integration takes over.
      const target = state.conversations.values().next().value as ConversationState;
      if (state.conversations.size === 1 && !state.telemetry) {
        this.append(state, target, stripVTControlCharacters(chunk));
        this.activate(target);
        target.conversation.activity = 'Terminal output (activity estimate)';
        clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => {
          target.conversation.activity = 'Terminal quiet (not a completion signal)';
          this.clearTools(target, false);
        }, FLEET_ACTIVITY_TIMEOUT);
      } else this.appendRun(state, stripVTControlCharacters(chunk));
      return;
    }
    for (const piece of chunk.split(/(?<=\n)/)) {
      if (!state.droppingLine) {
        state.buffer += piece;
        if (state.buffer.length > FLEET_MAX_LINE) {
          state.buffer = '';
          state.droppingLine = true;
          this.appendRun(state, '[Oversized event skipped]\n');
        }
      }
      if (piece.endsWith('\n')) {
        if (!state.droppingLine) this.onLine(state, state.buffer);
        state.buffer = '';
        state.droppingLine = false;
      }
    }
  }

  private onLine(state: RunState, line: string): void {
    const clean = stripVTControlCharacters(line).trim();
    if (!clean) return;
    let raw: unknown;
    try {
      raw = JSON.parse(clean);
    } catch {
      if (state.conversations.size === 1)
        this.append(state, state.conversations.values().next().value!, clean + '\n');
      else this.appendRun(state, clean + '\n');
      return;
    }
    try {
      this.ingest(state.run.id, raw);
    } catch (error) {
      this.appendRun(
        state,
        `[Event rejected] ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private activate(state: ConversationState): void {
    clearTimeout(state.archiveTimer);
    state.conversation.status = 'running';
    state.agent.isWaiting = false;
    state.agent.fleetAwaitingInput = false;
    if (!state.conversation.visible && !state.manuallyHidden)
      this.setConversationVisible(state.conversation.id, true, false);
    if (state.conversation.visible)
      this.store.broadcast({ type: 'agentStatus', id: state.conversation.id, status: 'active' });
  }

  private apply(run: RunState, state: ConversationState, event: FleetEvent): void {
    const { conversation: c, agent } = state;
    const id = c.id;
    c.updatedAt = Date.now();
    switch (event.kind) {
      case 'session':
        break; // identity is resolved before normalizing content
      case 'turnStart':
        this.activate(state);
        c.activity = 'Working';
        break;
      case 'text':
        if (c.status === 'done' || c.status === 'waiting') {
          this.activate(state);
          c.activity = 'Working';
        }
        this.append(run, state, event.text + '\n');
        break;
      case 'error':
        this.append(run, state, `[Error] ${event.message}\n`);
        this.finish(state, 'failed', event.message);
        break;
      case 'done':
        if (c.status !== 'failed') this.finish(state, 'done', 'Done');
        break;
      case 'waiting':
        clearTimeout(state.archiveTimer);
        c.status = 'waiting';
        c.activity = event.message;
        this.clearTools(state, true);
        if (!c.visible && !state.manuallyHidden) this.setConversationVisible(id, true, false);
        break;
      case 'tool': {
        this.activate(state);
        const status = `${event.name}${event.detail ? ': ' + event.detail : ''}`;
        c.activity = status;
        agent.activeToolIds.add(event.id);
        agent.activeToolStatuses.set(event.id, status);
        agent.activeToolNames.set(event.id, animationTool(event.name));
        if (c.visible)
          this.store.broadcast({
            type: 'agentToolStart',
            id,
            toolId: event.id,
            toolName: animationTool(event.name),
            status,
          });
        this.append(run, state, `[Tool] ${status}\n`);
        break;
      }
      case 'toolEnd':
        agent.activeToolIds.delete(event.id);
        agent.activeToolStatuses.delete(event.id);
        agent.activeToolNames.delete(event.id);
        if (c.visible) this.store.broadcast({ type: 'agentToolDone', id, toolId: event.id });
        if (!agent.activeToolIds.size && c.status === 'running') c.activity = 'Working';
        break;
    }
    run.run.activity = `${run.conversations.size} conversation(s)`;
    if (event.kind !== 'done' && event.kind !== 'error')
      this.timeline.record(
        { runId: run.run.id, conversationId: c.id, kind: event.kind, status: c.status },
        event.kind === 'tool' || event.kind === 'toolEnd' ? event.id : undefined,
      );
  }

  private finish(
    state: ConversationState,
    status: 'done' | 'failed' | 'stopped',
    activity: string,
  ): void {
    state.conversation.status = status;
    state.conversation.activity = activity;
    state.conversation.updatedAt = Date.now();
    this.timeline.record({
      runId: state.conversation.runId,
      conversationId: state.conversation.id,
      kind: status === 'failed' ? 'error' : status,
      status,
    });
    this.clearTools(state, status === 'failed');
    clearTimeout(state.archiveTimer);
    // Keep failures and questions visible for attention; completed/stopped work goes to history.
    if (status === 'failed' && !state.conversation.visible && !state.manuallyHidden) {
      this.setConversationVisible(state.conversation.id, true, false);
    }
    if (status !== 'failed' && state.conversation.visible && !state.manuallyHidden) {
      state.archiveTimer = setTimeout(
        () => this.setConversationVisible(state.conversation.id, false, false),
        FLEET_ARCHIVE_DELAY,
      );
      state.archiveTimer.unref?.();
    }
  }

  private clearTools(state: ConversationState, awaitingInput: boolean): void {
    const { agent, conversation: c } = state;
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.isWaiting = true;
    agent.fleetAwaitingInput = awaitingInput;
    if (c.visible) {
      this.store.broadcast({ type: 'agentToolsClear', id: c.id });
      this.store.broadcast({ type: 'agentStatus', id: c.id, status: 'waiting', awaitingInput });
    }
  }
}
