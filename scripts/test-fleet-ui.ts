/** Browser + real local PTY smoke test; uses the explicitly labelled offline demo. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from '@playwright/test';

import { AgentStateStore } from '../server/src/agentStateStore.js';
import { buildAssetCache } from '../server/src/assetReload.js';
import { FleetService } from '../server/src/fleet/service.js';
import { createHttpServer } from '../server/src/httpServer.js';
import { PtySessionManager } from '../server/src/terminal/ptySessionManager.js';

async function main() {
  const root = process.cwd();
  const store = new AgentStateStore();
  const pty = new PtySessionManager();
  const fleet = new FleetService(
    ['一个 Agent 三个对话'].map((name, i) => ({
      id: `demo-${i}`,
      name: `演示·${name}`,
      provider: 'custom',
      mode: 'task',
      cwd: root,
      command: process.execPath,
      args: [path.join(root, 'scripts/fleet-conversations-demo.cjs'), '{prompt}'],
    })),
    store,
    pty,
  );
  const { app, port } = await createHttpServer({
    embedded: false,
    token: 'fleet-ui-test-token',
    store,
    ptyManager: pty,
    fleet,
    staticDir: path.join(root, 'dist/webview'),
    assetCache: await buildAssetCache(path.join(root, 'dist'), []),
  });
  const browser = await chromium.launch({
    executablePath: process.env.FLEET_TEST_CHROMIUM,
    args: process.env.FLEET_TEST_CHROMIUM ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on('pageerror', (e) => errors.push(e.message));
    const wire: Record<string, unknown>[] = [];
    const terminalIds: number[] = [];
    page.on('websocket', (socket) => {
      const match = new URL(socket.url()).pathname.match(/^\/terminal\/(\d+)$/);
      if (match) terminalIds.push(Number(match[1]));
      else
        socket.on('framereceived', ({ payload }) => {
          try {
            wire.push(JSON.parse(String(payload)));
          } catch {
            /* binary terminal frame */
          }
        });
    });
    await page.goto(`http://127.0.0.1:${port}/?token=fleet-ui-test-token`);
    const intro = page.getByRole('dialog', { name: 'Welcome to Pixel Agents!' });
    await intro.waitFor({ timeout: 5000 }).catch(() => {});
    if (await intro.isVisible())
      await intro.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: '多 Agent 小队', exact: true }).click();
    await page.locator('#fleet-prompt').fill('同一进程，三个对话');
    await page.getByRole('button', { name: '+ 启动 Agent', exact: true }).click();
    await page.locator('.fleet-conversation').nth(2).waitFor();
    assert.equal(fleet.snapshot().runs.length, 1);
    assert.equal(store.size, 3);
    const [first, second, third] = fleet.snapshot().conversations;
    const runId = first.runId;
    const row = (id: number) => page.locator(`[data-conversation-id="${id}"]`);
    assert([...store.values()].every((a) => a.activeToolIds.has('shared-tool-id')));
    await row(second.id).locator('.fleet-run-select').click();
    await page
      .locator('.fleet-detail pre')
      .getByText('离线模拟 · 运行测试', { exact: false })
      .waitFor();
    assert(!(await page.locator('.fleet-detail pre').innerText()).includes('离线模拟 · 修改接口'));
    // Each sibling opens the SAME process terminal, including after the primary is hidden.
    await row(second.id).getByRole('button', { name: '定位 / 终端', exact: true }).click();
    await page.getByTitle('Close terminal', { exact: true }).waitFor();
    assert(terminalIds.includes(runId));
    assert(terminalIds.every((id) => id === runId));
    await page.getByTitle('Close terminal', { exact: true }).click();
    await page.getByRole('button', { name: '多 Agent 小队', exact: true }).click();
    await row(first.id).getByRole('button', { name: '收起小人', exact: true }).click();
    await row(first.id).waitFor({ state: 'hidden' });
    assert(pty.has(runId));
    assert(wire.some((m) => m.type === 'agentClosed' && m.id === runId && m.keepTerminal === true));
    await page.reload();
    await intro.waitFor({ timeout: 5000 }).catch(() => {});
    if (await intro.isVisible())
      await intro.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: '多 Agent 小队', exact: true }).click();
    await row(third.id).waitFor();
    assert.equal(await page.locator('.fleet-run').count(), 1);
    assert.equal(await page.locator('.fleet-conversation').count(), 2);
    assert(
      wire.some(
        (m) => m.type === 'fleetConversationInfo' && m.id === second.id && m.runId === runId,
      ),
    );
    assert(wire.some((m) => m.type === 'terminalSessionOpened' && m.agentId === runId));
    await page.getByRole('button', { name: /历史 \/ 已收起/ }).click();
    await row(first.id).getByRole('button', { name: '显示小人', exact: true }).click();
    assert.equal(store.size, 3);
    if (await intro.isVisible())
      await intro.getByRole('button', { name: 'Close', exact: true }).click();
    const closeTerminal = page.getByTitle('Close terminal', { exact: true });
    if (await closeTerminal.isVisible()) await closeTerminal.click();
    // Collect desktop screenshot with labels and all three conversation cards.
    await page.screenshot({ path: '/tmp/pixel-fleet-desktop.png' });
    await row(third.id).getByText('等你回复', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停止整个 Agent（3 个对话）', exact: true }).click();
    await page.locator('.fleet-group-title').getByText('已停止', { exact: true }).waitFor();
    assert.equal(fleet.getConversation(third.id)?.status, 'stopped');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/pixel-fleet-mobile.png' });
    const panel = await page.locator('.fleet-panel').boundingBox();
    assert(panel && panel.x >= 0 && panel.x + panel.width <= 390);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(
      'PASS: 1 UI-launched process / 3 conversations, isolated outputs, shared terminal, hide/show, reload with hidden owner, waiting status, group stop, desktop/mobile panel, no browser errors',
    );
  } finally {
    await browser.close();
    await pty.disposeAll();
    fleet.dispose();
    await app.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
