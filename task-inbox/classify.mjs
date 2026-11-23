// classify.mjs —— 调 Alma 的模型，自动判断一条记录的类型和优先级
//
// 输入是「用户原样丢进来的东西」：文字、图片、附件、链接。
// 输出是结构化的 { kind, priority, title, category }。
//
// 走 Alma 本机的 OpenAI 兼容接口，不需要额外配 key。

import fs from 'node:fs';
import * as _fs from 'node:fs';
import path from 'node:path';

const PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'p4'];

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
  // 容忍模型包了代码块
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// 把附件转成模型能读的片段
function readTextPreview(filePath, maxChars = 1500) {
  try {
    const st = fs.statSync(filePath);
    if (st.size > 2 * 1024 * 1024) return null;
    const ext = path.extname(filePath).toLowerCase();
    const textual = ['.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml',
      '.js', '.mjs', '.ts', '.py', '.java', '.sql', '.html', '.css', '.xml'];
    if (!textual.includes(ext)) return null;
    const s = fs.readFileSync(filePath, 'utf8');
    return s.slice(0, maxChars);
  } catch { return null; }
}

function describeFiles(files = [], resolve) {
  return files.map((f) => {
    const raw = f.path || f;
    const p = resolve ? (resolve(raw) || raw) : raw;
    const name = path.basename(String(raw));
    const ext = path.extname(name).toLowerCase();
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* 忽略 */ }
    const preview = readTextPreview(p);
    const line = `- ${name}（${ext || '无扩展名'}，${Math.round(size / 1024)}KB）`;
    return preview ? `${line}\n  内容片段：${preview.replace(/\s+/g, ' ').slice(0, 800)}` : line;
  }).join('\n');
}

// 模型没给出有效标题时，从原文或 reason 里拼一个能看的
function buildFallbackTitle(task, parsed) {
  const raw = String(task.title || '').trim();
  const allNames = [...(task.images || []), ...(task.files || [])].map((x) => path.basename(String(x)));
  const isFilename = allNames.some((n) => n === raw);
  const generic = /^(截图|图片|附件|image|screenshot|file)$/i.test(raw) || isFilename;
  if (raw && !generic) return raw.slice(0, 120);

  const text = String(task.text || '').trim();
  if (text) return text.split(/\n/)[0].slice(0, 120);

  // 用 reason 的第一句，去掉"仅是/只是"这类开头
  const r = String(parsed.reason || '').replace(/^(仅是|只是|这是|这只是|以上是)/, '').trim();
  if (r) return r.split(/[，。,.]/)[0].slice(0, 120);

  const files = [...(task.images || []), ...(task.files || [])];
  if (files.length) return '待整理：' + path.basename(String(files[0]));
  return '待整理';
}

function guessImageType(p) {
  const e = path.extname(p).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/png';
}

export function createClassifier(opts = {}) {
  const apiUrl = process.env.ALMA_API_URL || 'http://localhost:23001';
  const model = opts.model || process.env.TASK_INBOX_MODEL || 'auto/deepseek-v4.1-flash';
  const timeoutMs = opts.timeoutMs || 45000;
  const imageBase = opts.imageBase || 'http://127.0.0.1:46001';
  const imagesDir = opts.imagesDir || '';
  const filesDir = opts.filesDir || '';

  // 任务里存的可能只是文件名，也可能是绝对路径，统一解析成真实文件
  function resolveLocal(nameOrPath, dir) {
    const s = String(nameOrPath || '');
    if (!s) return null;
    // 绝对路径直接用
    if (s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) return s;
    // 先查目标目录 —— 不能先试相对路径，否则会被 cwd 里的同名文件截胡
    // （踩过：'notes.md' 命中了项目根的 NOTES.md，读到了完全无关的内容）
    if (dir) {
      const guess = path.join(dir, path.basename(s));
      if (_fs.existsSync(guess)) return guess;
    }
    return _fs.existsSync(s) ? path.resolve(s) : null;
  }

  // 本地图片 -> Alma gallery url。模型只能读 Alma 自己托管的 url。
  async function uploadToAlma(filePath) {
    const buf = await fs.promises.readFile(filePath);
    const res = await fetch(apiUrl + '/api/attachments/image', {
      method: 'POST',
      headers: { 'content-type': guessImageType(filePath) },
      body: buf,
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new Error('附件上传 ' + res.status);
    const d = await res.json();
    return d.url || null;
  }

  // 找 providerId（Alma 要求 providerId:modelId）
  let cachedFullModel = null;
  async function resolveModel() {
    if (cachedFullModel) return cachedFullModel;
    if (model.includes(':')) { cachedFullModel = model; return cachedFullModel; }
    try {
      const r = await fetch(apiUrl + '/api/models', { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      const list = d.data || d.models || [];
      const hit = list.find((m) => m.id === model) || list.find((m) => m.capabilities?.vision);
      if (hit) {
        cachedFullModel = hit.providerId + ':' + hit.id;
        return cachedFullModel;
      }
    } catch { /* 忽略，退回裸 model 名 */ }
    cachedFullModel = model;
    return cachedFullModel;
  }

  async function classify(task) {
    const parts = [];
    const lines = [];

    if (task.text) lines.push('用户写的原文：\n' + String(task.text).slice(0, 4000));
    if (task.title && task.title !== task.text) lines.push('（标题候选：' + task.title + '）');
    if (task.urls && task.urls.length) lines.push('链接：\n' + task.urls.join('\n'));
    if (task.files && task.files.length) {
      lines.push('附件：\n' + describeFiles(task.files, (n) => resolveLocal(n, filesDir)));
    }

    const imgs = (task.images || []).filter(Boolean);
    if (imgs.length) lines.push('附带了 ' + imgs.length + ' 张图片。');

    parts.push({ type: 'text', text: lines.join('\n\n') || '（没有文字内容）' });

    // 图片要先进 Alma 的 gallery cache 才能被模型读到。
    // 直接用本地路径或自建服务的 url 都会失败（模型那边拉不到）。
    for (const img of imgs.slice(0, 3)) {
      try {
        const local = resolveLocal(img, imagesDir);
        if (!local) { lines.push('（一张图找不到：' + path.basename(String(img)) + '）'); continue; }
        const url = await uploadToAlma(local);
        if (!url) continue;
        parts.push({
          type: 'file',
          filename: path.basename(String(img)),
          mediaType: guessImageType(String(img)),
          url
        });
      } catch (e) {
        lines.push('（一张图上传失败：' + (e.message || e).slice(0, 80) + '）');
      }
    }

    const body = {
      model: await resolveModel(),
      stream: false,
      temperature: 0.2,
      messages: [
        { role: 'system', parts: [{ type: 'text', text: SYSTEM }] },
        { role: 'user', parts }
      ]
    };

    const res = await fetch(apiUrl + '/api/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const raw = await res.text();
    if (!res.ok) throw new Error('模型调用失败 ' + res.status + ': ' + raw.slice(0, 200));

    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('返回不是 JSON'); }
    const content = data?.choices?.[0]?.message?.content;
    const parsed = jsonBlock(content);
    if (!parsed) throw new Error('模型没返回可解析的 JSON: ' + String(content).slice(0, 160));

    const priority = PRIORITIES.includes(parsed.priority) ? parsed.priority : 'p3';
    const guessedTitle = /^(截图|图片|附件|image|screenshot)$/i.test(String(parsed.title || '').trim());
    const kind = ['text', 'image', 'image_text', 'link', 'file', 'mixed'].includes(parsed.kind)
      ? parsed.kind : task.kind || 'text';

    return {
      priority,
      kind,
      title: (typeof parsed.title === 'string' && parsed.title.trim() && !guessedTitle)
        ? parsed.title.trim().slice(0, 120)
        : buildFallbackTitle(task, parsed),
      category: typeof parsed.category === 'string' ? parsed.category.trim().slice(0, 20) : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '',
      model: data?.model || model
    };
  }

  return { classify, resolveModel };
}
