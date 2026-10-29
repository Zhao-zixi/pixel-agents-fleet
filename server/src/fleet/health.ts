import { execFile } from 'node:child_process';

import type { FleetDiagnostic, FleetProfile, FleetTransport } from '../../../core/src/fleet.js';
import { shellQuote } from './profiles.js';

export function initialTransport(remote: boolean): FleetTransport {
  return {
    kind: remote ? 'ssh' : 'local',
    state: remote ? 'connecting' : 'open',
    remoteState: 'unknown',
  };
}

/** Output confirms activity on the channel, not remote task health or liveness. */
export function transportOutput(transport: FleetTransport, now: number): void {
  if (transport.state === 'closed') return;
  transport.lastOutputAt = now;
  transport.state = 'output-observed';
}

export function transportExit(transport: FleetTransport, code: number, stopped: boolean): void {
  transport.state = 'closed';
  transport.remoteState =
    transport.kind === 'ssh' && (code === 255 || stopped) ? 'unknown' : 'exited';
  transport.reason = stopped
    ? 'local-stop'
    : code === 255 && transport.kind === 'ssh'
      ? 'ssh-exit-255'
      : 'process-exit';
}

export function diagnosticCommand(profile: FleetProfile): { command: string; args: string[] } {
  if (!profile.ssh) throw new Error('Diagnostics require an SSH profile');
  const executable = profile.command ?? profile.provider;
  // Fixed script only: profile args and task prompt NEVER enter diagnostics.
  const script = `printf 'FLEET_CONNECTED\\n'; cd ${shellQuote(profile.cwd)} 2>/dev/null || exit 21; printf 'FLEET_CWD\\n'; command -v ${shellQuote(executable)} >/dev/null 2>&1 || exit 22; printf 'FLEET_EXECUTABLE\\n'`;
  return {
    command: 'ssh',
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=1',
      ...(profile.port ? ['-p', String(profile.port)] : []),
      '--',
      profile.ssh,
      `sh -c ${shellQuote(script)}`,
    ],
  };
}

export interface DiagnosticResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
export type DiagnosticRunner = (command: string, args: string[]) => Promise<DiagnosticResult>;
const runDiagnostic: DiagnosticRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 12_000, maxBuffer: 8192, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          stdout,
          stderr,
          timedOut: !!err?.killed,
        });
      },
    );
  });

export async function diagnoseProfile(
  profile: FleetProfile,
  runner: DiagnosticRunner = runDiagnostic,
): Promise<FleetDiagnostic> {
  const command = diagnosticCommand(profile);
  const result = await runner(command.command, command.args);
  const lines = new Set(result.stdout.split(/\r?\n/));
  const connected = lines.has('FLEET_CONNECTED');
  const cwd = lines.has('FLEET_CWD');
  const executable = lines.has('FLEET_EXECUTABLE');
  // Return classifications, never arbitrary SSH stderr, banners, environment, or credentials.
  const reason = result.timedOut
    ? 'timeout'
    : connected
      ? !cwd
        ? 'cwd-unavailable'
        : !executable
          ? 'executable-unavailable'
          : result.code === 0
            ? 'ok'
            : 'unknown'
      : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(result.stderr)
        ? 'host-key-unverified'
        : /Permission denied|Authentication failed/i.test(result.stderr)
          ? 'authentication-failed'
          : 'connection-unconfirmed';
  return {
    profileId: profile.id,
    checkedAt: Date.now(),
    connection: connected ? 'confirmed' : 'unknown',
    cwd: connected ? (cwd ? 'available' : 'unavailable') : 'unknown',
    executable: cwd ? (executable ? 'available' : 'unavailable') : 'unknown',
    reason,
  };
}
