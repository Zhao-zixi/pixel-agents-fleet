/** Real loopback OpenSSH + native PTY integration. Linux, sshd + ssh-keygen required. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { FleetProfile } from '../core/src/fleet.js';
import { AgentStateStore } from '../server/src/agentStateStore.js';
import { FleetService } from '../server/src/fleet/service.js';
import { resolvePtyModule } from '../server/src/terminal/ptyModule.js';
import { PtySessionManager } from '../server/src/terminal/ptySessionManager.js';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-fleet-ssh-'));
  const reservation = net.createServer();
  await new Promise<void>((r) => reservation.listen(0, '127.0.0.1', r));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  for (const key of ['host', 'client'])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, key)]);
  const hostPublic = fs
    .readFileSync(path.join(dir, 'host.pub'), 'utf8')
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');
  fs.writeFileSync(path.join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${hostPublic}\n`);
  fs.writeFileSync(
    path.join(dir, 'client_config'),
    `Host fleet-loopback\n HostName 127.0.0.1\n Port ${port}\n User ${os.userInfo().username}\n IdentityFile ${dir}/client\n IdentitiesOnly yes\n UserKnownHostsFile ${dir}/known_hosts\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'sshd_config'),
    `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${dir}/host\nPidFile ${dir}/pid\nAuthorizedKeysFile ${dir}/client.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin prohibit-password\nLogLevel ERROR\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'fake-agent.cjs'),
    `
const fs=require('fs');
const prompt=process.argv[2];
console.log(JSON.stringify({type:'tool_start',id:'shared-id',name:'Read',input:{path:'README.md'}}));
console.log(JSON.stringify({type:'text',text:prompt}));
if(prompt==='long') {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'remote-pid'))},String(process.pid));
  setInterval(()=>console.log(JSON.stringify({type:'text',text:'tick'})),100);
} else setTimeout(()=>{console.log(JSON.stringify({type:'tool_end',id:'shared-id'}));console.log(JSON.stringify({type:'done'}));},250);
`,
  );
  const userland = process.env.FLEET_TEST_SSH_SERVER;
  const sshd = userland
    ? spawn(
        process.execPath,
        [userland, dir, path.resolve('node_modules/@lydell/node-pty'), String(port)],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    : spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(dir, 'sshd_config')], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
  let sshErrors = '';
  sshd.stderr.on('data', (b) => {
    sshErrors += b.toString();
  });
  const resolution = resolvePtyModule();
  assert(resolution.module, resolution.reason ?? 'Native PTY required');
  const nativeModule = resolution.module;
  const manager = new PtySessionManager(() => ({
    ...resolution,
    module: {
      spawn(file, args, options) {
        return nativeModule.spawn(
          file,
          file === 'ssh' ? ['-F', path.join(dir, 'client_config'), ...args] : args,
          options,
        );
      },
    },
  }));
  const base: FleetProfile = {
    id: 'local',
    name: 'Local',
    provider: 'custom',
    mode: 'task',
    cwd: dir,
    command: process.execPath,
    args: [path.join(dir, 'fake-agent.cjs'), '{prompt}'],
  };
  const fleet = new FleetService(
    [
      base,
      { ...base, id: 'remote', ssh: 'fleet-loopback' },
      {
        ...base,
        id: 'multiplex',
        ssh: 'fleet-loopback',
        args: [path.resolve('scripts/fleet-conversations-demo.cjs'), '{prompt}'],
      },
    ],
    new AgentStateStore(),
    manager,
  );
  try {
    await until(() => fs.existsSync(path.join(dir, 'pid')) || sshd.exitCode !== null, 'sshd start');
    assert.equal(sshd.exitCode, null, sshErrors);
    const prompt = "literal 'quotes'\n$(touch BAD) `touch BAD` ; & 中文";
    const ids = ['local', 'remote', 'remote'].map((id) => fleet.launch(id, prompt));
    await until(
      () => ids.every((id) => fleet.get(id)?.status !== 'running'),
      'concurrent local/SSH runs',
    );
    for (const id of ids) {
      assert.equal(fleet.get(id)?.status, 'done', (fleet.get(id)?.output ?? '') + '\n' + sshErrors);
      assert(
        fleet.get(id)?.output.includes(prompt),
        (fleet.get(id)?.output ?? '') + '\n' + sshErrors,
      );
    }
    assert(!fs.existsSync(path.join(dir, 'BAD')), 'Shell interpolation occurred');
    const multi = fleet.launch('multiplex', 'SSH 多对话');
    await until(
      () => fleet.snapshot().conversations.filter((c) => c.runId === multi).length === 3,
      'one SSH process with 3 conversations',
    );
    const group = fleet.snapshot().conversations.filter((c) => c.runId === multi);
    assert.equal(group[0].id, multi);
    assert.equal(new Set(group.map((c) => c.sessionId)).size, 3);
    for (const c of group) assert(fleet.getConversation(c.id)?.output.includes(c.title));
    fleet.setConversationVisible(group[0].id, false);
    assert(manager.has(multi), 'Hiding primary character killed SSH');
    fleet.stop(multi);
    await until(() => fleet.get(multi)?.status === 'stopped', 'multiplex SSH cancellation');
    assert(group.every((c) => fleet.getConversation(c.id)?.status === 'stopped'));
    const id = fleet.launch('remote', 'long');
    await until(() => fs.existsSync(path.join(dir, 'remote-pid')), 'long SSH run');
    const remotePid = Number(fs.readFileSync(path.join(dir, 'remote-pid'), 'utf8'));
    fleet.stop(id);
    await until(() => fleet.get(id)?.status === 'stopped', 'SSH cancellation');
    await until(() => {
      try {
        return fs.readFileSync(`/proc/${remotePid}/stat`, 'utf8').split(' ')[2] === 'Z';
      } catch {
        return true;
      }
    }, 'remote foreground process terminated');
    console.log(
      'PASS: 3 concurrent local/SSH runs, literal Unicode/quotes/newlines, JSON events, one SSH process with 3 isolated conversations, non-destructive hiding, SSH cancellation and remote process cleanup',
    );
  } finally {
    await manager.disposeAll();
    fleet.dispose();
    sshd.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
