import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { FleetTimelineEvent, FleetTimelineSnapshot } from '../../../core/src/fleetTimeline.js';

export interface FleetTimelineOptions {
  file?: string;
  maxEvents?: number;
  maxBytes?: number;
  maxAgeMs?: number;
  now?: () => number;
}
const kinds = new Set([
  'launch',
  'conversation',
  'session',
  'turnStart',
  'text',
  'error',
  'done',
  'waiting',
  'tool',
  'toolEnd',
  'exit',
  'stopped',
  'unknown',
]);
const statuses = new Set(['running', 'waiting', 'done', 'failed', 'stopped', 'unknown']);
const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value!))) : fallback;

/** Bounded append journal; corrupt/torn records never execute code or restore live processes. */
export class FleetTimeline {
  readonly epoch = randomUUID();
  private events: FleetTimelineEvent[] = [];
  private sequence = 0;
  private truncated = false;
  private warning: string | null = null;
  private writable = true;
  private readonly file?: string;
  private readonly now: () => number;
  private readonly limits: FleetTimelineSnapshot['limits'];

  constructor(options: FleetTimelineOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.limits = {
      maxEvents: bounded(options.maxEvents, 2000, 1, 10000),
      maxBytes: bounded(options.maxBytes, 2 * 1024 * 1024, 1024, 8 * 1024 * 1024),
      maxAgeMs: bounded(options.maxAgeMs, 7 * 86400000, 1000, 90 * 86400000),
    };
    if (!this.file) return;
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) {
        throw new Error('Unsafe or oversized history file');
      }
      const lines = readFileSync(this.file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line) as FleetTimelineEvent;
          if (!this.valid(value) || value.sequence <= this.sequence)
            throw new Error('Invalid record');
          // Explicit projection also discards unexpected fields from manually edited files.
          this.events.push(this.project(value));
          this.sequence = value.sequence;
        } catch {
          this.truncated = true;
          this.warning = 'History contains invalid or incomplete records; valid records recovered.';
        }
      }
      if (this.events[0]?.sequence > 1) this.truncated = true;
      this.trim();
      this.compact(); // Remove torn tail before any future append.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.fail();
    }
  }

  static fromEnvironment(): FleetTimelineOptions {
    return {
      file: process.env.PIXEL_AGENTS_FLEET_HISTORY_FILE || undefined,
      maxEvents: Number(process.env.PIXEL_AGENTS_FLEET_HISTORY_MAX_EVENTS ?? 2000),
      maxBytes: Number(process.env.PIXEL_AGENTS_FLEET_HISTORY_MAX_BYTES ?? 2097152),
      maxAgeMs: Number(process.env.PIXEL_AGENTS_FLEET_HISTORY_MAX_DAYS ?? 7) * 86400000,
    };
  }

  record(
    input: Omit<FleetTimelineEvent, 'epoch' | 'timestamp' | 'sequence' | 'toolRef'>,
    toolId?: string,
  ): void {
    const event: FleetTimelineEvent = {
      runId: input.runId,
      kind: input.kind,
      status: input.status,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      sequence: ++this.sequence,
      epoch: this.epoch,
      timestamp: this.now(),
      ...(toolId
        ? {
            toolRef: createHash('sha256')
              .update(`${this.epoch}:${input.runId}:${input.conversationId}:${toolId}`)
              .digest('hex')
              .slice(0, 16),
          }
        : {}),
    };
    this.events.push(event);
    const removed = this.trim();
    if (!this.file || !this.writable) return;
    try {
      if (removed) this.compact();
      else appendFileSync(this.file, JSON.stringify(event) + '\n', { mode: 0o600 });
    } catch {
      this.fail();
    }
  }

  snapshot(): FleetTimelineSnapshot {
    if (this.trim() && this.file && this.writable) {
      try {
        this.compact();
      } catch {
        this.fail();
      }
    }
    return {
      epoch: this.epoch,
      events: this.events.map((event) => ({ ...event })),
      persistent: !!this.file && this.writable,
      truncated: this.truncated,
      warning: this.warning,
      limits: { ...this.limits },
    };
  }

  private project(v: FleetTimelineEvent): FleetTimelineEvent {
    return {
      sequence: v.sequence,
      epoch: v.epoch,
      timestamp: v.timestamp,
      runId: v.runId,
      kind: v.kind,
      status: v.status,
      ...(v.conversationId === undefined ? {} : { conversationId: v.conversationId }),
      ...(v.toolRef ? { toolRef: v.toolRef } : {}),
    };
  }
  private valid(v: FleetTimelineEvent): boolean {
    return (
      !!v &&
      Number.isSafeInteger(v.sequence) &&
      v.sequence > 0 &&
      typeof v.epoch === 'string' &&
      /^[a-f0-9-]{36}$/.test(v.epoch) &&
      Number.isFinite(v.timestamp) &&
      v.timestamp >= 0 &&
      Number.isSafeInteger(v.runId) &&
      v.runId >= 0 &&
      (v.conversationId === undefined ||
        (Number.isSafeInteger(v.conversationId) && v.conversationId >= 0)) &&
      kinds.has(v.kind) &&
      statuses.has(v.status) &&
      (v.toolRef === undefined || /^[a-f0-9]{16}$/.test(v.toolRef))
    );
  }
  private trim(): boolean {
    const before = this.events.length;
    const oldest = this.now() - this.limits.maxAgeMs;
    this.events = this.events
      .filter((event) => event.timestamp >= oldest)
      .slice(-this.limits.maxEvents);
    let bytes = Buffer.byteLength(
      this.events.map((event) => JSON.stringify(event) + '\n').join(''),
    );
    while (bytes > this.limits.maxBytes && this.events.length)
      bytes -= Buffer.byteLength(JSON.stringify(this.events.shift()) + '\n');
    if (this.events.length !== before) this.truncated = true;
    return this.events.length !== before;
  }
  private compact(): void {
    const temporary = `${this.file}.${this.epoch}.tmp`;
    writeFileSync(temporary, this.events.map((event) => JSON.stringify(event) + '\n').join(''), {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, this.file!);
  }
  private fail(): void {
    this.writable = false;
    this.warning = 'History persistence unavailable; new events are in memory only.';
  }
}
