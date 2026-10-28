#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-fleet-demo-'));
const config = path.join(dir, 'profiles.json');
fs.writeFileSync(
  config,
  JSON.stringify([
    {
      id: 'multiplex',
      name: '演示·一个 Agent 三个对话',
      provider: 'custom',
      mode: 'task',
      cwd: root,
      command: process.execPath,
      args: [path.join(__dirname, 'fleet-conversations-demo.cjs'), '{prompt}'],
    },
    ...['编码员', '测试员', '审查员'].map((name, i) => ({
      id: `demo-${i}`,
      name: `演示·${name}`,
      provider: 'custom',
      mode: 'task',
      cwd: root,
      command: process.execPath,
      args: [path.join(__dirname, 'fleet-demo.cjs'), '{prompt}'],
    })),
  ]),
);
console.log(
  '离线演示模式：不会调用模型或修改项目文件。选择第一个环境，只启动一次即可看到三个对话小人；也可以同时启动其他 Agent。',
);
const child = spawn(
  process.execPath,
  [path.join(root, 'dist/cli.js'), '--fleet', config, ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: root },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = code || 0;
});
