// chat.mjs —— 卡片抽屉里的对话
//
// 这不是聊天机器人，是「任务操作台」：你说的话要能改动任务本身。
// 所以模型必须返回结构化的补丁，而不是只回一段文字。
//
// 输出：{ reply, patch }
//   reply  给用户看的话
//   patch  要改的字段（可为空）

import fs from 'node:fs';
import path from 'node:path';

import { createBackend } from './backend.mjs';

const SYSTEM = `你在帮用户维护一条任务。用户会在下面这条任务的对话里说话，
你要做两件事：

1. 回一句话（简短，说人话，不要客套）
2. 如果用户的话意味着要改任务，给出要改的字段

可改字段：
- title     任务标题（动词开头，20 字内）
- priority  p0 阻塞 / p1 紧急 / p2 常规 / p3 低 / p4 待定
- category  工作、学习、生活、开发、运维、沟通、研究、杂事
- project   项目名（必须是给定清单里的名字，或用户明确要求新建）
- status    todo / doing / done
- note      短备注

判断规则：
- 用户说「改成 P1」「这个不急」→ 改 priority
- 用户说「这不是诺华的，是欧加隆的」→ 改 project
- 用户说「做完了」→ status 改 done
- 用户只是在问问题、讨论方案 → patch 为空，只回话
- 用户说的信息适合补充进去 → 写进 note
- 不要为了改而改。用户没提的就别动

如果用户给了新信息能推断出更准确的标题，可以顺手改 title。
如果用户在讨论具体做法、问技术问题，就正常讨论，不要硬塞 patch。

输出 JSON：
{"reply": "一句话回复", "patch": {"priority": "p1"} }

patch 没有要改的就给 {}。不要输出任何别的文字、不要 markdown 代码块。`;

function jsonBlock(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// 文件能不能给模型看，取决于通道：图片走 images，其余只能转成文字描述。
// 这段跟 classify.mjs 里的 describeFiles 是同一套思路（那里要判类型和优先级，
// 这里要判任务字段），但两边都不该出现第二份「文本预览」的实现。
const TEXTUAL_EXT = ['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml',
  '.js', '.mjs', '.ts', '.py', '.java', '.sql', '.html', '.css', '.xml'];

function humanSize(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

function readTextPreview(file, maxChars = 1200) {
  try {
    const ext = path.extname(file).toLowerCase();
    if (!TEXTUAL_EXT.includes(ext)) return null;
    if (fs.statSync(file).size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8').slice(0, maxChars);
  } catch { return null; }
}

function describeFiles(files = [], resolve) {
  return files.map((f) => {
    const raw = f?.path || f;
    const local = resolve ? (resolve(raw) || raw) : raw;
    const name = path.basename(String(raw));
    let size = 0;
    try { size = fs.statSync(local).size; } catch { /* 文件不在了，只留名字 */ }
    const line = '- ' + name + '（' + (path.extname(name).toLowerCase() || '无扩展名') + '，' + humanSize(size) + '）';
    const preview = readTextPreview(local);
    return preview ? line + '\n  内容片段：' + preview.replace(/\s+/g, ' ').slice(0, 800) : line;
  }).join('\n');
}

const FIELD_LABEL = {
  title: '标题', priority: '优先级', category: '类别',
  project: '项目', status: '状态', note: '备注'
};

export function createChat(opts = {}) {
  const backend = opts.backend || createBackend(opts);
  const imagesDir = opts.imagesDir || '';
  const filesDir = opts.filesDir || '';

  // 附件里存的是「cwd 无关」的相对名字或绝对路径，两种都要能落到真实文件
  function resolveLocal(nameOrPath, dir) {
    const s = String(nameOrPath || '');
    if (!s) return null;
    if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return s;
    if (dir) {
      const guess = path.join(dir, path.basename(s));
      if (fs.existsSync(guess)) return guess;
    }
    return fs.existsSync(s) ? path.resolve(s) : null;
  }

  async function reply({ task, thread, userText, projects, images = [], files = [] }) {
    const lines = [];

    // 任务现状
    lines.push(
      '当前任务：\n'
      + '- 标题：' + task.title + '\n'
      + '- 状态：' + task.status + '\n'
      + '- 优先级：' + task.priority + '\n'
      + '- 项目：' + (task.project || '默认') + '\n'
      + '- 类别：' + (task.category || '未分类')
    );
    if (task.payload?.text && task.payload.text !== task.title) {
      lines.push('原文：\n' + String(task.payload.text).slice(0, 1500));
    }
    if (task.note) lines.push('备注：' + task.note);

    if (projects && projects.length) {
      lines.push('可选项目：' + projects.map((p) => p.name).join('、'));
    }

    // 最近几轮对话，让模型知道上下文
    const recent = (thread || []).slice(-10);
    if (recent.length) {
      lines.push('对话记录：\n' + recent.map((m) => {
        const who = m.role === 'user' ? '用户' : '你';
        return who + '：' + String(m.text || '').slice(0, 400);
      }).join('\n'));
    }

    // 纯文件/纯图片也要有「用户刚说」这一段，否则 prompt 结构会缺一条
    lines.push('用户刚说：' + (userText || '（没有文字，只有附件）'));

    if (files.length) {
      lines.push('用户这次附带的文件：\n' + describeFiles(files, (n) => resolveLocal(n, filesDir)));
    }

    const imgPaths = [];
    for (const img of images.filter(Boolean).slice(0, 3)) {
      const local = resolveLocal(img, imagesDir);
      if (local) imgPaths.push(local);
      else lines.push('（一张图找不到：' + path.basename(String(img)) + '）');
    }

    // 图片直接交给 backend：magpie / alma 都能看，CLI 通道会自己抛错。
    // 这里不 try —— 吞掉那条「通道不支持图片」的话术，用户就不知道该换通道了。
    const r = await backend.chat({ system: SYSTEM, text: lines.join('\n\n'), images: imgPaths });
    const parsed = jsonBlock(r.text);

    if (!parsed) {
      // 模型没给 JSON，把原文当回复，不改字段
      return { reply: String(r.text || '').trim().slice(0, 600), patch: {}, model: r.model };
    }

    const patch = {};
    const raw = parsed.patch && typeof parsed.patch === 'object' ? parsed.patch : {};
    for (const k of Object.keys(FIELD_LABEL)) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') {
        patch[k] = String(raw[k]).trim();
      }
    }

    return {
      reply: String(parsed.reply || '').trim().slice(0, 800) || '好',
      patch,
      model: r.model
    };
  }

  return { reply };
}

export { FIELD_LABEL };
