// 样式几何门禁：用**实测的计算样式**守住「一套底，只写差量」。
//
// 为什么静态审计不够：`style-audit.mjs` 只能看 CSS 文本。一个控件"在不在
// 总则池里"是选择器匹配问题，静态文本看不出它最终拿到了什么形状。
// 「挂一个 Agent 会话」的「挂上」就是这样漏的 —— CSS 里明明给了橙色，
// 实际渲染是圆角 0px、边框 2px、padding 1px 6px，因为它的父上下文
// `.rel-dlg button` 不在池里，形状全落回浏览器默认。
//
// 这里只断言"同一个弹窗里的控件必须长得一致"，不锁具体像素值，
// 调设计时改一处就够。
import { test, expect } from '@playwright/test';

const RUN = Date.now().toString(36).slice(-5);
const title = (s) => `E2E-${RUN}-${s}`;

async function seed(request) {
  const project = title('p-style');
  await request.post('/api/projects', { data: { name: project } });
  const res = await request.post('/api/tasks', {
    data: { classify: false, project, title: title('样式'), priority: 'p1' }
  });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// 量出弹窗里所有"该有形状"的控件，按类别分组
async function measure(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('.rel-dlg');
    if (!dlg) return null;
    const info = (el) => {
      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        radius: c.borderTopLeftRadius,
        paddingTop: parseFloat(c.paddingTop),
        paddingLeft: parseFloat(c.paddingLeft),
        borderWidth: parseFloat(c.borderTopWidth),
        fontPx: parseFloat(c.fontSize),
        height: Math.round(r.height),
      };
    };
    return {
      panel: dlg.getBoundingClientRect().toJSON(),
      fields: [
        ...dlg.querySelectorAll('.sel--field > .sel-btn'),
        ...dlg.querySelectorAll('.agent-form > label > input'),
      ].map(info),
      footer: [...dlg.querySelectorAll('.rel-act button')].map((b) => ({
        text: b.textContent.trim(),
        ...info(b),
        disabled: b.disabled,
      })),
      ok: dlg.querySelector('[data-ok]')?.getBoundingClientRect().toJSON() || null,
    };
  });
}

test('Agent 会话弹窗：字段与按钮同一套形状', async ({ page, request }) => {
  const task = await seed(request);
  await page.goto('/');
  await page.locator(`.card[data-id="${task.id}"]`).click();
  await expect(page.locator('.drawer')).toHaveClass(/on/);

  // 抽屉默认停在「需求整理」，AGENT 会话区在另一个页签里
  await page.locator('.doc-tab', { hasText: '挂载 AGENTS' }).click();
  await page.locator('[data-agent-new]').click();
  await expect(page.locator('.rel-dlg')).toBeVisible();

  const m = await measure(page);
  expect(m, '弹窗没打开').not.toBeNull();

  // 1) 字段：下拉和输入框必须是同一档高度、同一种圆角
  //    36px 是「表单字段」那一档（.sel--field 也是 36px）
  expect(m.fields.length).toBeGreaterThanOrEqual(3);
  for (const f of m.fields) {
    expect(f.height, `字段高度不一致：${JSON.stringify(m.fields)}`).toBe(36);
    expect(f.radius, `字段圆角不一致：${JSON.stringify(m.fields)}`).toBe('9px');
  }

  // 2) 按钮：同一个页脚里两颗按钮必须同样圆角、同样内边距、同样边框宽度
  //    浏览器默认是 0px 圆角 + 2px 边框 + 1px 内边距 —— 只要落回默认，这里必红
  expect(m.footer.length).toBe(2);
  const [cancel, ok] = m.footer;
  for (const b of m.footer) {
    expect(b.radius, `「${b.text}」圆角落回了浏览器默认（不在按钮总则池里？）`).toBe('9px');
    expect(b.borderWidth, `「${b.text}」边框宽度不一致`).toBe(1);
    expect(b.paddingTop, `「${b.text}」内边距落回默认（1px）`).toBeGreaterThanOrEqual(6);
    expect(b.fontPx, `「${b.text}」字号不一致`).toBe(12);
  }
  expect(cancel.radius).toBe(ok.radius);
  expect(cancel.height).toBe(ok.height);

  // 3) 提交按钮必须在面板里、点得到 ——
  //    .links-pick 的 max-height:360px 曾把「挂上」压到面板下方（实测 514 > 508）
  expect(m.ok).not.toBeNull();
  expect(m.ok.bottom, '提交按钮跑出面板了').toBeLessThanOrEqual(m.panel.bottom + 1);
  const hit = await page.evaluate(() => {
    const b = document.querySelector('.rel-dlg [data-ok]');
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el === b || b.contains(el);
  });
  expect(hit, '提交按钮被别的东西盖住了').toBe(true);
});

test('关系弹窗：勾选行不许露出原生 checkbox / radio', async ({ page, request }) => {
  const project = title('p-pick');
  await request.post('/api/projects', { data: { name: project } });
  for (const n of ['甲', '乙', '丙']) {
    const r = await request.post('/api/tasks', {
      data: { classify: false, project, title: title(n) }
    });
    expect(r.ok()).toBeTruthy();
  }

  await page.goto('/');
  await page.locator('.card').first().click();
  await expect(page.locator('.drawer')).toHaveClass(/on/);
  await page.locator('.sect-h', { hasText: '关系' }).first().click();
  await page.locator('[data-merge]').first().click();
  await expect(page.locator('.rel-dlg')).toBeVisible();

  const m = await page.evaluate(() => {
    const dlg = document.querySelector('.rel-dlg');
    const inputs = [...dlg.querySelectorAll('.rel-pick input')];
    const boxes = [...dlg.querySelectorAll('.rel-pick .box')];
    const c = (el) => getComputedStyle(el);
    return {
      count: inputs.length,
      // 原生控件必须"还在、但看不见"：它是状态源和焦点目标
      native: inputs.map((i) => {
        const s = c(i);
        return {
          type: i.type,
          opacity: parseFloat(s.opacity),
          width: parseFloat(s.width),
          height: parseFloat(s.height),
        };
      }),
      boxes: boxes.map((b) => {
        const s = c(b);
        return { width: s.width, height: s.height, radius: s.borderTopLeftRadius };
      }),
    };
  });

  expect(m.count).toBeGreaterThan(0);
  expect(m.boxes.length, '缺自绘方块——用的是原生 checkbox 的外观').toBe(m.count);
  for (const n of m.native) {
    expect(n.opacity, '原生控件可见——浏览器会画自己的方块和勾').toBe(0);
    expect(Math.max(n.width, n.height), '原生控件还占着位').toBeLessThanOrEqual(1);
  }
  for (const b of m.boxes) {
    expect(b.width).toBe('16px');
    // 单选是圆的，复选是 --radius-xs(5px)；两者都必须是画出来的
    expect(['5px', '50%'], `方块圆角异常：${b.radius}`).toContain(b.radius);
  }

  // 勾选之后，方块要换成深橙实底（用 --orange-cta，不是 --orange）
  await page.locator('.rel-pick').first().click();
  const on = await page.evaluate(() => {
    const box = document.querySelector('.rel-pick input:checked + .box');
    if (!box) return null;
    const s = getComputedStyle(box);
    return { bg: s.backgroundImage, border: s.borderTopColor };
  });
  expect(on, '点了没勾上').not.toBeNull();
  expect(on.bg).toContain('linear-gradient');
});
