/** Observed workspace changes do not establish conversation authorship. */
export interface FleetWorkspaceFile {
  path: string;
  renamedFrom?: string;
  index: string;
  worktree: string;
  kind: 'text' | 'binary' | 'hidden' | 'symlink' | 'unavailable';
  patch: string;
  fingerprint: string;
  truncated: boolean;
  change?: 'pre-existing' | 'changed-since-start' | 'new-since-start' | 'resolved';
  baselinePatch?: string;
}
export interface FleetWorkspaceSnapshot {
  status: 'ready' | 'unavailable';
  reason?: string;
  host: string;
  root: string;
  key: string;
  capturedAt: number;
  files: FleetWorkspaceFile[];
  truncated: boolean;
}
export interface FleetWorkspaceReport {
  baseline: FleetWorkspaceSnapshot;
  current: FleetWorkspaceSnapshot;
  relatedRunIds: number[];
  overlapRisk: boolean;
  attribution: 'unknown';
}
