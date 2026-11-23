// brief.mjs —— 把随手记的一句话，整理成能直接干活的需求
//
// 为什么需要这一步：
//   「诺华报表导出太慢」是一句抱怨，不是一个能派的活。
//   派给 agent 之前，得先有目标、范围、验收标准、动哪个目录。
//
// 输出结构是固定的，因为后面的「派活」要按字段拼 prompt。

import fs from 'node:fs';
import path from 'node:path';
import { createBackend } from './backend.mjs';

const SYSTEM = `你是一个需求分析师。用户用一句话记下了一个任务，
你要把它整理成一份能直接交给工程师（或 AI agent）执行的需求说明。

按这个结构写，用 markdown，不要客套话：

## 目标
一句话说清要达成什么，可验证。

## 背景
从原文能看出的上下文。看不出来就写「原文没提」，不要编。

## 要做的事
2-5 条具体的动作，每条是一个可执行的步骤。

## 验收标准
2-4 条，每条都要能客观判断「做到了没有」。
不要写「体验良好」这种没法验证的。

## 风险 / 待确认
最多 3 条。如果信息够了就写「无明显风险」。
如果原文有歧义，把歧义点写在这里，不要自己拍板。

要求：
- 只用原文和给定信息，不要编造需求
- 原文没说的关键信息（比如具体指标、截止时间），在「待确认」里提问，不要假设
- 不要写"综上所述"之类的废话
- 中文，简洁`;

function readTextPreview(p, max = 1200) {
  try {
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) return null;
    const ext = path.extname(p).toLowerCase();
    const ok = ['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml',
      '.js', '.mjs', '.ts', '.py', '.java', '.sql', '.html', '.css', '.xml'];
    if (!ok.includes(ext)) return null;
    return fs.readFileSync(p, 'utf8').slice(0, max);
  } catch { return null; }
}

export function createBriefWriter(opts = {}) {
  const backend = opts.backend || createBackend(opts);
  const imagesDir = opts.imagesDir || '';
  const filesDir = opts.filesDir || '';
  const imageBase = opts.imageBase || 'http://127.0.0.1:46001';

  function resolve(nameOrPath, dir) {
    const s = String(nameOrPath || '');
    if (!s) return null;
    if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return s;
    if (dir) {
      const g = path.join(dir, path.basename(s));
      if (fs.existsSync(g)) return g;
    }
    return fs.existsSync(s) ? path.resolve(s) : null;
  }

  async function write({ task, project }) {
    const lines = [];

    lines.push('原始记录：\n' + String(task.payload?.text || task.title || '').slice(0, 3000));

    if (task.payload?.urls?.length) {
      lines.push('相关链接：\n' + task.payload.urls.join('\n'));
    }

    if (task.payload?.files?.length) {
      const desc = task.payload.files.map((f) => {
        const p = resolve(f, filesDir);
        const name = path.basename(String(f));
        let size = 0;
        try { size = fs.statSync(p).size; } catch { /* 忽略 */ }
        const preview = p ? readTextPreview(p) : null;
        const head = '- ' + name + '（' + Math.round(size / 1024) + 'KB）';
        return preview ? head + '\n  内容：' + preview.replace(/\s+/g, ' ').slice(0, 600) : head;
      }).join('\n');
      lines.push('附件：\n' + desc);
    }

    // 项目上下文：目录就是「动哪儿」的答案
    if (project) {
      const parts = ['项目：' + project.name];
      if (project.dirs?.length) {
        parts.push('涉及的目录：\n' + project.dirs.map((d) => {
          return '- ' + d.path + (d.note ? '（' + d.note + '）' : '') + (d.primary ? ' [主要]' : '');
        }).join('\n'));
      }
      lines.push(parts.join('\n'));
    }

    // 已有的对话也带上，里面可能有补充信息
    if (task.messages?.length) {
      const recent = task.messages.slice(-6)
        .map((m) => (m.role === 'user' ? '用户：' : '你：') + String(m.text || '').slice(0, 200))
        .join('\n');
      lines.push('之前的讨论：\n' + recent);
    }

    lines.push('请按格式输出需求说明。');

    const text = lines.join('\n\n');

    // 图片单独传，让模型能看图
    const images = [];
    for (const img of (task.payload?.images || []).slice(0, 3)) {
      const p = resolve(img, imagesDir);
      if (p) images.push(p);
    }

    const r = await backend.chat({ system: SYSTEM, text, images });

    return {
      brief: String(r.text || '').trim().slice(0, 6000),
      backend: r.model || ''
    };
  }

  return { write };
}
