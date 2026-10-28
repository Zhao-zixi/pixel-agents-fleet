#!/usr/bin/env node
// Offline fixture: ONE process, THREE independent conversations. No model calls.
const send = (conversationId, title, event) =>
  console.log(JSON.stringify({ type: 'fleet.event', conversationId, title, event }));
const conversations = [
  ['api', '修改接口'],
  ['tests', '运行测试'],
  ['review', '审查代码'],
];
for (const [id, title] of conversations) {
  send(id, title, { type: 'conversation_start' });
  send(id, title, {
    type: 'text',
    text: `离线模拟 · ${title} · 任务：${process.argv[2] || '体验多对话'}`,
  });
  send(id, title, {
    type: 'tool_start',
    id: 'shared-tool-id',
    name: id === 'api' ? 'Edit' : 'Read',
    input: { path: id + '.ts' },
  });
}
setTimeout(() => {
  send('api', '修改接口', { type: 'tool_end', id: 'shared-tool-id' });
  send('api', '修改接口', { type: 'text', text: '接口修改完成。这段内容只属于接口对话。' });
  send('api', '修改接口', { type: 'done' });
}, 4000);
setTimeout(() => {
  send('review', '审查代码', { type: 'tool_end', id: 'shared-tool-id' });
  send('review', '审查代码', { type: 'waiting', message: '模拟提问：要继续审查兼容性吗？' });
}, 5000);
setTimeout(() => {
  send('tests', '运行测试', { type: 'tool_end', id: 'shared-tool-id' });
  send('tests', '运行测试', { type: 'text', text: '模拟测试通过。这段内容只属于测试对话。' });
  send('tests', '运行测试', { type: 'done' });
}, 9000);
// The completed api conversation leaves the office, then returns with the SAME id.
setTimeout(() => {
  send('api', '修改接口', { type: 'turn_start' });
  send('api', '修改接口', {
    type: 'tool_start',
    id: 'follow-up',
    name: 'Edit',
    input: { path: 'api.ts' },
  });
}, 23000);
setTimeout(() => {
  send('api', '修改接口', { type: 'tool_end', id: 'follow-up' });
  send('api', '修改接口', { type: 'done' });
  send('review', '审查代码', { type: 'text', text: '模拟回复已收到，审查完成。' });
  send('review', '审查代码', { type: 'done' });
}, 35000);
