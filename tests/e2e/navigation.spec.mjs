// 侧栏项目筛选：同一份数据只换过滤，不换页面。
import { test, expect } from '@playwright/test';
import { addTask, newProject, title } from './helpers.mjs';

test('点侧栏项目只显示该项目任务', async ({ page, request }) => {
  const p1 = await newProject(request, title('p-nav-A'));
  const p2 = await newProject(request, title('p-nav-B'));
  const a = await addTask(request, p1, { title: title('属于A') });
  const b = await addTask(request, p2, { title: title('属于B') });

  await page.goto('/');
  await expect(page.locator(`.card[data-id="${a.id}"]`)).toBeVisible();
  await expect(page.locator(`.card[data-id="${b.id}"]`)).toBeVisible();

  await page.locator('#navProjects .nav-link', { hasText: p2 }).click();
  await expect(page.locator(`.card[data-id="${b.id}"]`)).toBeVisible();
  await expect(page.locator(`.card[data-id="${a.id}"]`)).toHaveCount(0);

  await page.locator('#navMenu [data-filter="all"]').click();
  await expect(page.locator(`.card[data-id="${a.id}"]`)).toBeVisible();
});
