// 附件：底栏贴图能出现在卡片上并真的能加载；普通文件进附件计数。
import { test, expect } from '@playwright/test';
import { title } from './helpers.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('贴图：缩略图出现在卡片上并可加载', async ({ page }) => {
  await page.goto('/');
  await page.fill('#text', title('图片附件'));
  await page.setInputFiles('#fileInput', { name: 'e2e.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('#thumbs img')).toBeVisible();
  await page.press('#text', 'Enter');

  // 关闭自动分类后新任务进「默认」未分配筐
  await page.locator('#navProjects .nav-link', { hasText: '默认' }).click();
  const card = page.locator('.card', { hasText: title('图片附件') });
  await expect(card).toBeVisible();
  await expect(card.locator('.shots img')).toHaveCount(1);
  await expect.poll(async () => card.locator('.shots img').evaluate((img) => img.naturalWidth),
    { timeout: 10000 }).toBeGreaterThan(0);
});

test('文件：卡片显示附件数量，抽屉能看到文件名', async ({ page }) => {
  await page.goto('/');
  await page.fill('#text', title('文件附件'));
  await page.setInputFiles('#fileInput', {
    name: 'e2e-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('e2e attachment\n', 'utf8')
  });
  await page.press('#text', 'Enter');

  await page.locator('#navProjects .nav-link', { hasText: '默认' }).click();
  const card = page.locator('.card', { hasText: title('文件附件') });
  await expect(card).toBeVisible();
  await expect(card.locator('.files')).toContainText('1 个附件');

  await card.click();
  await expect(page.locator('#drawer')).toContainText('e2e-note.txt');
});
