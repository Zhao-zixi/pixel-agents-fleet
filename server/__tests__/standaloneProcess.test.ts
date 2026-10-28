import { type ChildProcess, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  removeOwnedDirectory,
  stopProcess,
  trackOwnedProcess,
} from '../../e2e/helpers/standaloneProcess.js';

vi.mock('node:fs/promises', () => ({ rm: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

class FakeChild extends EventEmitter {
  pid: number | undefined = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill = vi.fn((_signal: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}
const platform = process.platform;
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: platform });
});

describe('standalone fixture process lifecycle', () => {
  it('does not confuse killed=true with close and escalates an unresponsive owned child', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.useFakeTimers();
    const child = new FakeChild();
    child.killed = true;
    trackOwnedProcess(child.asChild());
    let resolved = false;
    const stopped = stopProcess(child.asChild()).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(resolved).toBe(false);
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    await Promise.resolve();
    expect(resolved).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await stopped;
    expect(resolved).toBe(true);
  });

  it('handles a previously tracked early close without signalling a reused PID', async () => {
    const child = new FakeChild();
    trackOwnedProcess(child.asChild());
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await stopProcess(child.asChild());
    expect(child.kill).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('waits for inherited stdio close after exit and does not signal the old PID', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    trackOwnedProcess(child.asChild());
    child.exitCode = 0;
    child.emit('exit', 0, null);
    const stopped = stopProcess(child.asChild());
    const rejected = expect(stopped).rejects.toThrow('did not close after termination');
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(child.kill).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports a spawn failure instead of silently claiming cleanup succeeded', async () => {
    const child = new FakeChild();
    child.pid = undefined;
    trackOwnedProcess(child.asChild());
    const failure = Object.assign(new Error('spawn missing executable'), { code: 'ENOENT' });
    child.emit('error', failure);
    child.emit('close', -2, null);
    await expect(stopProcess(child.asChild())).rejects.toBe(failure);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('escalates the same owned Windows tree when graceful taskkill fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    const child = new FakeChild();
    trackOwnedProcess(child.asChild());
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const flags = args[1] as string[];
      const callback = args[3] as (error: Error | null) => void;
      if (!flags.includes('/F')) callback(new Error('Process did not terminate'));
      else {
        child.exitCode = 1;
        child.emit('close', 1, null);
        callback(null);
      }
      return {} as ChildProcess;
    });
    const stopped = stopProcess(child.asChild());
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenLastCalledWith(
      'taskkill.exe',
      ['/PID', '12345', '/T', '/F'],
      { timeout: 2_000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('falls back to the owned process handle when Windows taskkill itself times out', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    const child = new FakeChild();
    trackOwnedProcess(child.asChild());
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null) => void;
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('taskkill timed out'), { killed: true, signal: 'SIGTERM' }),
        ),
      );
      return {} as ChildProcess;
    });
    child.kill.mockImplementation((signal) => {
      child.killed = true;
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      });
      return true;
    });
    const stopping = stopProcess(child.asChild());
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report success when Windows commands and handle termination never produce close', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.useFakeTimers();
    const child = new FakeChild();
    trackOwnedProcess(child.asChild());
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null) => void;
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('taskkill timed out'), { killed: true, signal: 'SIGTERM' }),
        ),
      );
      return {} as ChildProcess;
    });
    const outcome = stopProcess(child.asChild()).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('closeObserved=false');
    expect(String(error)).toContain('timedOutOrKilled=true');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not fall back to a handle after taskkill races with an observed exit', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = new FakeChild();
    trackOwnedProcess(child.asChild());
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null) => void;
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        callback(new Error('process no longer exists'));
      });
      return {} as ChildProcess;
    });
    await stopProcess(child.asChild());
    expect(child.kill).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('targets only the live owned PID tree on Windows and waits for close', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const child = new FakeChild();
    trackOwnedProcess(child.asChild());
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null) => void;
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        callback(null);
      });
      return {} as ChildProcess;
    });
    await stopProcess(child.asChild());
    expect(execFile).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '12345', '/T'],
      { timeout: 2_000, windowsHide: true },
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('standalone fixture owned directory cleanup', () => {
  it('retries transient Windows locks and eventually succeeds', async () => {
    vi.useFakeTimers();
    vi.mocked(rm)
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'ENOTEMPTY' }))
      .mockResolvedValue(undefined);
    const removing = removeOwnedDirectory('/owned-fixture');
    await vi.runAllTimersAsync();
    await removing;
    expect(rm).toHaveBeenCalledTimes(4);
    expect(rm).toHaveBeenLastCalledWith('/owned-fixture', {
      recursive: true,
      force: true,
      maxRetries: 0,
    });
  });

  it('throws the final lock failure after bounded retries', async () => {
    vi.useFakeTimers();
    const locked = Object.assign(new Error('still locked'), { code: 'EBUSY' });
    vi.mocked(rm).mockRejectedValue(locked);
    const removing = removeOwnedDirectory('/owned-fixture');
    const rejected = expect(removing).rejects.toBe(locked);
    await vi.runAllTimersAsync();
    await rejected;
    expect(rm).toHaveBeenCalledTimes(6);
  });

  it('does not retry unrelated permission or filesystem errors', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(rm).mockRejectedValue(denied);
    await expect(removeOwnedDirectory('/owned-fixture')).rejects.toBe(denied);
    expect(rm).toHaveBeenCalledTimes(1);
  });
});
