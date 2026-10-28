import { type ChildProcess, execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';

interface ProcessLifecycle {
  closed: boolean;
  error?: Error;
  close: Promise<void>;
}

const lifecycles = new WeakMap<ChildProcess, ProcessLifecycle>();

/** Register immediately after spawn so cleanup can observe even an early close. */
export function trackOwnedProcess<T extends ChildProcess>(child: T): T {
  if (lifecycles.has(child)) return child;
  let resolveClose!: () => void;
  const lifecycle: ProcessLifecycle = {
    closed: false,
    close: new Promise<void>((resolve) => {
      resolveClose = resolve;
    }),
  };
  lifecycles.set(child, lifecycle);
  child.once('error', (error) => {
    lifecycle.error = error;
  });
  child.once('close', () => {
    lifecycle.closed = true;
    resolveClose();
  });
  return child;
}

async function waitForClose(lifecycle: ProcessLifecycle, timeoutMs: number): Promise<boolean> {
  if (lifecycle.closed) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lifecycle.close.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Only target the PID of this still-running child; never use an image name or process group. */
async function terminateWindowsTree(child: ChildProcess, force: boolean): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    execFile(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { timeout: 2_000, windowsHide: true },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

/** Stop only a fixture-owned child and await close (exit alone can leave stdio handles open). */
export async function stopProcess(child: ChildProcess): Promise<void> {
  trackOwnedProcess(child);
  const lifecycle = lifecycles.get(child)!;
  if (lifecycle.closed) {
    if (!child.pid && lifecycle.error) throw lifecycle.error;
    return;
  }
  let terminationError: unknown;
  const terminate = async (force: boolean) => {
    // Do not send signals to an already exited PID, which the OS could have reused.
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
      if (process.platform === 'win32') await terminateWindowsTree(child, force);
      else child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      terminationError = error;
    }
  };
  await terminate(false);
  if (!(await waitForClose(lifecycle, 2_000))) {
    await terminate(true);
    if (!(await waitForClose(lifecycle, 1_000))) {
      throw new Error(
        `Fixture process ${child.pid ?? '(spawn failed)'} did not close after termination`,
        {
          cause: terminationError ?? lifecycle.error,
        },
      );
    }
  }
  if (!child.pid && lifecycle.error) throw lifecycle.error;
}

/** Caller must pass only a directory created and owned by this fixture, never a supplied directory. */
export async function removeOwnedDirectory(directory: string): Promise<void> {
  const retryDelays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '') || attempt === retryDelays.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}
