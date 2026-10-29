import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FleetProfile } from '../../core/src/fleet.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { FleetService } from '../src/fleet/service.js';
import {
  captureWorkspace,
  compareWorkspace,
  parseWorkspaceStatus,
  sensitiveWorkspacePath,
  type WorkspaceCommand,
} from '../src/fleet/workspace.js';
import type { IPty } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';

const roots: string[] = [];
function repo() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'fleet-diff-'));
  roots.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('init');
  writeFileSync(path.join(cwd, 'a.txt'), 'base\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'base',
  );
  const profile: FleetProfile = {
    id: 'test',
    name: 'Test',
    cwd,
    provider: 'custom',
    mode: 'interactive',
  };
  return { cwd, git, profile };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('read-only Fleet workspace observations', () => {
  it('distinguishes pre-existing dirt, staged/unstaged changes, and newly observed paths', () => {
    const { cwd, git, profile } = repo();
    writeFileSync(path.join(cwd, 'a.txt'), 'dirty before\n');
    const baseline = captureWorkspace(profile);
    expect(baseline.status).toBe('ready');
    let current = compareWorkspace(baseline, captureWorkspace(profile));
    expect(current.files[0].change).toBe('pre-existing');
    git('add', 'a.txt');
    writeFileSync(path.join(cwd, 'a.txt'), 'after task\n');
    writeFileSync(path.join(cwd, 'new.txt'), 'new content\n');
    const statusBefore = git('status', '--porcelain');
    current = compareWorkspace(baseline, captureWorkspace(profile));
    expect(current.files.find((f) => f.path === 'a.txt')).toMatchObject({
      index: 'M',
      worktree: 'M',
      change: 'changed-since-start',
    });
    expect(current.files.find((f) => f.path === 'a.txt')?.patch).toContain('[staged]');
    expect(current.files.find((f) => f.path === 'new.txt')).toMatchObject({
      change: 'new-since-start',
      kind: 'text',
    });
    expect(current.files.find((f) => f.path === 'new.txt')?.patch).toContain('new content');
    expect(git('status', '--porcelain')).toBe(statusBefore);
  });
  it('hides sensitive files, symlink targets, binary content, and huge files', () => {
    const { cwd, profile } = repo();
    writeFileSync(path.join(cwd, '.env'), 'SECRET_VALUE');
    writeFileSync(path.join(cwd, 'private.pem'), 'SECRET_KEY');
    writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(cwd, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1));
    symlinkSync('/etc/passwd', path.join(cwd, 'outside'));
    const current = captureWorkspace(profile);
    expect(current.files.find((f) => f.path === '.env')?.kind).toBe('hidden');
    expect(current.files.find((f) => f.path === 'private.pem')?.kind).toBe('hidden');
    expect(current.files.find((f) => f.path === 'outside')?.kind).toBe('symlink');
    expect(current.files.find((f) => f.path === 'binary.bin')?.kind).toBe('binary');
    expect(current.files.find((f) => f.path === 'huge.txt')?.kind).toBe('unavailable');
    expect(JSON.stringify(current)).not.toContain('SECRET_VALUE');
    expect(JSON.stringify(current)).not.toContain('root:');
  });
  it('keeps renamed sensitive source contents hidden', () => {
    const { cwd, git, profile } = repo();
    writeFileSync(path.join(cwd, '.env'), 'RENAMED_SECRET_VALUE\n');
    git('add', '.env');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'fixture',
    );
    git('mv', '.env', 'ordinary.txt');
    const current = captureWorkspace(profile);
    expect(current.files.find((f) => f.path === 'ordinary.txt')).toMatchObject({
      kind: 'hidden',
      renamedFrom: '.env',
      patch: '',
    });
    expect(JSON.stringify(current)).not.toContain('RENAMED_SECRET_VALUE');
  });
  it('never claims unchanged content for hidden, binary or unreadable files', () => {
    const { cwd, profile } = repo();
    writeFileSync(path.join(cwd, '.env'), 'SECRET_BEFORE');
    writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(cwd, 'huge.txt'), 'a'.repeat(1024 * 1024 + 1));
    const baseline = captureWorkspace(profile);
    writeFileSync(path.join(cwd, '.env'), 'SECRET_AFTER');
    writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 9, 8]));
    writeFileSync(path.join(cwd, 'huge.txt'), 'b'.repeat(1024 * 1024 + 1));
    const current = compareWorkspace(baseline, captureWorkspace(profile));
    for (const name of ['.env', 'binary.bin', 'huge.txt']) {
      expect(current.files.find((file) => file.path === name)?.change).toBe('content-unobserved');
    }
    expect(JSON.stringify(current)).not.toContain('SECRET_');
    // A status-only fingerprint is not evidence, even when unchanged in both snapshots.
    const symlink = {
      path: 'link',
      index: '?',
      worktree: '?',
      kind: 'symlink' as const,
      patch: '',
      fingerprint: '??:symlink',
      truncated: false,
    };
    expect(
      compareWorkspace({ ...baseline, files: [symlink] }, { ...baseline, files: [symlink] })
        .files[0].change,
    ).toBe('content-unobserved');
  });
  it('does not run repository clean filters or external diff commands', () => {
    const { cwd, git, profile } = repo();
    writeFileSync(path.join(cwd, '.gitattributes'), '*.txt filter=evil diff=evil\n');
    git('config', 'filter.evil.clean', 'touch SHOULD_NOT_EXIST');
    git('config', 'filter.evil.process', 'touch SHOULD_NOT_EXIST');
    git('config', 'diff.evil.command', 'touch SHOULD_NOT_EXIST');
    writeFileSync(path.join(cwd, 'a.txt'), 'changed\n');
    const current = captureWorkspace(profile);
    expect(current.status).toBe('ready');
    expect(() => readFileSync(path.join(cwd, 'SHOULD_NOT_EXIST'))).toThrow();
  });
  it('marks cleanly resolved changes and does not infer new changes from a partial baseline', () => {
    const { cwd, profile } = repo();
    writeFileSync(path.join(cwd, 'a.txt'), 'dirty\n');
    const baseline = captureWorkspace(profile);
    writeFileSync(path.join(cwd, 'a.txt'), 'base\n');
    expect(compareWorkspace(baseline, captureWorkspace(profile)).files[0].change).toBe('resolved');
    writeFileSync(path.join(cwd, 'b.txt'), 'new\n');
    const partial = { ...baseline, files: [], truncated: true };
    expect(compareWorkspace(partial, captureWorkspace(profile)).files[0].change).toBeUndefined();
  });
  it('bounds file count and marks non-Git directories unavailable', () => {
    const { cwd, profile } = repo();
    for (let i = 0; i < 45; i++) writeFileSync(path.join(cwd, `file-${i}.txt`), 'data');
    expect(captureWorkspace(profile)).toMatchObject({ truncated: true });
    expect(captureWorkspace(profile).files.length).toBeLessThanOrEqual(40);
    const plain = mkdtempSync(path.join(os.tmpdir(), 'fleet-plain-'));
    roots.push(plain);
    expect(captureWorkspace({ ...profile, cwd: plain }).status).toBe('unavailable');
  });
  it('uses strictly checked SSH and quotes remote paths, with bounded remote file collection', () => {
    const calls: { command: string; args: string[]; timeout: number }[] = [];
    const runner: WorkspaceCommand = (command, args, timeout) => {
      calls.push({ command, args, timeout });
      const remote = args.at(-1)!;
      if (remote.startsWith('sh -c ')) return 'safe';
      if (remote.includes("'rev-parse'")) return '/remote/repo\n';
      if (remote.includes("'status'")) return '?? new.txt\0 M tracked.txt\0';
      if (remote.includes("'ls-files'"))
        return remote.includes("'tracked.txt'") ? '100644 hash 0\ttracked.txt\n' : '';
      if (remote.includes("'diff'")) return 'diff --git a/tracked.txt b/tracked.txt\n+new\n';
      return '';
    };
    const result = captureWorkspace(
      {
        id: 'r',
        name: 'r',
        cwd: "/remote/it's here",
        ssh: 'host',
        port: 2222,
        provider: 'custom',
        mode: 'interactive',
      },
      runner,
    );
    expect(result.status).toBe('ready');
    expect(result.files.find((f) => f.path === 'new.txt')?.kind).toBe('text');
    expect(result.files.find((f) => f.path === 'tracked.txt')?.patch).toContain('+new');
    expect(
      calls.every(
        (c) =>
          c.command === 'ssh' &&
          c.args.includes('StrictHostKeyChecking=yes') &&
          c.args.includes('BatchMode=yes') &&
          c.timeout <= 4000,
      ),
    ).toBe(true);
    expect(calls[0].args.at(-1)).toContain("'\\''");
  });
  it('fails closed for unsafe remote paths without reading their diff', () => {
    const commands: string[] = [];
    const runner: WorkspaceCommand = (_command, args) => {
      const remote = args.at(-1)!;
      commands.push(remote);
      if (remote.includes("'rev-parse'")) return '/remote/repo\n';
      if (remote.includes("'status'")) return '?? outside.txt\0';
      if (remote.startsWith('sh -c ')) throw new Error('outside root');
      return '';
    };
    const result = captureWorkspace(
      { id: 'r', name: 'r', cwd: '/repo', ssh: 'host', provider: 'custom', mode: 'interactive' },
      runner,
    );
    expect(result.files[0].kind).toBe('unavailable');
    expect(commands.some((command) => command.includes("'diff'"))).toBe(false);
  });
  it('captures baseline before spawn, groups shared roots, and keeps ended-run review', () => {
    const { cwd, profile } = repo();
    const exits: ((event: { exitCode: number }) => void)[] = [];
    let index = 0;
    const pty = new PtySessionManager(() => ({
      moduleId: 'fake',
      reason: null,
      module: {
        spawn: () => {
          index++;
          writeFileSync(path.join(cwd, 'a.txt'), `task ${index}\n`);
          return {
            pid: index,
            onData: () => {},
            onExit: (fn: (event: { exitCode: number }) => void) => {
              exits.push(fn);
            },
            write: () => {},
            resize: () => {},
            kill: () => {},
          } as IPty;
        },
      },
    }));
    const fleet = new FleetService([profile], new AgentStateStore(), pty);
    try {
      const first = fleet.launch(profile.id, '');
      const second = fleet.launch(profile.id, '');
      const report = fleet.workspace(first)!;
      expect(report.baseline.files).toHaveLength(0);
      expect(report.current.files[0].change).toBe('new-since-start');
      expect(report.relatedRunIds).toEqual([first, second]);
      expect(report.overlapRisk).toBe(true);
      expect(report.attribution).toBe('unknown');
      exits[0]({ exitCode: 0 });
      exits[1]({ exitCode: 0 });
      expect(fleet.workspace(first)?.current.files).toHaveLength(1);
      expect(fleet.workspace(first)?.overlapRisk).toBe(false);
      fleet.dismiss(first);
      expect(fleet.workspace(first)).toBeUndefined();
    } finally {
      fleet.dispose();
    }
  });
  it('rejects traversal/control-character paths and handles rename records', () => {
    expect(
      parseWorkspaceStatus('R  new name\0old name\0?? ../escape\0?? line\nname\0?? safe\0').map(
        (f) => f.path,
      ),
    ).toEqual(['new name', 'safe']);
    expect(sensitiveWorkspacePath('config/.env.local')).toBe(true);
  });
});
