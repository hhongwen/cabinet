// 卡片关系：合并 / 拆分 / 层级 / 依赖 —— 数据用 API 造，界面验证看见的和拦住的行为。
import { test, expect } from '@playwright/test';
import { addTask, allTasks, dragCardTo, getTask, newProject, title } from './helpers.mjs';

test('合并：产物带【合】，原卡变只读历史', async ({ page, request }) => {
  const project = await newProject(request, title('p-merge'));
  const a = await addTask(request, project, { title: title('合并A') });
  const b = await addTask(request, project, { title: title('合并B') });
  const res = await request.post('/api/tasks/merge', {
    data: { targetIds: [a.id, b.id], title: title('合并结果') }
  });
  expect(res.ok()).toBeTruthy();
  const merged = (await res.json()).task;

  await page.goto('/');
  const card = page.locator(`.card[data-id="${merged.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.tag.rel.merge')).toHaveCount(1);
  // 被合并的卡不在 list 里（merged_into IS NULL 才进看板），用 links 核对来源边
  const linksA = await (await request.get(`/api/tasks/${a.id}/links`)).json();
  expect(linksA.asTo.some(
    (l) => l.kind === 'merge_parent' && l.from_id === merged.id && l.to_id === a.id
  )).toBeTruthy();
});

test('拆分：原卡带【拆】，子卡进入看板', async ({ page, request }) => {
  const project = await newProject(request, title('p-split'));
  const source = await addTask(request, project, { title: title('待拆') });
  const res = await request.post(`/api/tasks/${source.id}/split`, {
    data: { parts: [{ title: title('子一') }, { title: title('子二') }] }
  });
  expect(res.ok()).toBeTruthy();

  await page.goto('/');
  const card = page.locator(`.card[data-id="${source.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.tag.rel.split')).toHaveCount(1);
  await expect(page.locator('.card', { hasText: title('子一') })).toBeVisible();
  await expect(page.locator('.card', { hasText: title('子二') })).toBeVisible();
});

test('层级：父卡显示子项进度', async ({ page, request }) => {
  const project = await newProject(request, title('p-parent'));
  const parent = await addTask(request, project, { title: title('父卡') });
  const child = await addTask(request, project, { title: title('子卡') });
  const res = await request.post(`/api/tasks/${child.id}/parent`, { data: { parentId: parent.id } });
  expect(res.ok()).toBeTruthy();

  await page.goto('/');
  const card = page.locator(`.card[data-id="${parent.id}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(/子项 0\/1|子项 1\/1/);
  const list = await allTasks(request);
  expect(list.find((x) => x.id === child.id).parent_id).toBe(parent.id);
});

test('依赖：没做完前置时拖不进进行中', async ({ page, request }) => {
  const project = await newProject(request, title('p-dep'));
  const first = await addTask(request, project, { title: title('前置') });
  const waiting = await addTask(request, project, { title: title('等前置') });
  const res = await request.post(`/api/tasks/${waiting.id}/depends`, { data: { onTaskId: first.id } });
  expect(res.ok()).toBeTruthy();

  await page.goto('/');
  const card = page.locator(`.card[data-id="${waiting.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.tag.rel.dep')).toHaveCount(1);

  await dragCardTo(page, waiting.id, 'doing');
  await page.waitForTimeout(400);
  const list = await allTasks(request);
  expect(list.find((x) => x.id === waiting.id).status).toBe('todo');
  await expect(page.locator('#toast')).toContainText(first.title);
});
