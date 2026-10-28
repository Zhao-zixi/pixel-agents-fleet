/** Standalone multi-provider launch profiles. Secrets belong to each host's CLI/SSH config. */
export const FLEET_PROVIDERS = ['claude', 'codex', 'gemini', 'opencode', 'custom'] as const;
export type FleetProvider = (typeof FLEET_PROVIDERS)[number];
export interface FleetProfile {
  id: string;
  name: string;
  provider: FleetProvider;
  mode: 'task' | 'interactive';
  cwd: string;
  /** OpenSSH destination or ~/.ssh/config alias. Missing means local. */
  ssh?: string;
  port?: number;
  /** Optional executable path, resolved on the target host. */
  command?: string;
  args?: string[];
}
export interface FleetRun {
  id: number;
  profileId: string;
  name: string;
  provider: FleetProvider;
  mode: 'task' | 'interactive';
  host: string;
  cwd: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  activity: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  sessionId?: string;
  output: string;
}

/** A character represents a conversation, which can share a process/terminal with others. */
export interface FleetConversation {
  id: number;
  runId: number;
  sessionId?: string;
  title: string;
  provider: FleetProvider;
  host: string;
  cwd: string;
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
  activity: string;
  visible: boolean;
  startedAt: number;
  updatedAt: number;
  output: string;
}

export interface FleetSnapshot {
  available: boolean;
  reason: string | null;
  profiles: FleetProfile[];
  runs: Omit<FleetRun, 'output'>[];
  conversations: Omit<FleetConversation, 'output'>[];
  maxRunning: number;
}
