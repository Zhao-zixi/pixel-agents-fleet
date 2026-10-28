import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

import type { FleetProfile } from '../../../core/src/fleet.js';
import type {
  FleetWorkspaceFile,
  FleetWorkspaceSnapshot,
} from '../../../core/src/fleetWorkspace.js';
import { shellQuote } from './profiles.js';

const MAX_OUTPUT = 256 * 1024;
const MAX_PATCH = 8 * 1024;
const MAX_FILES = 40;
const MAX_TIME = 8_000;
const GIT_FLAGS = [
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
];
export type WorkspaceCommand = (command: string, args: string[], timeout: number) => string;
const execute: WorkspaceCommand = (command, args, timeout) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout,
      maxBuffer: MAX_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const result = error as { status?: number; stdout?: unknown };
    const allowsDifference =
      args.includes('--no-index') ||
      args.includes('--get-regexp') ||
      (command === 'ssh' && /'--(?:no-index|get-regexp)'/.test(args.at(-1) ?? ''));
    if (allowsDifference && result.status === 1 && typeof result.stdout === 'string')
      return result.stdout;
    throw new Error('Read-only workspace command failed or exceeded its time/output limit');
  }
};
export function sensitiveWorkspacePath(file: string): boolean {
  return (
    /(^|\/)(\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?)(\/|$)/i.test(
      file,
    ) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(file)
  );
}
function safeRelative(file: string): boolean {
  return (
    !!file &&
    !file.startsWith('/') &&
    !file.split('/').includes('..') &&
    !/[\x00-\x1f\x7f]/.test(file)
  );
}
export function parseWorkspaceStatus(
  raw: string,
): { path: string; index: string; worktree: string }[] {
  const entries = raw.split('\0');
  const result: { path: string; index: string; worktree: string }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const index = entry[0],
      worktree = entry[1],
      file = entry.slice(3);
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') i++;
    if (safeRelative(file)) result.push({ path: file, index, worktree });
  }
  return result;
}
/** Bounded read-only Git observations. No external diff, textconv, fsmonitor, or file mutations. */
export function captureWorkspace(
  profile: FleetProfile,
  runCommand: WorkspaceCommand = execute,
): FleetWorkspaceSnapshot {
  const started = Date.now();
  const host = profile.ssh ?? 'local';
  const snapshot: FleetWorkspaceSnapshot = {
    status: 'unavailable',
    host,
    root: profile.cwd,
    key: `${host}:${profile.cwd}`,
    capturedAt: started,
    files: [],
    truncated: false,
  };
  const filterFlags: string[] = [];
  const remote = (command: string): string => {
    const remaining = MAX_TIME - (Date.now() - started);
    if (remaining <= 0) throw new Error('Workspace scan time limit reached');
    return runCommand(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ConnectTimeout=3',
        ...(profile.port ? ['-p', String(profile.port)] : []),
        '--',
        profile.ssh!,
        command,
      ],
      Math.min(remaining, 4000),
    );
  };
  const invoke = (args: string[], root = profile.cwd) => {
    const remaining = MAX_TIME - (Date.now() - started);
    if (remaining <= 0) throw new Error('Workspace scan time limit reached');
    const command = ['git', ...GIT_FLAGS, ...filterFlags, '-C', root, ...args];
    if (!profile.ssh) return runCommand(command[0], command.slice(1), Math.min(remaining, 4000));
    return remote(command.map(shellQuote).join(' '));
  };
  const remoteFileSafe = (root: string, file: string): boolean => {
    const full = shellQuote(root.replace(/\/$/, '') + '/' + file);
    const prefix = shellQuote(root.replace(/\/$/, '') + '/');
    // Fail closed if the remote host lacks realpath or the path crosses a symlink outside the repo.
    const script = `[ -f ${full} ] && [ ! -L ${full} ] || exit 2; resolved=$(realpath -- ${full}) || exit 2; case "$resolved" in ${prefix}*) ;; *) exit 2;; esac; [ "$(wc -c < ${full})" -le 1048576 ] || exit 2; printf safe`;
    return remote(`sh -c ${shellQuote(script)}`) === 'safe';
  };
  try {
    let root = invoke(['rev-parse', '--show-toplevel']).trim();
    if (!root || /[\x00-\x1f]/.test(root)) throw new Error('Unsupported repository path');
    if (!profile.ssh) root = realpathSync(root);
    // Disable repository clean/process filter commands as well as external diff/textconv.
    const config = invoke(
      ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'],
      root,
    );
    for (const key of config.split('\n').filter(Boolean)) {
      if (/^filter\..*\.(clean|process|required)$/.test(key))
        filterFlags.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    }
    snapshot.root = root;
    snapshot.key = `${host}:${profile.port ?? 22}:${root}`;
    const entries = parseWorkspaceStatus(
      invoke(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root),
    );
    snapshot.truncated = entries.length > MAX_FILES;
    let used = 0;
    for (const entry of entries.slice(0, MAX_FILES)) {
      const file: FleetWorkspaceFile = {
        ...entry,
        kind: 'text',
        patch: '',
        fingerprint: '',
        truncated: false,
      };
      try {
        if (sensitiveWorkspacePath(entry.path)) file.kind = 'hidden';
        else {
          const stage = invoke(['ls-files', '--stage', '--', entry.path], root);
          if (/^120000 /.test(stage)) file.kind = 'symlink';
          else if (
            profile.ssh &&
            entry.worktree !== 'D' &&
            entry.index !== 'D' &&
            !remoteFileSafe(root, entry.path)
          )
            file.kind = 'unavailable';
          else {
            if (!profile.ssh && entry.worktree !== 'D' && entry.index !== 'D') {
              const full = path.join(root, entry.path);
              const stat = lstatSync(full);
              if (stat.isSymbolicLink()) file.kind = 'symlink';
              else if (
                !stat.isFile() ||
                stat.size > 1024 * 1024 ||
                !realpathSync(full).startsWith(root + path.sep)
              )
                file.kind = 'unavailable';
            }
            if (file.kind === 'text') {
              let patch: string;
              if (entry.index === '?')
                patch = invoke(
                  [
                    'diff',
                    '--no-index',
                    '--no-ext-diff',
                    '--no-textconv',
                    '--',
                    '/dev/null',
                    profile.ssh
                      ? root.replace(/\/$/, '') + '/' + entry.path
                      : path.join(root, entry.path),
                  ],
                  root,
                );
              else {
                const flags = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color'];
                patch =
                  '[staged]\n' +
                  invoke(['diff', '--cached', ...flags, '--', entry.path], root) +
                  '\n[unstaged]\n' +
                  invoke(['diff', ...flags, '--', entry.path], root);
              }
              file.fingerprint = createHash('sha256').update(patch).digest('hex');
              file.kind = /(?:Binary files .* differ|GIT binary patch)/.test(patch)
                ? 'binary'
                : 'text';
              file.truncated = patch.length > MAX_PATCH;
              file.patch = file.kind === 'text' ? patch.slice(0, MAX_PATCH) : '';
            }
          }
        }
      } catch {
        file.kind = 'unavailable';
        snapshot.truncated = true;
      }
      file.fingerprint ||= `${entry.index}${entry.worktree}:${file.kind}`;
      used += file.patch.length;
      if (used > MAX_OUTPUT || Date.now() - started >= MAX_TIME) {
        snapshot.truncated = true;
        break;
      }
      snapshot.files.push(file);
    }
    snapshot.status = 'ready';
  } catch {
    snapshot.reason = 'Not a Git workspace, unavailable, or read timed out. No files were changed.';
  }
  return snapshot;
}
export function compareWorkspace(
  baseline: FleetWorkspaceSnapshot,
  current: FleetWorkspaceSnapshot,
): FleetWorkspaceSnapshot {
  if (baseline.status !== 'ready' || current.status !== 'ready' || baseline.key !== current.key)
    return current;
  const before = new Map(baseline.files.map((file) => [file.path, file]));
  const files = current.files.map((file): FleetWorkspaceFile => {
    const old = before.get(file.path);
    before.delete(file.path);
    return {
      ...file,
      change: !old
        ? baseline.truncated
          ? undefined
          : 'new-since-start'
        : old.fingerprint === file.fingerprint
          ? 'pre-existing'
          : 'changed-since-start',
      ...(old?.kind === 'text' ? { baselinePatch: old.patch } : {}),
    };
  });
  if (!current.truncated)
    for (const old of before.values())
      files.push({ ...old, change: 'resolved', patch: '', baselinePatch: old.patch });
  return { ...current, files };
}
