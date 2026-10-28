import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { FleetProfile } from '../../core/src/fleet.js';
import { timelineStateAt } from '../../core/src/fleetTimeline.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  diagnoseProfile,
  diagnosticCommand,
  initialTransport,
  transportExit,
  transportOutput,
} from '../src/fleet/health.js';
import { registerFleetRoutes } from '../src/fleet/routes.js';
import { FleetService } from '../src/fleet/service.js';
import type { IPty } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';

const profile: FleetProfile = {
  id: 'remote',
  name: 'Remote',
  provider: 'custom',
  mode: 'task',
  cwd: '/project',
  ssh: 'user@host',
  command: 'agent-cli',
  args: ['--danger', '{prompt}'],
};

describe('Fleet SSH health evidence', () => {
  it('does not infer remote liveness from output or a quiet channel', () => {
    const transport = initialTransport(true);
    expect(transport).toEqual({ kind: 'ssh', state: 'connecting', remoteState: 'unknown' });
    transportOutput(transport, 123);
    expect(transport.lastOutputAt).toBe(123);
    expect(transport.remoteState).toBe('unknown');
    transportExit(transport, 255, false);
    transportOutput(transport, 456);
    expect(transport.lastOutputAt).toBe(123);
    expect(transport).toMatchObject({
      state: 'closed',
      remoteState: 'unknown',
      reason: 'ssh-exit-255',
    });
  });
  it('reports regular exit and preserves uncertainty on local SSH stop', () => {
    const transport = initialTransport(true);
    transportExit(transport, 1, false);
    expect(transport.remoteState).toBe('exited');
    transportExit(transport, 129, true);
    expect(transport.remoteState).toBe('unknown');
    expect(transport.reason).toBe('local-stop');
  });
  it('builds a strict bounded diagnostic without task arguments or running CLI', () => {
    const command = diagnosticCommand({ ...profile, port: 2222, cwd: "/x'; printf BAD; '" });
    expect(command.command).toBe('ssh');
    expect(command.args).toContain('StrictHostKeyChecking=yes');
    expect(command.args).toContain('BatchMode=yes');
    expect(command.args).toContain('-T');
    expect(command.args.slice(-3, -1)).toEqual(['--', 'user@host']);
    expect(command.args.at(-1)).toContain('command -v');
    expect(command.args.join(' ')).not.toContain('--danger');
    expect(command.args.join(' ')).not.toContain('{prompt}');
    expect(command.args.at(-1)).not.toContain('exec agent-cli');
    expect(() => diagnosticCommand({ ...profile, ssh: undefined })).toThrow();
  });
  it.each([
    [0, 'FLEET_CONNECTED\nFLEET_CWD\nFLEET_EXECUTABLE\n', '', false, 'ok'],
    [21, 'FLEET_CONNECTED\n', '', false, 'cwd-unavailable'],
    [22, 'FLEET_CONNECTED\nFLEET_CWD\n', '', false, 'executable-unavailable'],
    [255, '', 'Permission denied (publickey). SECRET', false, 'authentication-failed'],
    [255, '', 'Host key verification failed. SECRET', false, 'host-key-unverified'],
    [null, '', 'SECRET', true, 'timeout'],
    [255, '', 'Connection refused SECRET', false, 'connection-unconfirmed'],
  ] as const)(
    'classifies diagnostic outcome without exposing stderr (%s)',
    async (code, stdout, stderr, timedOut, reason) => {
      const runner = vi.fn(async () => ({ code, stdout, stderr, timedOut }));
      const result = await diagnoseProfile(profile, runner);
      expect(result.reason).toBe(reason);
      expect(JSON.stringify(result)).not.toContain('SECRET');
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  it('marks lost SSH execution unknown and retains completed sibling state', () => {
    let onData: (data: string) => void = () => {};
    let onExit: (exit: { exitCode: number }) => void = () => {};
    const child = {
      pid: 100,
      onData: (fn: typeof onData) => {
        onData = fn;
      },
      onExit: (fn: typeof onExit) => {
        onExit = fn;
      },
      write() {},
      resize() {},
      kill() {},
    } as IPty;
    const pty = new PtySessionManager(() => ({
      module: { spawn: () => child },
      moduleId: 'fake',
      reason: null,
    }));
    const fleet = new FleetService([profile], new AgentStateStore(), pty);
    const id = fleet.launch('remote', 'task');
    const send = (conversationId: string, event: unknown) =>
      onData(JSON.stringify({ type: 'fleet.event', conversationId, event }) + '\n');
    send('done', { type: 'done' });
    send('working', { type: 'text', text: 'hello' });
    onExit({ exitCode: 255 });
    expect(fleet.get(id)?.status).toBe('unknown');
    expect(fleet.get(id)?.transport?.remoteState).toBe('unknown');
    const statuses = fleet.snapshot().conversations.map((c) => c.status);
    expect(statuses).toEqual(['done', 'unknown']);
    // Integrated history must preserve ambiguous SSH termination, not rewrite it
    // as success/failure or invalidate a completed sibling.
    const history = fleet.timeline.snapshot();
    const states = timelineStateAt(history.events, history.events.at(-1)!.sequence, history.epoch);
    expect(states.find((item) => item.conversationId === undefined)?.status).toBe('unknown');
    expect(
      states.filter((item) => item.conversationId !== undefined).map((item) => item.status),
    ).toEqual(['done', 'unknown']);
    expect(JSON.stringify(history)).not.toContain('user@host');
    expect(JSON.stringify(history)).not.toContain('/project');
    expect(fleet.liveRunIds()).toEqual([]);
    fleet.dispose();
  });

  it('requires authorization and trusted origin before any explicit diagnostic', async () => {
    const app = Fastify();
    const fleet = { diagnose: vi.fn(async () => ({ reason: 'ok' })) } as unknown as FleetService;
    registerFleetRoutes(app, fleet, 'secret', new Set(['localhost']));
    const denied = await app.inject({
      method: 'POST',
      url: '/api/fleet/profiles/remote/diagnose',
      headers: { host: 'localhost' },
    });
    expect(denied.statusCode).toBe(401);
    expect(fleet.diagnose).not.toHaveBeenCalled();
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/fleet/profiles/remote/diagnose',
      headers: { host: 'localhost', authorization: 'Bearer secret' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(fleet.diagnose).toHaveBeenCalledWith('remote');
    await app.close();
  });
});
