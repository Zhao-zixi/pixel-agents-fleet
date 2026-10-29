import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const bundle = path.resolve(process.argv[2] ?? '');
assert.equal(process.platform, 'win32', 'Verify the Windows package on Windows');
assert.ok(process.argv[2], 'Provide the unpacked bundle path');
const node = path.join(bundle, 'runtime', 'node.exe');
const cli = path.join(bundle, 'app', 'dist', 'cli.js');
for (const file of [
  node,
  cli,
  path.join(bundle, 'NODE-LICENSE.txt'),
  path.join(bundle, 'start-fleet.cmd'),
  path.join(bundle, 'docs', 'licenses', 'NotoSansSC-OFL.txt'),
]) {
  assert.ok(fs.statSync(file).size > 0, `Missing ${file}`);
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-smoke-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
let child;
try {
  const help = execFileSync(node, [cli, '--help'], { env, encoding: 'utf8', timeout: 10000 });
  assert.ok(help.includes('--fleet'));
  const launcherHelp = execFileSync(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', '""' + path.join(bundle, 'start-fleet.cmd') + '" --help"'],
    { env, encoding: 'utf8', timeout: 10000, windowsVerbatimArguments: true },
  );
  assert.ok(launcherHelp.includes('--fleet'), 'Launcher did not forward arguments');
  // The native PTY must load AND spawn using the bundled runtime on Windows.
  execFileSync(
    node,
    [
      '-e',
      `
    const pty = require('@lydell/node-pty');
    const proc = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo FLEET_PTY_OK'], {cols:80, rows:24, cwd:process.cwd(), env:process.env});
    let output = '';
    const timer = setTimeout(() => { proc.kill(); process.exit(2); }, 10000);
    proc.onData(data => { output += data; });
    proc.onExit(() => { clearTimeout(timer); setTimeout(() => process.exit(output.includes('FLEET_PTY_OK') ? 0 : 3), 100); });
  `,
    ],
    { cwd: path.join(bundle, 'app'), env, timeout: 15000, stdio: 'pipe' },
  );
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  child = spawn(node, [cli, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: home,
    env,
    stdio: 'ignore',
  });
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`CLI exited: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* Wait for startup. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(healthy, 'Packaged server did not become healthy');
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.ok(page.ok && (await page.text()).includes('<html'), 'Packaged web UI missing');
  console.log('Windows portable smoke passed: bundled Node, native PTY, CLI, HTTP and web UI.');
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null)
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  fs.rmSync(home, { recursive: true, force: true });
}
