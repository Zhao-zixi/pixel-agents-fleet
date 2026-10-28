import { execFileSync } from 'node:child_process';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FleetProfile } from '../../core/src/fleet.js';
import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { normalizeFleetEvent } from '../src/fleet/events.js';
import {
  buildFleetCommand,
  FLEET_MAX_HISTORY,
  FLEET_MAX_LINE,
  FLEET_MAX_OUTPUT,
  parseProfiles,
} from '../src/fleet/profiles.js';
import { registerFleetRoutes } from '../src/fleet/routes.js';
import { FleetService } from '../src/fleet/service.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';

const profile: FleetProfile = {
  id: 'codex',
  name: 'Coder',
  provider: 'codex',
  mode: 'task',
  cwd: '/tmp',
};

class FakePty implements IPty {
  pid = 100;
  dataListener: (data: string) => void = () => {};
  exitListener: (exit: { exitCode: number }) => void = () => {};
  killed = false;
  onData(fn: (data: string) => void) {
    this.dataListener = fn;
  }
  onExit(fn: (exit: { exitCode: number }) => void) {
    this.exitListener = fn;
  }
  write() {}
  resize() {}
  kill() {
    this.killed = true;
    this.exitListener({ exitCode: 129 });
  }
  send(event: unknown) {
    this.dataListener(JSON.stringify(event) + '\r\n');
  }
}
const cleanup: (() => void)[] = [];
function harness(profiles: FleetProfile[] = [profile]) {
  const children: FakePty[] = [];
  const module: PtyModule = {
    spawn: () => {
      const p = new FakePty();
      children.push(p);
      return p;
    },
  };
  const pty = new PtySessionManager(() => ({ module, moduleId: 'fake', reason: null }));
  const store = new AgentStateStore();
  const broadcasts: Record<string, unknown>[] = [];
  store.on('broadcast', (m) => broadcasts.push(m));
  const fleet = new FleetService(profiles, store, pty);
  cleanup.push(() => fleet.dispose());
  return { children, store, fleet, pty, broadcasts };
}
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
});

describe('fleet profiles and SSH boundary', () => {
  it('rejects duplicate IDs, relative remote paths, SSH option injection and NUL', () => {
    for (const invalid of [
      [profile, profile],
      [{ ...profile, ssh: '-oProxyCommand=touch /tmp/bad' }],
      [{ ...profile, ssh: 'user@host;pwd' }],
      [{ ...profile, ssh: 'host', cwd: '~/project' }],
      [{ ...profile, command: 'node\0bad' }],
      [{ ...profile, port: 22 }],
    ])
      expect(() => parseProfiles(invalid)).toThrow();
  });
  it('supports SSH aliases, ports and IPv6', () => {
    for (const ssh of ['dev-box', 'dev@server', 'dev@2001:db8::1', '[2001:db8::1]']) {
      expect(parseProfiles([{ ...profile, ssh, port: 2222 }])[0].ssh).toBe(ssh);
    }
  });
  it('transports hostile-looking args literally through both remote shells', () => {
    const prompt = "a 'quote'\n$(printf BAD) `printf BAD` ; & 零";
    const p: FleetProfile = {
      ...profile,
      provider: 'custom',
      ssh: 'remote',
      command: 'printf',
      args: ['%s', '{prompt}'],
    };
    const cmd = buildFleetCommand(p, prompt);
    const output = execFileSync('sh', ['-c', cmd.args.at(-1)!], { encoding: 'utf8' });
    expect(output).toBe(prompt);
    expect(cmd.args).toContain('StrictHostKeyChecking=yes');
    expect(cmd.args).toContain('BatchMode=yes');
  });
  it('keeps task arguments separate and does not bypass CLI permissions', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'opencode'] as const) {
      const cmd = buildFleetCommand({ ...profile, provider }, '-potential-option');
      expect(cmd.args.join(' ')).not.toMatch(/yolo|skip-permissions|--auto/);
      expect(cmd.args).toContain(
        provider === 'gemini' ? '--prompt=-potential-option' : '-potential-option',
      );
    }
  });
});

describe('native event adapters', () => {
  it('reads Codex command events, text, failures and session identity', () => {
    expect(
      normalizeFleetEvent('codex', { type: 'thread.started', thread_id: 'thread-a' }),
    ).toContainEqual({ kind: 'session', id: 'thread-a' });
    expect(
      normalizeFleetEvent('codex', {
        type: 'item.started',
        item: { id: '1', type: 'command_execution', command: 'ls' },
      }),
    ).toContainEqual({ kind: 'tool', id: '1', name: 'command_execution', detail: 'ls' });
    expect(
      normalizeFleetEvent('codex', { type: 'turn.failed', error: { message: 'limit' } }),
    ).toContainEqual({ kind: 'error', message: 'limit' });
  });
  it('reads Claude tool use/results and does not lose explicit result failures', () => {
    expect(
      normalizeFleetEvent('claude', {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'c', name: 'Read', input: { file_path: 'x.ts' } }],
        },
      }),
    ).toContainEqual({ kind: 'tool', id: 'c', name: 'Read', detail: 'x.ts' });
    expect(
      normalizeFleetEvent('claude', {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'c' }] },
      }),
    ).toContainEqual({ kind: 'toolEnd', id: 'c' });
    expect(
      normalizeFleetEvent('claude', { type: 'result', is_error: true, result: 'denied' }),
    ).toContainEqual({ kind: 'error', message: 'denied' });
  });
  it('reads Gemini tools and OpenCode completed tools without mistaking a step for run completion', () => {
    expect(
      normalizeFleetEvent('gemini', {
        type: 'tool_use',
        tool_id: 'g',
        tool_name: 'read_file',
        parameters: { file_path: 'x' },
      }),
    ).toContainEqual({ kind: 'tool', id: 'g', name: 'read_file', detail: 'x' });
    expect(
      normalizeFleetEvent('opencode', {
        type: 'tool_use',
        part: { callID: 'o', tool: 'read', state: { status: 'completed', input: { path: 'x' } } },
      }),
    ).toContainEqual({ kind: 'toolEnd', id: 'o' });
    expect(normalizeFleetEvent('opencode', { type: 'step_finish' })).toEqual([]);
    expect(normalizeFleetEvent('codex', { type: 'future.event' })).toEqual([]);
  });
});

describe('concurrent managed agents', () => {
  it('isolates identical tool IDs between simultaneous local and SSH runs', () => {
    const { fleet, children, store } = harness([
      profile,
      { ...profile, id: 'remote', ssh: 'dev-box' },
    ]);
    const a = fleet.launch('codex', 'one');
    const b = fleet.launch('remote', 'two');
    const event = { type: 'item.started', item: { id: 'same', type: 'file_change' } };
    children[0].send(event);
    children[1].send(event);
    children[0].send({ type: 'item.completed', item: { id: 'same' } });
    expect(store.get(a)?.activeToolIds.size).toBe(0);
    expect(store.get(b)?.activeToolIds.has('same')).toBe(true);
    fleet.stop(a);
    expect(children[0].killed).toBe(true);
    expect(children[1].killed).toBe(false);
    expect(fleet.get(a)?.status).toBe('stopped');
    expect(fleet.get(b)?.status).toBe('running');
  });
  it('handles split JSON, missing trailing newline and a zero-exit provider error', () => {
    const { fleet, children, store } = harness();
    const id = fleet.launch('codex', 'go');
    children[0].dataListener('{"type":"item.com');
    children[0].dataListener('pleted","item":{"type":"agent_message","text":"hello"}}\r\n');
    children[0].dataListener('{"type":"turn.failed","error":{"message":"quota"}}');
    children[0].exitListener({ exitCode: 0 });
    expect(fleet.get(id)?.output).toContain('hello');
    expect(fleet.get(id)?.status).toBe('failed');
    expect(store.has(id)).toBe(true);
    expect(store.get(id)?.activeToolIds.size).toBe(0);
    fleet.dismiss(id);
    expect(store.has(id)).toBe(false);
  });
  it('bounds output, recovers after oversized JSON and reports SSH failures', () => {
    const { fleet, children } = harness();
    const id = fleet.launch('codex', 'go');
    children[0].dataListener('x'.repeat(FLEET_MAX_LINE + 1));
    children[0].dataListener('\n');
    children[0].send({ type: 'item.completed', item: { type: 'agent_message', text: 'recover' } });
    expect(fleet.get(id)?.output).toContain('recover');
    children[0].dataListener('text\n'.repeat(FLEET_MAX_OUTPUT));
    expect(fleet.get(id)!.output.length).toBeLessThanOrEqual(FLEET_MAX_OUTPUT);
    children[0].exitListener({ exitCode: 255 });
    expect(fleet.get(id)?.status).toBe('failed');
  });
  it('hides a character without killing its shared process through the existing office UI', () => {
    const { fleet, children, store } = harness();
    const id = fleet.launch('codex', 'go');
    handleClientMessage({ type: 'closeAgent', id }, () => {}, {
      store,
      fleet,
      cache: null,
      privileged: true,
    });
    expect(children[0].killed).toBe(false);
    expect(fleet.get(id)?.status).toBe('running');
    expect(fleet.getConversation(id)?.visible).toBe(false);
  });
  it('preserves done characters and suppresses fleet persistence', () => {
    const { fleet, children, store } = harness();
    const id = fleet.launch('codex', 'go');
    children[0].send({ type: 'turn.completed' });
    expect(fleet.get(id)?.status).toBe('running'); // process has not actually exited
    children[0].exitListener({ exitCode: 0 });
    expect(fleet.get(id)?.status).toBe('done');
    expect(store.get(id)?.managedFleet).toBe(true);
  });
});

describe('atomic history eviction', () => {
  it.each(['', 'bad\0prompt'])('preserves full history when prompt %j is rejected', (prompt) => {
    vi.useFakeTimers();
    const { fleet, children } = harness();
    for (let i = 0; i < FLEET_MAX_HISTORY; i++) {
      fleet.launch('codex', 'valid');
      children.at(-1)!.exitListener({ exitCode: 0 });
    }
    const before = fleet.snapshot();
    const oldest = before.runs[0].id;
    const output = fleet.get(oldest)!.output;
    expect(() => fleet.launch('codex', prompt)).toThrow();
    expect(fleet.snapshot()).toEqual(before);
    expect(fleet.get(oldest)!.output).toBe(output);
    expect(children).toHaveLength(FLEET_MAX_HISTORY);
  });

  it('preserves history on spawn failure and evicts only after a successful launch', () => {
    vi.useFakeTimers();
    const { fleet, children, pty } = harness();
    for (let i = 0; i < FLEET_MAX_HISTORY; i++) {
      fleet.launch('codex', 'valid');
      children.at(-1)!.exitListener({ exitCode: 0 });
    }
    const before = fleet.snapshot();
    const oldest = before.runs[0].id;
    vi.spyOn(pty, 'create').mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    expect(() => fleet.launch('codex', 'valid')).toThrow('spawn failed');
    expect(fleet.snapshot()).toEqual(before);
    expect(children).toHaveLength(FLEET_MAX_HISTORY);
    const next = fleet.launch('codex', 'valid');
    expect(fleet.get(oldest)).toBeUndefined();
    expect(fleet.getConversation(oldest)).toBeUndefined();
    expect(fleet.get(next)?.status).toBe('running');
    expect(fleet.snapshot().runs).toHaveLength(FLEET_MAX_HISTORY);
  });
});

describe('fleet HTTP permissions', () => {
  it('requires token AND trusted host/origin; rejects commands outside configured profiles', async () => {
    const { fleet, children } = harness();
    const app = Fastify();
    registerFleetRoutes(app, fleet, 'test-token', new Set(['localhost']));
    const headers = { authorization: 'Bearer test-token', host: 'localhost' };
    try {
      expect((await app.inject({ url: '/api/fleet' })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: '/api/fleet', headers: { ...headers, host: 'evil.test' } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/api/fleet',
            headers: { ...headers, origin: 'https://evil.test' },
          })
        ).statusCode,
      ).toBe(403);
      expect((await app.inject({ url: '/api/fleet', headers })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/fleet/runs',
            headers,
            payload: { profileId: 'unknown', prompt: 'x' },
          })
        ).statusCode,
      ).toBe(400);
      const launch = await app.inject({
        method: 'POST',
        url: '/api/fleet/runs',
        headers,
        payload: { profileId: 'codex', prompt: 'go' },
      });
      expect(launch.statusCode).toBe(201);
      expect(children.length).toBe(1);
      const id = launch.json().id;
      expect(
        (await app.inject({ method: 'POST', url: `/api/fleet/runs/${id}/stop`, headers }))
          .statusCode,
      ).toBe(200);
      expect(fleet.get(id)?.status).toBe('stopped');
    } finally {
      await app.close();
    }
  });
});

const custom = { ...profile, id: 'custom', provider: 'custom' as const, command: 'node' };
const packet = (conversationId: string, event: unknown, title = conversationId) => ({
  type: 'fleet.event',
  conversationId,
  title,
  event,
});

describe('multiplexed conversations', () => {
  it('reuses the startup character and isolates interleaved tool IDs, output and completion', () => {
    const { fleet, children, store } = harness([custom]);
    const run = fleet.launch('custom', 'start');
    const first = fleet.ingest(run, packet('a', { type: 'tool_start', id: 'same', name: 'Read' }));
    const second = fleet.ingest(run, packet('b', { type: 'tool_start', id: 'same', name: 'Edit' }));
    expect(first).toBe(run);
    expect(second).not.toBe(first);
    expect(children).toHaveLength(1);
    expect(store.size).toBe(2);
    fleet.ingest(run, packet('a', { type: 'text', text: 'only-a' }));
    fleet.ingest(run, packet('b', { type: 'text', text: 'only-b' }));
    fleet.ingest(run, packet('a', { type: 'done' }));
    expect(store.get(first!)?.activeToolIds.size).toBe(0);
    expect(store.get(second!)?.activeToolIds.has('same')).toBe(true);
    expect(fleet.getConversation(first!)?.output).not.toContain('only-b');
    expect(fleet.getConversation(second!)?.output).not.toContain('only-a');
    expect(fleet.getConversation(first!)?.status).toBe('done');
    expect(fleet.getConversation(second!)?.status).toBe('running');
    expect(fleet.ingest(run, packet('b', { type: 'text', text: 'again' }))).toBe(second);
    expect(fleet.snapshot().conversations).toHaveLength(2);
  });
  it('scopes matching session IDs to their process and does not guess untagged events', () => {
    const { fleet, store } = harness([custom]);
    const a = fleet.launch('custom', 'a');
    const b = fleet.launch('custom', 'b');
    expect(fleet.ingest(a, packet('same', { type: 'conversation_start' }))).toBe(a);
    expect(fleet.ingest(b, packet('same', { type: 'conversation_start' }))).toBe(b);
    const sibling = fleet.ingest(
      a,
      packet('other', { type: 'tool_start', id: '1', name: 'Read' }),
    )!;
    expect(fleet.ingest(a, { type: 'done' })).toBeNull();
    expect(store.get(sibling)?.activeToolIds.size).toBe(1);
    expect(fleet.get(a)?.output).toContain('Unassigned');
    expect(fleet.getConversation(b)?.status).toBe('running');
  });
  it('retains unassigned and unknown JSON only in the bounded process log', () => {
    const { fleet, children } = harness([custom]);
    const run = fleet.launch('custom', 'start');
    const first = fleet.ingest(run, packet('a', { type: 'text', text: 'scoped-a' }))!;
    const second = fleet.ingest(run, packet('b', { type: 'text', text: 'scoped-b' }))!;
    const beforeA = { ...fleet.getConversation(first)! };
    const beforeB = { ...fleet.getConversation(second)! };
    children[0].send({ type: 'text', text: 'unscoped-text' });
    children[0].send({ type: 'error', message: 'unscoped-error' });
    children[0].send({ type: 'future.event', diagnostic: 'unknown-body' });
    children[0].send(packet('a', { type: 'future.event', diagnostic: 'unknown-scoped' }));
    const output = fleet.get(run)!.output;
    for (const marker of ['unscoped-text', 'unscoped-error', 'unknown-body', 'unknown-scoped'])
      expect(output.split(marker)).toHaveLength(2);
    expect(output.split('scoped-a')).toHaveLength(2);
    expect(fleet.getConversation(first)).toEqual(beforeA);
    expect(fleet.getConversation(second)).toEqual(beforeB);
    // HTTP integrations use the same ingestion path and get the same preservation.
    expect(fleet.ingest(run, { type: 'text', text: 'http-unassigned' })).toBeNull();
    expect(fleet.get(run)!.output).toContain('http-unassigned');
    fleet.ingest(run, {
      type: 'future.event',
      diagnostic: '\u001b[31m' + 'x'.repeat(FLEET_MAX_OUTPUT * 2),
    });
    expect(fleet.get(run)!.output).not.toContain('\u001b');
    expect(fleet.get(run)!.output.length).toBeLessThanOrEqual(FLEET_MAX_OUTPUT);
    expect(fleet.getConversation(first)).toEqual(beforeA);
    expect(fleet.getConversation(second)).toEqual(beforeB);
  });
  it('supports native identities and legacy untagged events for a single session', () => {
    const { fleet, children } = harness();
    const run = fleet.launch('codex', 'x');
    children[0].send({ type: 'thread.started', thread_id: 'thread-1' });
    children[0].send({ type: 'item.completed', item: { type: 'agent_message', text: 'legacy' } });
    expect(fleet.getConversation(run)?.sessionId).toBe('thread-1');
    expect(fleet.getConversation(run)?.output).toContain('legacy');
    children[0].send({ type: 'turn.started', thread_id: 'thread-2' });
    expect(fleet.snapshot().conversations).toHaveLength(2);
  });
  it('archives completed characters, revives the same identity, and respects manual hiding', () => {
    vi.useFakeTimers();
    const { fleet, store, children } = harness([custom]);
    const run = fleet.launch('custom', 'x');
    const id = fleet.ingest(run, packet('a', { type: 'done' }))!;
    const palette = store.get(id)?.palette;
    vi.advanceTimersByTime(15000);
    expect(store.has(id)).toBe(false);
    expect(children[0].killed).toBe(false);
    expect(fleet.getConversation(id)?.visible).toBe(false);
    expect(fleet.ingest(run, packet('a', { type: 'turn_start' }))).toBe(id);
    expect(store.get(id)?.palette).toBe(palette);
    fleet.setConversationVisible(id, false);
    fleet.ingest(run, packet('a', { type: 'tool_start', id: 'x', name: 'Read' }));
    expect(store.has(id)).toBe(false);
    fleet.setConversationVisible(id, true);
    expect(store.get(id)?.activeToolIds.has('x')).toBe(true);
    fleet.ingest(run, packet('a', { type: 'done' }));
    vi.advanceTimersByTime(15000);
    fleet.ingest(run, packet('a', { type: 'text', text: 'New text-only turn' }));
    expect(store.has(id)).toBe(true);
    expect(fleet.getConversation(id)?.status).toBe('running');
    fleet.setConversationVisible(id, false);
    fleet.ingest(run, packet('a', { type: 'done' }));
    vi.advanceTimersByTime(15000);
    fleet.ingest(run, packet('a', { type: 'turn_start' }));
    expect(store.has(id)).toBe(false); // completion must not undo an explicit hide
    fleet.setConversationVisible(id, true);
    fleet.ingest(run, packet('a', { type: 'done' }));
    vi.advanceTimersByTime(15000);
    fleet.ingest(run, packet('a', { type: 'waiting', message: 'Need attention' }));
    expect(store.has(id)).toBe(true);
  });
  it('keeps interactive terminal silence separate from explicit waiting and stops estimates after telemetry', () => {
    vi.useFakeTimers();
    const { fleet, children, store } = harness([{ ...custom, mode: 'interactive' }]);
    const run = fleet.launch('custom', '');
    children[0].dataListener('terminal output');
    vi.advanceTimersByTime(30000);
    expect(fleet.getConversation(run)?.status).toBe('running');
    expect(store.get(run)?.fleetAwaitingInput).toBe(false);
    fleet.ingest(run, packet('a', { type: 'waiting', message: 'Approval needed' }));
    children[0].dataListener('terminal chatter');
    vi.advanceTimersByTime(30000);
    expect(fleet.getConversation(run)?.status).toBe('waiting');
    expect(store.get(run)?.fleetAwaitingInput).toBe(true);
    expect(fleet.getConversation(run)?.output).not.toContain('chatter');
  });
  it('replays shared terminal metadata and waiting state; hidden owners retain a live terminal on reload', () => {
    const { fleet, store, pty } = harness([custom]);
    const run = fleet.launch('custom', 'x');
    fleet.ingest(run, packet('a', { type: 'turn_start' }));
    const sibling = fleet.ingest(run, packet('b', { type: 'waiting', message: 'Need input' }))!;
    fleet.setConversationVisible(run, false);
    const messages: Record<string, unknown>[] = [];
    resendAgentActivity((m) => messages.push(m), store);
    expect(messages).toContainEqual({
      type: 'fleetConversationInfo',
      id: sibling,
      runId: run,
      title: 'b',
      provider: 'custom',
      host: 'local',
    });
    expect(messages).toContainEqual({
      type: 'agentStatus',
      id: sibling,
      status: 'waiting',
      awaitingInput: true,
    });
    handleClientMessage({ type: 'webviewReady' }, (m) => messages.push(m), {
      store,
      fleet,
      ptyManager: pty,
      cache: null,
      privileged: true,
    });
    expect(messages).toContainEqual({ type: 'terminalSessionOpened', agentId: run });
    expect(store.has(run)).toBe(false);
  });
  it('stops every active sibling but preserves completed results', () => {
    const { fleet } = harness([custom]);
    const run = fleet.launch('custom', 'x');
    fleet.ingest(run, packet('a', { type: 'done' }));
    const b = fleet.ingest(run, packet('b', { type: 'waiting' }))!;
    fleet.stop(run);
    expect(fleet.getConversation(run)?.status).toBe('done');
    expect(fleet.getConversation(b)?.status).toBe('stopped');
    expect(fleet.get(run)?.status).toBe('stopped');
  });
  it('rejects malformed envelopes and bounds conversation creation', () => {
    const { fleet, children } = harness([custom]);
    const run = fleet.launch('custom', 'x');
    for (const raw of [
      { type: 'fleet.event', event: {} },
      packet('bad\n', {}),
      packet('valid', []),
      packet('x'.repeat(201), {}),
    ]) {
      expect(() => fleet.ingest(run, raw)).toThrow();
      children[0].send(raw); // rejected stream input must not crash the process
    }
    for (let i = 0; i < 64; i++) fleet.ingest(run, packet(String(i), { type: 'turn_start' }));
    expect(() => fleet.ingest(run, packet('overflow', {}))).toThrow('Conversation limit');
    expect(fleet.snapshot().conversations).toHaveLength(64);
    expect(fleet.get(run)?.status).toBe('running');
  });
  it('authenticates ingestion and visibility APIs and keeps process cancellation separate', async () => {
    const { fleet, children } = harness([custom]);
    const run = fleet.launch('custom', 'x');
    const app = Fastify();
    registerFleetRoutes(app, fleet, 'secret', new Set(['localhost']));
    const headers = { host: 'localhost', authorization: 'Bearer secret' };
    try {
      const url = `/api/fleet/runs/${run}/events`;
      const payload = packet('first', { type: 'text', text: 'one' });
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload,
            headers: { ...headers, origin: 'https://evil.test' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url, payload, headers })).json().conversationId,
      ).toBe(run);
      expect(
        (await app.inject({ method: 'POST', url, payload: { type: 'fleet.event' }, headers }))
          .statusCode,
      ).toBe(400);
      const visibility = `/api/fleet/conversations/${run}/visibility`;
      expect(
        (await app.inject({ method: 'POST', url: visibility, payload: { visible: false } }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: visibility,
            payload: { visible: false },
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(children[0].killed).toBe(false);
      const detail = await app.inject({ url: `/api/fleet/conversations/${run}`, headers });
      expect(detail.json().output).toContain('one');
      expect(detail.json().visible).toBe(false);
    } finally {
      await app.close();
    }
  });
});
