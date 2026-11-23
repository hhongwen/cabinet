// classify.mjs —— 判断一条记录的类型和优先级
//
// 模型怎么接是 backend.mjs 的事，这里只管：
//   1. 把任务整理成一段话（+ 图片路径）
//   2. 拼 prompt
//   3. 解析模型返回的 JSON
//
// 三条通道（magpie / alma / cli）自动探测，这里不用关心。

import fs from 'node:fs';
import path from 'node:path';
import { createBackend } from './backend.mjs';

const PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'p4'];
const KINDS = ['text', 'image', 'image_text', 'link', 'file', 'mixed'];

const PRIORITY_RUBRIC = `P0 灾难级/阻塞级：核心业务中断、线上重大故障、严重安全漏洞、大面积用户受影响。必须立刻停下其他事处理。
P1 高（紧急且重要）：核心功能受限但有替代、即将到期的关键需求、高层重点关注的紧急项目。当天或 24 小时内解决。
P2 中（常规）：常规功能迭代、一般体验优化、非核心流程的普通 bug。按正常排期推进。
P3 低（不紧急）：锦上添花的小优化、技术债清理、长期探索。放 backlog，有空再做。
P4 极低/待定观察：纯文案微调、极低频边缘 UI 瑕疵、可能永远不做的。`;

const SYSTEM = `你是一个任务收件箱的分拣员。用户会把随手记下的一段内容丢给你，
你要判断它是什么类型、多重要，并给一个能一眼看懂的标题。

类型只能是：
- text        纯文字（想法、待办、笔记）
- image       只有图，没有说明文字
- image_text  图 + 文字说明
- link        主要是链接
- file        带附件文件（文档、表格、压缩包等）
- mixed       多种混合

优先级按这个标准判：
${PRIORITY_RUBRIC}

判断优先级时看「这件事对用户的实际后果」，不要看语气。
用户说"紧急"但事情本身是周报格式调整，那还是 P2/P3。
用户轻描淡写地说"数据库连接偶尔断"，那可能是 P0/P1。

标题要求：动词开头，20 字内，说清"要做什么"，不要照抄原文。
如果内容本身已经是清晰的任务，直接用；如果是零散想法，提炼成动作。
如果用户没写任何文字、只有图片或附件，你要从图/文件内容里看出这是什么，
然后给出一个描述性的标题（例如"处理订单超时的报错截图"），不要就叫"截图"。

类别从这些里选（也可以自拟，但优先用这些）：
工作、学习、生活、开发、运维、沟通、研究、杂事

输出 JSON，字段：
{"kind":"...","priority":"p0-p4","title":"...","category":"...","reason":"一句话说明为什么是这个优先级"}

不要输出任何解释、不要说"好的"、不要 markdown 代码块。`;

function jsonBlock(text) {
  if (!text) return null;
  const s = String(text).trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// 附件里的文本类内容，给模型当上下文
function readTextPreview(filePath, maxChars = 1500) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > 2 * 1024 * 1024) return null;
    const ext = path.extname(filePath).toLowerCase();
    const textual = ['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml',
      '.js', '.mjs', '.ts', '.py', '.java', '.sql', '.html', '.css', '.xml'];
    if (!textual.includes(ext)) return null;
    return fs.readFileSync(filePath, 'utf8').slice(0, maxChars);
  } catch { return null; }
}

function humanSize(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

function describeFiles(files = [], resolve) {
  return files.map((f) => {
    const raw = f.path || f;
    const p = resolve ? (resolve(raw) || raw) : raw;
    const name = path.basename(String(raw));
    const ext = path.extname(name).toLowerCase();
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* 忽略 */ }
    const line = `- ${name}（${ext || '无扩展名'}，${humanSize(size)}）`;
    const preview = readTextPreview(p);
    return preview
      ? `${line}\n  内容片段：${preview.replace(/\s+/g, ' ').slice(0, 800)}`
      : line;
  }).join('\n');
}

// 模型没给有效标题时的兜底
function buildFallbackTitle(task, parsed) {
  const raw = String(task.title || '').trim();
  const allNames = [...(task.images || []), ...(task.files || [])].map((x) => path.basename(String(x)));
  const isFilename = allNames.some((n) => n === raw);
  const generic = /^(截图|图片|附件|image|screenshot|file)$/i.test(raw) || isFilename;
  if (raw && !generic) return raw.slice(0, 120);

  const text = String(task.text || '').trim();
  if (text) return text.split(/\n/)[0].slice(0, 120);

  const r = String(parsed.reason || '').replace(/^(仅是|只是|这是|这只是|以上是)/, '').trim();
  if (r) return r.split(/[，。,.]/)[0].slice(0, 120);

  const files = [...(task.images || []), ...(task.files || [])];
  if (files.length) return '待整理：' + path.basename(String(files[0]));
  return '待整理';
}

export function createClassifier(opts = {}) {
  const backend = opts.backend || createBackend(opts);
  const imagesDir = opts.imagesDir || '';
  const filesDir = opts.filesDir || '';

  function resolveLocal(nameOrPath, dir) {
    const s = String(nameOrPath || '');
    if (!s) return null;
    if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return s;
    // 先查目标目录 —— 不能先试相对路径，否则会被 cwd 里的同名文件截胡
    if (dir) {
      const guess = path.join(dir, path.basename(s));
      if (fs.existsSync(guess)) return guess;
    }
    return fs.existsSync(s) ? path.resolve(s) : null;
  }

  async function classify(task) {
    const lines = [];

    if (task.text) lines.push('用户写的原文：\n' + String(task.text).slice(0, 4000));
    if (task.title && task.title !== task.text) lines.push('（标题候选：' + task.title + '）');
    if (task.urls && task.urls.length) lines.push('链接：\n' + task.urls.join('\n'));
    if (task.files && task.files.length) {
      lines.push('附件：\n' + describeFiles(task.files, (n) => resolveLocal(n, filesDir)));
    }

    const imgPaths = [];
    for (const img of (task.images || []).filter(Boolean).slice(0, 3)) {
      const local = resolveLocal(img, imagesDir);
      if (local) imgPaths.push(local);
      else lines.push('（一张图找不到：' + path.basename(String(img)) + '）');
    }
    if (imgPaths.length) lines.push('附带了 ' + imgPaths.length + ' 张图片，直接看图判断内容。');

    const r = await backend.chat({
      system: SYSTEM,
      text: lines.join('\n\n') || '（没有文字内容）',
      images: imgPaths
    });

    const parsed = jsonBlock(r.text);
    if (!parsed) throw new Error('模型没返回可解析的 JSON: ' + String(r.text).slice(0, 160));

    const priority = PRIORITIES.includes(parsed.priority) ? parsed.priority : 'p3';
    const kind = KINDS.includes(parsed.kind) ? parsed.kind : (task.kind || 'text');
    const guessedTitle = /^(截图|图片|附件|image|screenshot)$/i.test(String(parsed.title || '').trim());

    return {
      priority,
      kind,
      title: (typeof parsed.title === 'string' && parsed.title.trim() && !guessedTitle)
        ? parsed.title.trim().slice(0, 120)
        : buildFallbackTitle(task, parsed),
      category: typeof parsed.category === 'string' ? parsed.category.trim().slice(0, 20) : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '',
      model: r.model || '',
      backend: backend.name
    };
  }

  return { classify, backend };
}
