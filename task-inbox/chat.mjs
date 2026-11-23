// chat.mjs —— 卡片抽屉里的对话
//
// 这不是聊天机器人，是「任务操作台」：你说的话要能改动任务本身。
// 所以模型必须返回结构化的补丁，而不是只回一段文字。
//
// 输出：{ reply, patch }
//   reply  给用户看的话
//   patch  要改的字段（可为空）

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

const FIELD_LABEL = {
  title: '标题', priority: '优先级', category: '类别',
  project: '项目', status: '状态', note: '备注'
};

export function createChat(opts = {}) {
  const backend = opts.backend || createBackend(opts);

  async function reply({ task, thread, userText, projects }) {
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

    lines.push('用户刚说：' + userText);

    const r = await backend.chat({ system: SYSTEM, text: lines.join('\n\n') });
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
