#!/usr/bin/env node
// Offline demo fixture. This is NOT an AI model and never edits project files.
const task = process.argv[2] || '演示任务';
const emit = (event) => console.log(JSON.stringify(event));
const steps = [
  [0, { type: 'text', text: `离线演示：${task}\n这些事件来自演示脚本，不会调用模型或修改文件。` }],
  [700, { type: 'tool_start', id: 'read-1', name: 'Read', input: { path: 'src/main.ts' } }],
  [3500, { type: 'tool_end', id: 'read-1' }],
  [4000, { type: 'tool_start', id: 'write-1', name: 'Edit', input: { path: 'src/main.ts' } }],
  [8000, { type: 'tool_end', id: 'write-1' }],
  [8500, { type: 'tool_start', id: 'test-1', name: 'Bash', input: { command: 'npm test (模拟)' } }],
  [11500, { type: 'tool_end', id: 'test-1' }],
  [12000, { type: 'text', text: '演示结束。换用真实 Agent 配置后，这些动作将由 CLI 事件驱动。' }],
  [12200, { type: 'done' }],
];
for (const [ms, event] of steps) setTimeout(() => emit(event), ms);
