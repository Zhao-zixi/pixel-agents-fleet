import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { timelineStateAt } from '../../core/src/fleetTimeline.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { registerFleetRoutes } from '../src/fleet/routes.js';
import { FleetService } from '../src/fleet/service.js';
import { FleetTimeline } from '../src/fleet/timeline.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';

const directories: string[] = [];
function journal() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-timeline-'));
  directories.push(dir);
  return path.join(dir, 'history.jsonl');
}
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

describe('Fleet timeline privacy, retention and recovery', () => {
  it('sequences interleaved conversations and scopes reused tool identifiers', () => {
    const timeline = new FleetTimeline();
    for (const conversationId of [1, 2, 3])
      timeline.record(
        { runId: 1, conversationId, kind: 'tool', status: 'running' },
        'same-secret-tool',
      );
    timeline.record(
      { runId: 1, conversationId: 1, kind: 'toolEnd', status: 'running' },
      'same-secret-tool',
    );
    const events = timeline.snapshot().events;
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(events.slice(0, 3).map((e) => e.toolRef)).size).toBe(3);
    expect(events[0].toolRef).toBe(events[3].toolRef);
    expect(JSON.stringify(events)).not.toContain('same-secret-tool');
  });
  it('recovers complete records around corrupt/torn rows and appends safely', () => {
    const file = journal();
    const first = new FleetTimeline({ file });
    first.record({ runId: 1, kind: 'launch', status: 'running' });
    appendFileSync(file, '{"sequence":');
    const second = new FleetTimeline({ file });
    expect(second.snapshot().warning).toContain('recovered');
    expect(second.snapshot().events).toHaveLength(1);
    expect(timelineStateAt(second.snapshot().events, 1, second.epoch)[0].displayStatus).toBe(
      'interrupted',
    );
    second.record({ runId: 1, kind: 'launch', status: 'running' });
    expect(new FleetTimeline({ file }).snapshot().events.map((e) => e.sequence)).toEqual([1, 2]);
  });
  it('projects only allowed metadata when reading existing files', () => {
    const file = journal();
    const timeline = new FleetTimeline({ file });
    timeline.record({ runId: 1, kind: 'launch', status: 'running' });
    const row = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(
      file,
      JSON.stringify({ ...row, output: 'secret', cwd: '/secret', prompt: 'secret' }) + '\n',
    );
    const recovered = new FleetTimeline({ file });
    expect(JSON.stringify(recovered.snapshot())).not.toContain('secret');
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
  });
  it('bounds event count, bytes and age and advertises incomplete history', () => {
    let now = 1000;
    const count = new FleetTimeline({ maxEvents: 2, now: () => now, maxAgeMs: 1000 });
    for (let i = 0; i < 3; i++) count.record({ runId: i, kind: 'launch', status: 'running' });
    expect(count.snapshot().events.map((e) => e.sequence)).toEqual([2, 3]);
    expect(count.snapshot().truncated).toBe(true);
    now = 2001;
    expect(count.snapshot().events).toEqual([]);
    const bytes = new FleetTimeline({ maxBytes: 1024 });
    for (let i = 0; i < 30; i++) bytes.record({ runId: i, kind: 'launch', status: 'running' });
    expect(
      Buffer.byteLength(
        bytes
          .snapshot()
          .events.map((e) => JSON.stringify(e) + '\n')
          .join(''),
      ),
    ).toBeLessThanOrEqual(1024);
  });
  it('keeps completed siblings done while prior running/waiting history is unknown', () => {
    const old = new FleetTimeline();
    old.record({ runId: 1, conversationId: 1, kind: 'done', status: 'done' });
    old.record({ runId: 1, conversationId: 2, kind: 'waiting', status: 'waiting' });
    const events = old.snapshot().events;
    expect(timelineStateAt(events, 2, 'new-epoch').map((s) => s.displayStatus)).toEqual([
      'done',
      'interrupted',
    ]);
    expect(timelineStateAt(events, 1, old.epoch)).toHaveLength(1);
    expect(timelineStateAt(events, 2, old.epoch)[1].displayStatus).toBe('waiting');
  });
  it('fails persistence closed while retaining safe in-memory events', () => {
    const timeline = new FleetTimeline({ file: path.join(journal(), 'nonexistent', 'file') });
    timeline.record({ runId: 1, kind: 'launch', status: 'running' });
    expect(timeline.snapshot().persistent).toBe(false);
    expect(timeline.snapshot().warning).toContain('unavailable');
    expect(timeline.snapshot().events).toHaveLength(1);
  });
  it('loads and reads history without PTY creation, live characters or action APIs', async () => {
    const file = journal();
    const previous = new FleetTimeline({ file });
    previous.record({ runId: 42, conversationId: 43, kind: 'tool', status: 'running' });
    const pty = new PtySessionManager(() => ({ module: null, moduleId: null, reason: 'test' }));
    const spawn = vi.spyOn(pty, 'create');
    const store = new AgentStateStore();
    const fleet = new FleetService([], store, pty, undefined, { file });
    const app = Fastify();
    registerFleetRoutes(app, fleet, 'token', new Set(['localhost']));
    const noAuth = await app.inject({ url: '/api/fleet/timeline' });
    expect(noAuth.statusCode).toBe(401);
    const response = await app.inject({
      url: '/api/fleet/timeline',
      headers: { authorization: 'Bearer token', host: 'localhost' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(fleet.snapshot().runs).toEqual([]);
    expect(fleet.snapshot().conversations).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    fleet.dispose();
    await app.close();
  });
});
