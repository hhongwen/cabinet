import { expect } from '@playwright/test';

export const RUN = Date.now().toString(36).slice(-5);
export const title = (s) => `E2E-${RUN}-${s}`;

export async function newProject(request, name, dirs = []) {
  await request.post('/api/projects', { data: { name, dirs } });
  return name;
}

export async function addTask(request, project, over = {}) {
  const res = await request.post('/api/tasks', { data: { classify: false, project, ...over } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

export async function allTasks(request) {
  const res = await request.get('/api/tasks?include_archived=1');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).tasks;
}

export async function getTask(request, id) {
  const res = await request.get(`/api/tasks/${id}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// 合成 HTML5 拖拽：卡片 dragstart 会把 id 写进 dataTransfer，列上的 drop 读它。
export async function dragCardTo(page, id, col) {
  await page.evaluate(([taskId, column]) => {
    const src = document.querySelector(`.card[data-id="${taskId}"]`);
    if (!src) throw new Error('卡片不存在: ' + taskId);
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const target = document.querySelector(`.col[data-col="${column}"]`);
    if (!target) throw new Error('列不存在: ' + column);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, [id, col]);
}
