// D2.0 前端回归基线（第一批）：把最常用的 6 条界面路径固化下来。
// 全部跑在隔离数据目录上，自动分类关闭；不依赖真实模型或 Agent。
import { test, expect } from '@playwright/test';

const RUN = Date.now().toString(36).slice(-5);
const title = (s) => `E2E-${RUN}-${s}`;

async function newProject(request, name) {
  await request.post('/api/projects', { data: { name } });
  return name;
}

async function addTask(request, project, over = {}) {
  const res = await request.post('/api/tasks', { data: { classify: false, project, ...over } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function allTasks(request) {
  const res = await request.get('/api/tasks?include_archived=1');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).tasks;
}

test('看板加载与底栏新增任务', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#board')).toBeVisible();
  const t = title('新增');
  await page.fill('#text', t);
  await page.press('#text', 'Enter');
  // 关闭自动分类后新任务没有项目，按流水线进「默认」未分配筐，不进看板三列。
  await page.locator('#navProjects .nav-link', { hasText: '默认' }).click();
  await expect(page.locator('.card', { hasText: t })).toBeVisible();
});

test('抽屉打开与页签切换', async ({ page, request }) => {
  const project = await newProject(request, title('p-drawer'));
  const task = await addTask(request, project, { title: title('抽屉') });
  await page.goto('/');
  await page.locator(`.card[data-id="${task.id}"]`).click();
  await expect(page.locator('#drawer')).toHaveClass(/on/);
  await page.click('[data-dr-tab="agents"]');
  await expect(page.locator('#drTabBody')).toHaveAttribute('data-tab', 'agents');
  await page.click('[data-dr-tab="req"]');
  await expect(page.locator('#drTabBody')).toHaveAttribute('data-tab', 'req');
});

test('表格视图与行内编辑负责人', async ({ page, request }) => {
  const project = await newProject(request, title('p-table'));
  const task = await addTask(request, project, { title: title('表格') });
  await page.goto('/');
  await page.click('[data-view="table"]');
  const row = page.locator(`tr[data-id="${task.id}"]`);
  await expect(row).toBeVisible();
  await row.locator('td[data-edit="owner"]').click();
  await row.locator('td[data-edit="owner"] input').fill('张工');
  await page.keyboard.press('Enter');
  await expect(row.locator('td[data-edit="owner"]')).toHaveText('张工');
  const list = await allTasks(request);
  expect(list.find((x) => x.id === task.id).owner).toBe('张工');
});

test('看板拖拽把卡片换到进行中', async ({ page, request }) => {
  const project = await newProject(request, title('p-drag'));
  const task = await addTask(request, project, { title: title('拖拽') });
  await page.goto('/');
  await expect(page.locator(`.card[data-id="${task.id}"]`)).toBeVisible();
  await page.evaluate((id) => {
    const src = document.querySelector(`.card[data-id="${id}"]`);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const col = document.querySelector('.col[data-col="doing"]');
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, task.id);
  await page.waitForTimeout(400);
  const list = await allTasks(request);
  expect(list.find((x) => x.id === task.id).status).toBe('doing');
});

test('待澄清视图能看到没写清的需求', async ({ page, request }) => {
  const project = await newProject(request, title('p-draft'));
  const task = await addTask(request, project, {
    title: title('待澄清'),
    dev_ready: false,
    dev_gaps: ['缺少模块', '缺少验收标准']
  });
  await page.goto('/');
  await page.click('[data-view="clarify"]');
  await expect(page.locator(`.card[data-id="${task.id}"]`)).toBeVisible();
  await page.locator(`.card[data-id="${task.id}"]`).click();
  await expect(page.locator('#drawer')).toContainText('缺少模块');
});

test('归档视图取回任务', async ({ page, request }) => {
  const project = await newProject(request, title('p-arch'));
  const task = await addTask(request, project, { title: title('归档'), status: 'done' });
  const patched = await request.patch(`/api/tasks/${task.id}`, {
    data: { archived_at: '2026-01-01T00:00:00.000Z' }
  });
  expect(patched.ok()).toBeTruthy();

  await page.goto('/');
  await page.click('#cntArch');
  await expect(page.locator(`.card[data-id="${task.id}"]`)).toBeVisible();
  await page.locator(`[data-unarchive="${task.id}"]`).click();
  await page.waitForTimeout(400);
  const list = await allTasks(request);
  expect(list.find((x) => x.id === task.id).archived_at).toBeNull();
});
