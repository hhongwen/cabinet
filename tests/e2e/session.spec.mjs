// Agent 会话（假 Adapter）：发送、拿到结果、停止在跑的一轮。
import { test, expect } from '@playwright/test';
import { addTask, newProject, title } from './helpers.mjs';

async function setupSession(request) {
  const project = await newProject(request, title('p-session'), [{ path: process.cwd(), primary: true }]);
  const task = await addTask(request, project, { title: title('会话卡') });
  const res = await request.post(`/api/tasks/${task.id}/sessions`, {
    data: { role: 'dev', agent: 'opencode', working_directory: process.cwd() }
  });
  expect(res.ok()).toBeTruthy();
  const session = (await res.json()).session;
  return { task, session };
}

async function sessions(request, taskId) {
  const res = await request.get(`/api/tasks/${taskId}/sessions`);
  return (await res.json()).sessions;
}

test('Agent 会话可以发送并返回结果', async ({ page, request }) => {
  const { task, session } = await setupSession(request);
  await page.goto('/');
  await page.locator(`.card[data-id="${task.id}"]`).click();
  await page.click('[data-dr-tab="agents"]');

  await page.fill('#drInput', 'hello');
  await page.press('#drInput', 'Control+Enter');
  await expect(page.locator('#drAgents')).toContainText('假回复：', { timeout: 15000 });

  const list = await sessions(request, task.id);
  expect(list[0].last_turn.status).toBe('completed');
  expect(list[0].last_turn.result_text).toContain('hello');
});

test('运行中的 Agent 可以停止', async ({ page, request }) => {
  const { task, session } = await setupSession(request);
  await page.goto('/');
  await page.locator(`.card[data-id="${task.id}"]`).click();
  await page.click('[data-dr-tab="agents"]');

  await page.fill('#drInput', 'slow task');
  await page.press('#drInput', 'Control+Enter');
  const stop = page.locator('[data-agent-stop]');
  await expect(stop).toBeVisible({ timeout: 10000 });
  await stop.click();

  await expect.poll(async () => {
    const list = await sessions(request, task.id);
    return list[0].last_turn.status;
  }, { timeout: 15000 }).toBe('interrupted');
});
