import * as fs from 'node:fs';
import * as path from 'node:path';

import { FLEET_PROVIDERS, type FleetProfile } from '../../../core/src/fleet.js';

export const FLEET_MAX_PROMPT = 16_000;
export const FLEET_MAX_RUNNING = 24;
export const FLEET_MAX_HISTORY = 100;
export const FLEET_MAX_OUTPUT = 64_000;
export const FLEET_MAX_LINE = 1_048_576;
export const FLEET_ACTIVITY_TIMEOUT = 3000;
export const FLEET_ARCHIVE_DELAY = 15_000;
export const FLEET_MAX_CONVERSATIONS = 256;
export const FLEET_MAX_CONVERSATIONS_PER_RUN = 64;
export const FLEET_MAX_SESSION_ID = 200;

function safeString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`Invalid fleet profile ${field}`);
  }
  return value;
}

export function parseProfiles(value: unknown): FleetProfile[] {
  if (!Array.isArray(value) || value.length > FLEET_MAX_HISTORY) {
    throw new Error('Fleet config must be an array of at most 100 profiles');
  }
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid fleet profile');
    const p = raw as Record<string, unknown>;
    const id = safeString(p.id, 'id');
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id))
      throw new Error(`Invalid/duplicate profile id: ${id}`);
    ids.add(id);
    if (!FLEET_PROVIDERS.includes(p.provider as FleetProfile['provider']))
      throw new Error(`Unknown provider: ${String(p.provider)}`);
    if (p.mode !== undefined && p.mode !== 'task' && p.mode !== 'interactive')
      throw new Error('Invalid fleet mode');
    const profile: FleetProfile = {
      id,
      name: safeString(p.name, 'name'),
      provider: p.provider as FleetProfile['provider'],
      cwd: safeString(p.cwd, 'cwd'),
      mode: p.mode === 'interactive' ? 'interactive' : 'task',
    };
    if (p.ssh !== undefined) {
      const host = safeString(p.ssh, 'ssh');
      // No options, shell metacharacters, whitespace, or multiple @ separators.
      if (!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_\[][a-zA-Z0-9_.:\[\]-]*$/.test(host))
        throw new Error('Invalid SSH destination');
      profile.ssh = host;
      if (!profile.cwd.startsWith('/')) throw new Error('SSH cwd must be an absolute POSIX path');
    } else if (!path.isAbsolute(profile.cwd)) throw new Error('Local cwd must be absolute');
    if (p.port !== undefined) {
      if (
        !profile.ssh ||
        typeof p.port !== 'number' ||
        !Number.isInteger(p.port) ||
        p.port < 1 ||
        p.port > 65535
      )
        throw new Error('Invalid SSH port');
      profile.port = p.port;
    }
    if (p.command !== undefined) {
      profile.command = safeString(p.command, 'command');
      if (profile.command.startsWith('-')) throw new Error('Executable cannot start with -');
    }
    if (p.args !== undefined) {
      if (
        !Array.isArray(p.args) ||
        !p.args.every((a) => typeof a === 'string' && !a.includes('\0'))
      )
        throw new Error('args must be a string array');
      profile.args = p.args as string[];
    }
    if (profile.provider === 'custom' && !profile.command)
      throw new Error('Custom profiles need command');
    return profile;
  });
}

export function loadProfiles(file?: string): FleetProfile[] {
  if (file) return parseProfiles(JSON.parse(fs.readFileSync(file, 'utf8')));
  return FLEET_PROVIDERS.filter((p) => p !== 'custom').map((provider) => ({
    id: provider,
    name: provider,
    provider,
    mode: 'task',
    cwd: process.cwd(),
  }));
}

/** POSIX shell quoting, used ONLY on the remote side of OpenSSH. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function buildFleetCommand(profile: FleetProfile, prompt: string) {
  if (prompt.length > FLEET_MAX_PROMPT || prompt.includes('\0'))
    throw new Error('Task is too long or contains NUL');
  if (profile.mode === 'task' && !prompt.trim()) throw new Error('A task prompt is required');
  const extra = profile.args ?? [];
  let args: string[] = extra;
  if (profile.mode === 'task') {
    switch (profile.provider) {
      case 'claude':
        args = ['--output-format', 'stream-json', '--verbose', ...extra, '-p', '--', prompt];
        break;
      case 'codex':
        args = ['exec', '--json', ...extra, '--', prompt];
        break;
      case 'gemini':
        args = ['--output-format', 'stream-json', ...extra, `--prompt=${prompt}`];
        break;
      case 'opencode':
        args = ['run', '--format', 'json', ...extra, '--', prompt];
        break;
      case 'custom':
        args = extra.map((a) => (a === '{prompt}' ? prompt : a));
        break;
    }
  }
  const command = profile.command ?? profile.provider;
  if (!profile.ssh) return { command, args, cwd: profile.cwd };
  const remote = `cd ${shellQuote(profile.cwd)} && exec ${[command, ...args].map(shellQuote).join(' ')}`;
  return {
    command: 'ssh',
    args: [
      '-tt',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      ...(profile.port ? ['-p', String(profile.port)] : []),
      '--',
      profile.ssh,
      `sh -lc ${shellQuote(remote)}`,
    ],
    cwd: process.cwd(),
  };
}
