// core.mjs —— 任务存储的纯逻辑层
//
// 这里不碰 http、不碰任何外部 API，只做一件事：把任务存进 SQLite、读出来、改掉。
//
// 和旧版的区别：
//   旧版每次操作都 load() 整个 tasks.json + 改 + save() 全量写回。
//   现在每条 SQL 只碰它该碰的那几行 —— 追加一句聊天不再重写整个库。
//
// 附件（图片/文件）仍然放文件系统，不进库；settings 留在库里一张小表。
//
// 数据库文件：<dataDir>/tasks.db（WAL 模式，多进程读写安全）

import fs from 'node:fs';
import path from 'node:path';

import { openSqlite, applySchema, migrateFromJson } from './storage.mjs';

export const STATUSES = ['todo', 'doing', 'done'];
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'p4'];
export const KINDS = ['text', 'image', 'image_text', 'link', 'file', 'mixed'];

// 卡片关系的种类。一张 links 表装四种边，用 kind 区分 ——
// 它们的形状一样（有向边 + 两端 + 一句说明），只有约束不同。
// 本轮（第 1 步）只实现 merge_parent / split_of 的语义，parent / depends_on
// 只允许建边删边，环检测和派生 status 留给第 2、3 步。
export const LINK_KINDS = ['merge_parent', 'split_of', 'parent', 'depends_on'];

// 阶段 1A：外部 Agent 的持久会话。Role 是「这张卡里的职责」，
// Agent 是「哪个 CLI 产品」，两者分开 —— 同一个 OpenCode 可以当开发，
// 也可以当审阅，各自有独立 Session。
export const AGENT_ROLES = ['plan', 'dev', 'review', 'test'];
export const AGENT_TYPES = ['opencode', 'codex'];
export const SESSION_STATUSES = ['idle', 'busy', 'unavailable', 'unknown'];
export const TURN_STATUSES = ['queued', 'running', 'completed', 'failed', 'interrupted', 'unknown'];

export const PRIORITY_LABEL = {
  p0: 'P0 阻塞', p1: 'P1 紧急', p2: 'P2 常规', p3: 'P3 低', p4: 'P4 待定'
};

export const KIND_LABEL = {
  text: '文字', image: '图片', image_text: '图+文', link: '链接',
  file: '附件', mixed: '混合'
};

export const DEFAULT_SETTINGS = {
  backend: 'auto',                      // auto | magpie | opencode | codex
  model: 'auto/deepseek-v4.1-flash',
  classify: true,                       // 关掉就只收不判
  // done 超过这么多天就自动归档。一年调一次的参数，所以只放库里，不做输入框。
  archive_after_days: 30
};

// 「默认」不是普通项目，是模型判不出项目时的收件筐。
// 认名字不认 id：老库里它的 id 可能是 p_default，也可能是迁移时现生成的。
export const DEFAULT_PROJECT_NAME = '默认';

// 单张卡片的聊天上限。旧版是 200（当时是为了别让 JSON 无限膨胀），
// 现在存库没有这个压力，放宽到 2000 仍然保留一个兜底删除。
const MAX_MESSAGES_PER_TASK = 2000;

const PRIORITY_ORDER_SQL = `CASE priority
  WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3
  WHEN 'p4' THEN 4 ELSE 9 END`;

export function createCore(dataDir) {
  const dbFile = path.join(dataDir, 'tasks.db');
  const jsonFile = path.join(dataDir, 'tasks.json');
  const imagesDir = path.join(dataDir, 'images');
  const filesDir = path.join(dataDir, 'files');
  const settingsFile = path.join(dataDir, 'settings.json');

  let db = null;

  // 懒打开：createCore() 只算配置，第一次真正用的时候才建文件。
  function conn() {
    if (db) return db;
    fs.mkdirSync(dataDir, { recursive: true });
    db = applySchema(openSqlite(dbFile));
    return db;
  }

  // 空库也要有一个「默认」项目，否则项目下拉是空的，收任务时没地方落。
  // 注意：只能在迁移之后调用 —— 迁移前插「默认」会占掉 name 唯一约束，
  // 导致老数据里那个「默认」项目插不进去，任务的外键就悬空了。
  function ensureDefaultProject() {
    if (!db) return;
    const n = Number(db.get('SELECT COUNT(*) AS c FROM projects')?.c || 0);
    if (n > 0) return;
    const now = nowIso();
    db.run(
      `INSERT OR IGNORE INTO projects (id, name, aliases, dirs, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      ['p_default', '默认', '[]', '[]', now, now]
    );
  }

  function nowIso() { return new Date().toISOString(); }

  // id 生成：时间戳 + 自增计数 + 随机尾巴。
  // 旧版是「时间戳 + 模 1000 的计数」/「时间戳 + 3 位随机」，批量写入时
  // 同一毫秒内会撞 id（实测 6 万条消息就 UNIQUE 冲突）。计数不取模 + 随机尾巴解决。
  let idSeq = 0;
  function shortId(prefix) {
    idSeq = (idSeq + 1) % Number.MAX_SAFE_INTEGER;
    const rand = Math.random().toString(36).slice(2, 6);
    return prefix + Date.now().toString(36) + idSeq.toString(36) + rand;
  }

  const newProjectId = () => shortId('p_');
  const newId = () => shortId('t_');
  const newMessageId = () => shortId('m_');
  const newSessionId = () => shortId('ags_');
  const newTurnId = () => shortId('turn_');

  function normalizeKind(k) { return KINDS.includes(k) ? k : 'text'; }

  function normalizeDir(d = {}) {
    const raw = typeof d === 'string' ? { path: d } : d;
    return {
      path: String(raw.path || '').trim(),
      note: String(raw.note || '').trim().slice(0, 200),
      primary: !!raw.primary
    };
  }

  // JSON 列读取：坏数据不该让整个列表崩掉
  function parseJson(text, fallback) {
    if (text === null || text === undefined || text === '') return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
  }

  // 「还缺什么」归一化：只留非空字符串，最多 3 条。
  // 存进来的时候已经过 classify.parseGaps 收过一次，这里再收一遍是因为
  // 库是唯一真相 —— 手改过、老版本写过的脏值不能直接喂给前端渲染。
  function normalizeGaps(g) {
    if (!Array.isArray(g)) return [];
    return g.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 3);
  }

  // 对话附件归一化：形状跟 tasks.payload 的 images/files 一致，
  // 前端两处能用同一套渲染。两个数组都空就返回 null —— 空对象没必要占一列。
  function normalizeAttachments(a) {
    if (!a || typeof a !== 'object') return null;
    const images = Array.isArray(a.images) ? a.images.filter(Boolean) : [];
    const files = Array.isArray(a.files) ? a.files.filter(Boolean) : [];
    return (images.length || files.length) ? { images, files } : null;
  }

  // ---------- 表格视图的字段归一化（v8）----------
  //
  // 这两类字段（工时 / 计划日期）都存在「用户在一个 `<input>` 里打字」这个
  // 入口上，所以会收到 ''、'abc'、' 3 '、'-1' 这些形状。归一化只做一件事：
  // 把「说不清的值」变成 NULL，而不是让它落库变成脏数据 ——
  // 表格里一个 `NaN` 会渲染成字面量 `NaN`，比空着难看得多。

  /** 工时：空 / 非数字 / 负数一律 NULL。0 是合法值（「不用时间」也是一种估计）。 */
  function normalizeHours(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * 计划日期：只认 `YYYY-MM-DD`，空 → NULL。
   * **格式不对就抛错，不静默丢**：日期是给人排期的，`2026/3/5` 被悄悄吞掉
   * 之后，用户会以为填进去了，等到要看排期时才发现是空的。
   * 用正则而不是 `new Date()` 解析：`2026-02-31` 会被 JS 顺手滚成 3 月 3 日，
   * 那是替用户改数据。多一层「这天真的存在吗」的校验。
   */
  function normalizeDate(v, field) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (!DATE_RE.test(s)) throw new Error((field || '日期') + '只接受 YYYY-MM-DD（收到「' + s + '」）');
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
      throw new Error((field || '日期') + '不是一个真实存在的日子（收到「' + s + '」）');
    }
    return s;
  }

  /** 短编号的显示串。放后端做，前端不拼 —— 格式只该有一处定义。 */
  function seqLabel(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return null;
    return 'T-' + String(Math.trunc(num)).padStart(3, '0');
  }

  /**
   * 负责人：一个人名，不是列表（文档第五节第 5 条：先单值）。
   * 空串 → NULL，和「没填」是同一件事；顺手截到 60 字，
   * 免得有人把一整段需求描述贴进这个格子。
   */
  function normalizeOwner(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().slice(0, 60);
    return s || null;
  }

  function rowToProject(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      aliases: parseJson(r.aliases, []),
      dirs: parseJson(r.dirs, []),
      sort_order: Number(r.sort_order || 0),
      // 阶段 1A：新卡挂会话时继承这两个默认值；NULL = 用 Agent 自己的默认
      default_agent: r.default_agent ?? null,
      default_model: r.default_model ?? null,
      // NULL = 未归档。归档项目不出现在侧栏和下拉里，但历史任务仍能显示项目名
      archived_at: r.archived_at ?? null,
      // 前端不该把「默认」这个字符串写死两遍，语义从接口里给
      isDefault: r.name === DEFAULT_PROJECT_NAME,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  }

  function rowToTask(r) {
    if (!r) return null;
    const t = {
      id: r.id,
      title: r.title,
      kind: r.kind,
      payload: parseJson(r.payload, { text: null, images: [], files: [], urls: [], path: null }),
      project: r.project,
      project_id: r.project_id,
      category: r.category,
      status: r.status,
      priority: r.priority,
      note: r.note,
      source: r.source,
      brief: r.brief,
      brief_at: r.brief_at,
      classify_state: r.classify_state,
      classify_reason: r.classify_reason,
      classify_model: r.classify_model,
      claimed_by: r.claimed_by,
      needs_project: Number(r.needs_project || 0) === 1,
      // 0 = 待澄清。库里是 0/1，外面一律给布尔，跟 needs_project 一致
      dev_ready: Number(r.dev_ready ?? 1) !== 0,
      // 初判说「还缺这些」。存 JSON 数组，读出来就是数组，前端直接渲染成列表
      dev_gaps: normalizeGaps(parseJson(r.dev_gaps, [])),
      archived_at: r.archived_at ?? null,
      // 被合并进的卡片 id。非空 = 这张卡是历史记录，只读、不进看板
      merged_into: r.merged_into ?? null,
      // 预留列：本轮拆分按「done + 备注」处理，这里恒为 null
      split_state: r.split_state ?? null,
      // 前置被删/被合并时写下的一句话。非空 = 依赖关系需要人来重新确认一次，
      // 用户看过就 PATCH 成空串（前端那个「知道了」按钮）
      link_warn: r.link_warn ?? '',
      // 冗余的父卡 id（跟着 parent 边同步）。真值是 links 里的那条件，
      // 这一列只是让「这张卡有没有父卡」不用 join —— 见 storage.mjs MIGRATIONS[6]
      parent_id: r.parent_id ?? null,
      // ---- 表格视图的 6 个业务字段（v8）----
      // seq_no 是身份，不可改；no 是它的显示串（T-001），后端拼好，
      // 前端直接渲染 —— 格式只该有一处定义。
      seq_no: r.seq_no === null || r.seq_no === undefined ? null : Number(r.seq_no),
      no: seqLabel(r.seq_no),
      plan_start_at: r.plan_start_at ?? null,
      plan_end_at: r.plan_end_at ?? null,
      owner: r.owner ?? null,
      // 读的时候也归一化：手改库、老版本、导出再导入都可能塞进脏值，
      // 前端表格直接渲染这个数，不该在那边再判一次。
      estimate_hours: normalizeHours(r.estimate_hours),
      actual_hours: normalizeHours(r.actual_hours),
      created_at: r.created_at,
      updated_at: r.updated_at,
      doing_at: r.doing_at,
      done_at: r.done_at
    };
    if (r.message_count !== undefined) t.message_count = Number(r.message_count || 0);
    // 阶段 1A：卡片上的 Agent 徽标只看这两个派生值。
    // 不把整个会话列表塞进 /api/state —— 那会让每 3 秒的轮询跟着变大。
    if (r.agent_session_count !== undefined) t.agent_session_count = Number(r.agent_session_count || 0);
    if (r.agent_status !== undefined) t.agent_status = r.agent_status ?? null;
    return t;
  }

  function rowToMessage(r) {
    if (!r) return null;
    return {
      id: r.id,
      role: r.role,
      text: r.text,
      patch: parseJson(r.patch, null),
      // 形状跟 tasks.payload 的 images/files 一致，前端两处能用同一套渲染
      attachments: parseJson(r.attachments, null),
      at: r.at
    };
  }

  function rowToSession(r) {
    if (!r) return null;
    const s = {
      id: r.id,
      task_id: r.task_id,
      role: r.role,
      agent: r.agent,
      external_session_id: r.external_session_id ?? null,
      working_directory: r.working_directory,
      model: r.model ?? null,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
    // listSessions / getSession 会带上最近一轮；单条纯行没有这两个字段
    if (r.last_turn_status !== undefined) {
      s.last_turn = r.last_turn_id ? {
        id: r.last_turn_id,
        status: r.last_turn_status,
        user_text: r.last_turn_user_text || '',
        result_text: r.last_turn_result_text || '',
        error: r.last_turn_error || '',
        started_at: r.last_turn_started_at ?? null,
        ended_at: r.last_turn_ended_at ?? null
      } : null;
    }
    if (r.turn_count !== undefined) s.turn_count = Number(r.turn_count || 0);
    return s;
  }

  function rowToTurn(r) {
    if (!r) return null;
    return {
      id: r.id,
      session_id: r.session_id,
      status: r.status,
      user_text: r.user_text,
      result_text: r.result_text || '',
      error: r.error || '',
      events_file: r.events_file ?? null,
      external_ref: r.external_ref ?? null,
      exit_code: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
      started_at: r.started_at ?? null,
      ended_at: r.ended_at ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  }

  /** 任务查询统一带一个消息计数，前端不用再为了「有几条」把消息全读出来 */
  const TASK_SELECT = `
    SELECT t.*,
           (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id) AS message_count,
           (SELECT COUNT(*) FROM agent_sessions s WHERE s.task_id = t.id) AS agent_session_count,
           (SELECT s.status FROM agent_sessions s WHERE s.task_id = t.id
             ORDER BY s.updated_at DESC LIMIT 1) AS agent_status
      FROM tasks t`;

  // ---------- 关系派生字段 ----------
  //
  // 列表里每张卡要带 has_merge / has_split / link_counts，以及依赖的
  // blocked / waiting_count / blocking_count。这些都是派生的，
  // 不能存在 tasks 上（否则「改了层级，合并历史也跟着变」那种事就会出现）。
  //
  // 一次把 links 全捞出来在内存里归并：这张表很小（一条边两行数据），
  // 一次全表扫比「每张卡再查一次」便宜一个数量级 —— 后者 2000 条任务
  // 就是 2000 次 SQL，而 /api/state 每 3 秒被轮询一次。
  //
  // left join 一下 to 端的任务状态：判断「前置做完了没」需要它，
  // 分开查就是 edges 条额外的 SQL。
  // 列名刻意不加前缀 —— 这个行对象会直接喂给 prereqBlocks()，
  // 它认的是 status / archived_at / merged_into 三个字段名。
  const LINK_STAT_SQL = `
    SELECT l.kind, l.from_id, l.to_id, t.status, t.archived_at, t.merged_into
      FROM links l LEFT JOIN tasks t ON t.id = l.to_id`;

  function linkStats(ids) {
    const stat = new Map();
    if (!ids.size) return stat;
    const hit = (id) => {
      if (!ids.has(id)) return null;
      let s = stat.get(id);
      if (!s) { s = { from: {}, to: {}, waiting: 0, blocking: 0 }; stat.set(id, s); }
      return s;
    };
    for (const r of conn().all(LINK_STAT_SQL)) {
      const fromSide = hit(r.from_id);
      const toSide = hit(r.to_id);
      if (fromSide) fromSide.from[r.kind] = (fromSide.from[r.kind] || 0) + 1;
      if (toSide) toSide.to[r.kind] = (toSide.to[r.kind] || 0) + 1;
      // 依赖：只有「前置真的还没做完」才算数，否则一条已完成的边会永远算成阻塞
      if (r.kind === 'depends_on' && prereqBlocks(r)) {
        if (fromSide) fromSide.waiting += 1;      // 我还在等几条
        if (toSide) toSide.blocking += 1;         // 我挡住了几条下游
      }
    }
    return stat;
  }

  // 前置算不算「还欠着」。
  //   · done            → 做完了，不拦
  //   · merged_into 非空 → 被合并进别的卡了，**视为已完成**：合并出来的那张卡
  //                        承接它的状态，不能因为一条前置被合并就永久卡住别人
  //   · 已归档          → 出了流水线，不再占着别人（归档只发生在 done 之后，
  //                        这条主要是防手改/脏数据）
  function prereqBlocks(r) {
    if (r.merged_into) return false;
    if (r.status === 'done') return false;
    if (r.archived_at) return false;
    return true;
  }

  // ---------- 层级（parent / child）----------
  //
  // 方向：**子 → 父**，和 depends_on 同向（from 指向 to）。
  // 文档第 1.3 节定了三条约束，这里是它们的落点：
  //   1. 不能成环      → ACYCLIC.parent + reachable（复用依赖那套）
  //   2. 深度上限 5 层 → linkTasks 里算「to 的祖先数 + 2 + from 的子树高」
  //   3. 父卡状态派生   → recomputeStatus() + patch() 拒绝对有子项的卡手改
  //
  // 第 3 条只能放服务端：curl 一条 PATCH 就绕过前端，库里立刻出现
  // 「父卡 done、下面三个 doing」—— 那比不做这个功能更糟。
  const MAX_DEPTH = 5;

  /** 这张卡有几个直接子项。走冗余列 parent_id，不 join links。 */
  function childCount(id) {
    return Number(conn().get('SELECT COUNT(*) AS c FROM tasks WHERE parent_id = ?', [id])?.c || 0);
  }

  /**
   * parent 边的 child → parent 单值映射。
   * 一张卡只允许有一个上级（多父会让「往上爬重算」变成分叉），
   * 所以这里刻意用 Map 而不是邻接数组。
   */
  function parentMap() {
    const map = new Map();
    for (const r of conn().all(
      "SELECT from_id, to_id FROM links WHERE kind = 'parent' ORDER BY created_at, rowid"
    )) {
      if (!map.has(r.from_id)) map.set(r.from_id, r.to_id);
    }
    return map;
  }

  /** 全库的 parent_id → 子项，一次捞出来给派生字段用（别每张卡查一次）。 */
  function childIndex() {
    const map = new Map();
    for (const r of conn().all(
      `SELECT id, parent_id, status, merged_into, archived_at
         FROM tasks WHERE parent_id IS NOT NULL ORDER BY created_at, rowid`
    )) {
      if (!map.has(r.parent_id)) map.set(r.parent_id, []);
      map.get(r.parent_id).push(r);
    }
    return map;
  }

  /** 直接子项，带卡片渲染要的几列。按创建时间 —— 先记的先列。 */
  function childrenOf(taskId) {
    const id = String(taskId || '');
    if (!id) throw new Error('缺 taskId');
    return conn().all(
      `SELECT id, title, status, priority, project, category, archived_at, merged_into, created_at
         FROM tasks WHERE parent_id = ? ORDER BY created_at, rowid`, [id]
    ).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      project: r.project,
      category: r.category,
      archived_at: r.archived_at ?? null,
      merged_into: r.merged_into ?? null,
      created_at: r.created_at
    }));
  }

  /**
   * 整棵子树的状态分布，给卡片上那个「3/5」用。
   *
   * 算的是**所有后代**，不只是第一层 —— 「3/5」是给人看进度的，
   * 而子项本身也可能是容器（5 层结构里很常见），只数第一层会骗人。
   * 深度上限 5（MAX_DEPTH），所以这里最多 5 轮循环，不需要递归。
   *
   * 归档的子项照算（它确实做完了）；被合并的子项按它自己的 status 算 ——
   * 合并只是「它变成了别人」，不是「它没做过」。
   */
  function subtreeStats(taskId, idx) {
    const index = idx || childIndex();
    const out = { total: 0, done: 0, doing: 0, todo: 0 };
    const seen = new Set([String(taskId || '')]);
    let level = index.get(String(taskId || '')) || [];
    for (let d = 0; d < MAX_DEPTH && level.length; d++) {
      const next = [];
      for (const c of level) {
        if (seen.has(c.id)) continue;        // 脏数据成环时兜底，别死循环
        seen.add(c.id);
        out.total += 1;
        if (c.status === 'done') out.done += 1;
        else if (c.status === 'doing') out.doing += 1;
        else out.todo += 1;
        for (const g of index.get(c.id) || []) next.push(g);
      }
      level = next;
    }
    return out;
  }

  /** 这张卡上面有几层上级（根 = 0）。顺着 parent 边往上爬，带成环兜底。 */
  function ancestorDepth(id, adj) {
    const map = adj || parentMap();
    const seen = new Set([String(id)]);
    let cur = String(id);
    let d = 0;
    for (let hop = 0; hop <= MAX_DEPTH + 2; hop++) {
      const up = map.get(cur);
      if (!up || seen.has(up)) break;
      seen.add(up);
      cur = up;
      d += 1;
    }
    return d;
  }

  /** 这张卡下面有几层（叶子 = 0）。和 ancestorDepth 对称，用来算加边后的总深度。 */
  function subtreeHeight(id, idx) {
    const index = idx || childIndex();
    const seen = new Set([String(id)]);
    let level = index.get(String(id)) || [];
    let h = 0;
    while (level.length && h < MAX_DEPTH) {
      h += 1;
      const next = [];
      for (const c of level) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        for (const g of index.get(c.id) || []) next.push(g);
      }
      level = next;
    }
    return h;
  }

  /**
   * 给一张卡挂上层级派生字段。
   *   child_count  **直接**子项数（抽屉里那句「状态由 3 个子项决定」读它）
   *   subtree      所有后代的状态分布（卡片上那个「3/5」读它）
   * 两个数刻意分开：直接子项决定这张卡的状态，后代只用来显示进度，
   * 混成一个数就会出现「3 个子项决定状态」里面数着孙子。
   */
  function applyChildStat(t, idx) {
    const index = idx || childIndex();
    const direct = index.get(t.id) || [];
    t.child_count = direct.length;
    t.has_children = direct.length > 0;
    t.subtree = subtreeStats(t.id, index);
    return t;
  }

  /**
   * 子项「算不算做完了」。和 prereqBlocks() 同一个判断，理由也一样：
   * 被合并的子项（merged_into 非空）**视为已完成** —— 它已经变成了别人，
   * 合并出来的那张卡承接它的进度。不这么算的话，一条被合并掉的子项会让
   * 父卡永远停在 todo，没有任何入口能解开。
   */
  function childDone(c) {
    if (c.merged_into) return true;
    return c.status === 'done';
  }

  /**
   * 父卡状态的派生规则（文档 1.3 第 3 条）：
   *   全 done → done；任一 doing → doing；否则 todo
   * 空列表返回 null（没有子项就没有派生值，不动它）。
   */
  function deriveStatus(children) {
    if (!children.length) return null;
    if (children.every(childDone)) return 'done';
    if (children.some((c) => c.status === 'doing' && !c.merged_into)) return 'doing';
    return 'todo';
  }

  /** 给一张卡填上派生字段。linkStats 一次算好，这里只做赋值 —— 别各算一套。 */
  function applyLinkStat(t, s) {
    const e = s || { from: {}, to: {}, waiting: 0, blocking: 0 };
    t.has_merge = (e.from.merge_parent || 0) > 0;
    t.has_split = (e.from.split_of || 0) > 0;
    const counts = {};
    for (const k of LINK_KINDS) counts[k] = (e.from[k] || 0) + (e.to[k] || 0);
    t.link_counts = counts;
    // 依赖派生：blocked 是「我还在等」，blocking_count 是「我挡住了谁」
    t.blocked = e.waiting > 0;
    t.waiting_count = e.waiting;
    t.blocking_count = e.blocking;
    return t;
  }

  /**
   * 给一批任务挂上关系派生字段。原地改，返回同一个数组。
   *
   *   has_merge      这张卡有 merge_parent 边指向旧卡（= 它是合并出来的新卡）
   *   has_split      这张卡有 split_of 边指向子卡（= 它被拆过）
   *   link_counts    两个方向都算：这张卡身上一共有多少条边，按 kind 分
   *   blocked        还有前置没做完（depends_on 出边里 status 不是 done 的）
   *   waiting_count  我还在等几条
   *   blocking_count 我挡住了几条下游
   *   has_children   这张卡有子项（status 因此变成只读）
   *   child_count    子项总数，**含所有后代**（5 层结构里只数第一层会骗人）
   *   subtree        {total,done,doing,todo} —— 卡片上那个「3/5」
   *
   * 方向的选择是刻意的：has_merge / has_split 只看「我指向谁」，
   * 因为徽章是入口 —— 点开看的是「我从哪来 / 我拆出了什么」。
   * 反方向的边（谁合并了我 / 我是谁拆出来的）在 link_counts 和抽屉的
   * 「关系」区里都能看到，不占卡片上那点位置。
   */
  function decorateLinks(tasks) {
    const ids = new Set(tasks.map((t) => t.id));
    const stat = linkStats(ids);
    // 子项索引只建一次：subtreeStats 每张卡都调，各建一份就是 O(卡片数 × 全表)
    const idx = childIndex();
    for (const t of tasks) {
      applyLinkStat(t, stat.get(t.id));
      applyChildStat(t, idx);
    }
    return tasks;
  }

  // ---------- 初始化 / 迁移 ----------

  /**
   * 建库建表；如果目录里还有老的 tasks.json 且库是空的，顺手迁进来。
   * 幂等：反复调用没副作用。
   */
  function init(opts = {}) {
    const d = conn();
    let migration = null;
    try {
      migration = migrateFromJson(d, dataDir, opts);
    } catch (e) {
      migration = { migrated: false, reason: '迁移失败：' + e.message };
    }

    ensureDefaultProject();
    const revived = reviveStuckPending();
    // 注意：Turn 恢复**不在这里做**。core.init() 也会被 `cli.mjs init` 调用，
    // 如果 CLI 在服务还在跑时执行 init，会把别人正在跑的 Turn 全标成 unknown，
    // 释放唯一索引后还能再插一轮，两个 Turn 就抢同一个外部 Session。
    // 恢复只由 server 的 agent runner 在自己的启动路径里做。
    return { dbFile, migration, revived };
  }

  // 分类进行到一半进程被杀（重启/崩溃/断电），任务会永远停在「判断中…」，
  // 而前端只在 failed 时显示「未判断」，pending 就一直转圈，没有任何入口能重试。
  // 启动时把超过 5 分钟还挂着的 pending 收成 failed，让失败态暴露出来。
  const STUCK_PENDING_MS = 5 * 60 * 1000;
  function reviveStuckPending() {
    const d = conn();
    const cutoff = new Date(Date.now() - STUCK_PENDING_MS).toISOString();
    const rows = d.all(
      "SELECT id FROM tasks WHERE classify_state = 'pending' AND updated_at < ?",
      [cutoff]
    );
    if (!rows.length) return 0;
    d.tx(() => {
      for (const r of rows) {
        d.run(
          "UPDATE tasks SET classify_state = 'failed', classify_reason = ? WHERE id = ? AND classify_state = 'pending'",
          ['上次判断被中断（进程退出），可以重新判断', r.id]
        );
      }
    });
    return rows.length;
  }

  // ---------- 项目 ----------

  function listProjects(opts = {}) {
    const d = conn();
    // 顺序 = 用户拖出来的 sort_order；同值（老库刚升上来）时退回创建时间，保证稳定
    const rows = d.all(
      // taskCount 和侧栏/看板用同一个口径：归档的、被合并的、待澄清的都不算。
      // 否则「诺华(13)」和侧栏「诺华 7」同屏出现，用户又要问哪个是真的。
      `SELECT p.*, (SELECT COUNT(*) FROM tasks t
                      WHERE t.project_id = p.id
                        AND t.archived_at IS NULL
                        AND t.merged_into IS NULL
                        AND COALESCE(t.dev_ready, 1) = 1) AS taskCount
         FROM projects p
        ${opts.include_archived ? '' : 'WHERE p.archived_at IS NULL'}
        ORDER BY p.sort_order, p.created_at`
    );
    return rows.map((r) => ({ ...rowToProject(r), taskCount: Number(r.taskCount || 0) }));
  }

  function getProject(id) {
    if (!id) return null;
    return rowToProject(conn().get('SELECT * FROM projects WHERE id = ?', [id]));
  }

  function addProject(name, opts = {}) {
    const d = conn();
    const n = String(name || '').trim();
    if (!n) throw new Error('项目名不能为空');
    if (d.get('SELECT id FROM projects WHERE name = ?', [n])) {
      throw new Error('项目已存在: ' + n);
    }
    const proj = {
      id: newProjectId(),
      name: n,
      aliases: Array.isArray(opts.aliases) ? opts.aliases.map(String).filter(Boolean) : [],
      dirs: Array.isArray(opts.dirs) ? opts.dirs.map(normalizeDir).filter((x) => x.path) : [],
      // 新项目排到最后，不能插到「默认」前面 —— 那个位置是收件筐的
      sort_order: nextSortOrder(),
      created_at: nowIso(),
      updated_at: nowIso()
    };
    d.run(
      `INSERT INTO projects (id, name, aliases, dirs, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [proj.id, proj.name, JSON.stringify(proj.aliases), JSON.stringify(proj.dirs),
        proj.sort_order, proj.created_at, proj.updated_at]
    );
    return proj;
  }

  // 排在所有项目之后（「默认」是 0，所以 max+1 至少是 1）
  function nextSortOrder() {
    const r = conn().get('SELECT MAX(sort_order) AS m FROM projects');
    return Number(r?.m || 0) + 1;
  }

  function updateProject(id, fields = {}) {
    const d = conn();
    const cur = getProject(id);
    if (!cur) throw new Error('项目不存在: ' + id);

    const next = { ...cur };

    if (fields.name !== undefined) {
      const n = String(fields.name).trim();
      if (!n) throw new Error('项目名不能为空');
      const dup = d.get('SELECT id FROM projects WHERE name = ? AND id <> ?', [n, id]);
      if (dup) throw new Error('项目名重复: ' + n);
      next.name = n;
    }
    if (fields.aliases !== undefined) {
      next.aliases = (fields.aliases || []).map(String).filter(Boolean);
    }
    if (fields.dirs !== undefined) {
      next.dirs = (fields.dirs || []).map(normalizeDir).filter((x) => x.path);
    }
    if (fields.default_agent !== undefined) {
      const a = fields.default_agent === null || fields.default_agent === ''
        ? null : String(fields.default_agent).trim();
      if (a !== null && !AGENT_TYPES.includes(a)) throw new Error('非法默认 Agent: ' + a);
      next.default_agent = a;
    }
    if (fields.default_model !== undefined) {
      const m = fields.default_model === null ? '' : String(fields.default_model).trim();
      next.default_model = m || null;
    }
    if (fields.archived_at !== undefined) {
      if (fields.archived_at === null) {
        next.archived_at = null;
      } else {
        // 「默认」是流水线最后一道落点，归档它等于把未分配筐藏起来。
        if (cur.name === DEFAULT_PROJECT_NAME) throw new Error('「默认」不能归档');
        const active = Number(d.get(
          `SELECT COUNT(*) AS c FROM tasks
            WHERE project_id = ? AND archived_at IS NULL AND merged_into IS NULL`,
          [id]
        )?.c || 0);
        // 归档不搬任务：项目一藏起来，这些任务就既不在侧栏项目里、也不在收件筐里，
        // 等于凭空消失。先让人把它们移走或归档，再归档项目。
        if (active > 0) throw new Error('还有 ' + active + ' 条任务没移走，不能归档项目');
        next.archived_at = String(fields.archived_at);
      }
    }
    next.updated_at = nowIso();

    d.tx(() => {
      d.run(
        `UPDATE projects
            SET name = ?, aliases = ?, dirs = ?, default_agent = ?, default_model = ?,
                archived_at = ?, updated_at = ?
          WHERE id = ?`,
        [next.name, JSON.stringify(next.aliases), JSON.stringify(next.dirs),
          next.default_agent ?? null, next.default_model ?? null, next.archived_at ?? null,
          next.updated_at, id]
      );
      // 任务上的冗余项目名跟着改，保持「外部直接读」的那个便利
      if (next.name !== cur.name) {
        d.run('UPDATE tasks SET project = ? WHERE project_id = ?', [next.name, id]);
      }
    });

    return getProject(id);
  }

  function deleteProject(id) {
    const d = conn();
    const cur = getProject(id);
    if (!cur) throw new Error('项目不存在: ' + id);

    // 「默认」是流水线的最后一道落点（未分配收件筐），删了它整条链路就断了：
    // 判不出项目的任务会当场重建一个同名新项目，id 换掉，历史引用全断。
    if (cur.name === DEFAULT_PROJECT_NAME) {
      throw new Error('「默认」是未分配收件筐，不能删除');
    }

    const total = Number(d.get('SELECT COUNT(*) AS c FROM projects')?.c || 0);
    if (total <= 1) throw new Error('至少要保留一个项目');

    // 删项目时它的任务回到收件筐，而不是塞进某个真实项目 —— 那些任务本来就还没分配
    const fallback = d.get("SELECT * FROM projects WHERE name = ? AND id <> ?", [DEFAULT_PROJECT_NAME, id])
      || d.get('SELECT * FROM projects WHERE id <> ? ORDER BY sort_order, created_at LIMIT 1', [id]);
    if (!fallback) throw new Error('至少要保留一个项目');

    d.tx(() => {
      d.run('UPDATE tasks SET project_id = ?, project = ? WHERE project_id = ?', [fallback.id, fallback.name, id]);
      d.run('DELETE FROM projects WHERE id = ?', [id]);
    });

    return { removed: cur, movedTo: fallback.name };
  }

  /**
   * 一次性提交整串项目顺序（拖拽完一次性写，不做逐条 PATCH）。
   * - ids 里混进「默认」：静默忽略，它永远在 0 位，不报错（前端拖拽逻辑不用特判）
   * - 出现库里没有的 id：抛错，免得把顺序写成半截
   * - ids 没覆盖全部项目：没提到的排到末尾，按原顺序 —— 否则它们会和传进来的
   *   抢同一个数字，sort_order 出现重复，下次 ORDER BY 就变成随机顺序
   */
  function reorderProjects(ids) {
    const d = conn();
    const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
    // 归档项目不在侧栏里，也不参与这次排序；它的 sort_order 原样留着，
    // 恢复时不会突然插到第一位。
    const known = new Map(d.all('SELECT id, name FROM projects WHERE archived_at IS NULL')
      .map((r) => [r.id, r.name]));

    const ordered = [];
    for (const id of list) {
      const name = known.get(id);
      if (name === undefined) throw new Error('项目不存在: ' + id);
      if (name === DEFAULT_PROJECT_NAME) continue;   // 固定第一位，跳过而不是报错
      if (ordered.includes(id)) continue;
      ordered.push(id);
    }

    const rest = d.all('SELECT id, name FROM projects WHERE archived_at IS NULL ORDER BY sort_order, created_at')
      .filter((r) => r.name !== DEFAULT_PROJECT_NAME && !ordered.includes(r.id))
      .map((r) => r.id);

    d.tx(() => {
      const now = nowIso();
      d.run('UPDATE projects SET sort_order = 0 WHERE name = ?', [DEFAULT_PROJECT_NAME]);
      [...ordered, ...rest].forEach((id, i) => {
        d.run('UPDATE projects SET sort_order = ?, updated_at = ? WHERE id = ?', [i + 1, now, id]);
      });
    });

    return listProjects();
  }

  // 按 id 或名字（含别名）找项目
  function findProject(key, opts = {}) {
    if (!key) return null;
    const d = conn();
    const k = String(key);
    const live = opts.include_archived ? '' : ' AND archived_at IS NULL';
    const byId = d.get('SELECT * FROM projects WHERE id = ?' + live, [k]);
    if (byId) return rowToProject(byId);
    const byName = d.get('SELECT * FROM projects WHERE name = ?' + live, [k]);
    if (byName) return rowToProject(byName);
    // 别名是 JSON 数组，用 json_each 展开匹配（SQLite 3.38+ / node:sqlite 自带）
    const byAlias = d.get(
      'SELECT p.* FROM projects p, json_each(p.aliases) WHERE json_each.value = ?'
      + (opts.include_archived ? '' : ' AND p.archived_at IS NULL') + ' LIMIT 1',
      [k]
    );
    return rowToProject(byAlias);
  }

  // 项目不存在就按名字补一个 —— 收任务时最常见的情况
  // 这里是内部兜底，不受 deleteProject 那条「「默认」不能删」的保护影响：
  // 收件筐被误删过之后，下一条没项目的任务还得能落回来。
  function ensureProject(name, projectId) {
    const d = conn();
    if (projectId) {
      const hit = d.get('SELECT * FROM projects WHERE id = ?', [projectId]);
      if (hit) {
        // 按 id 命中也要拦归档：PATCH 只给 project_id 时不能绕过「归档项目
        // 不再接新任务」这条规则。
        if (hit.archived_at) throw new Error('项目已归档，先恢复或换一个项目');
        return rowToProject(hit);
      }
    }
    const n = String(name || DEFAULT_PROJECT_NAME).trim() || DEFAULT_PROJECT_NAME;
    const byName = d.get('SELECT * FROM projects WHERE name = ?', [n]);
    if (byName) {
      if (byName.archived_at) throw new Error('项目已归档，先恢复或换一个项目');
      return rowToProject(byName);
    }

    const proj = {
      id: newProjectId(),
      name: n,
      aliases: [],
      dirs: [],
      sort_order: n === DEFAULT_PROJECT_NAME ? 0 : nextSortOrder(),
      created_at: nowIso(),
      updated_at: nowIso()
    };
    d.run(
      `INSERT INTO projects (id, name, aliases, dirs, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [proj.id, proj.name, '[]', '[]', proj.sort_order, proj.created_at, proj.updated_at]
    );
    return proj;
  }

  // ---------- 任务 ----------

  function makeTask(input = {}) {
    const title = String(input.title || '').trim();
    if (!title) throw new Error('title 不能为空');
    const now = nowIso();
    return {
      id: newId(),
      title,
      kind: normalizeKind(input.kind),
      payload: {
        text: input.text ?? null,
        images: Array.isArray(input.images) ? input.images : [],
        files: Array.isArray(input.files) ? input.files : [],
        urls: Array.isArray(input.urls) ? input.urls : [],
        path: input.path ?? null
      },
      project: String(input.project || DEFAULT_PROJECT_NAME),
      project_id: input.project_id || null,
      category: String(input.category || ''),
      status: STATUSES.includes(input.status) ? input.status : 'todo',
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'p3',
      note: input.note ?? '',
      source: String(input.source || 'chat'),
      brief: '',
      brief_at: null,
      classify_state: input.classify_state || 'off',
      classify_reason: '',
      classify_model: '',
      claimed_by: null,
      // 1 = 模型判不出项目、也没手选过，界面靠它显示「选项目」徽章
      needs_project: !!input.needs_project,
      // 默认 1：老任务早就在看板上了，本来就该算「已确认可以开工」。
      // 只有分类初判明确说不够开发时，入口才会传 false。
      dev_ready: input.dev_ready === undefined ? true : !!input.dev_ready,
      dev_gaps: normalizeGaps(input.dev_gaps),
      archived_at: null,
      merged_into: null,      // 合并时才写；这里是新卡的出生状态
      split_state: null,      // 预留列，本轮恒 null
      // ---- 表格视图的 6 个业务字段（v8）----
      // seq_no 不在这里定：它要读库里的 MAX(seq_no)，只有 add() 知道。
      seq_no: null,
      // 收任务时也允许直接带业务字段（CLI / 脚本导入用），归一化规则和
      // patch 走同一套 —— 否则「PATCH 写 -1 存 NULL、add 写 -1 存 -1」。
      owner: normalizeOwner(input.owner),
      estimate_hours: normalizeHours(input.estimate_hours),
      actual_hours: normalizeHours(input.actual_hours),
      plan_start_at: normalizeDate(input.plan_start_at, '计划开始'),
      plan_end_at: normalizeDate(input.plan_end_at, '计划结束'),
      created_at: now,
      updated_at: now,
      doing_at: null,
      done_at: null
    };
  }

  function add(input = {}) {
    const d = conn();
    const t = makeTask(input);
    const proj = ensureProject(t.project, t.project_id);
    t.project_id = proj.id;
    t.project = proj.name;

    // 短编号 = MAX(seq_no) + 1。
    // 不用 UNIQUE 约束换唯一性，理由见 storage.mjs MIGRATIONS[7]：
    // 给已存在的表加 UNIQUE 只能重建表，那一步没有幂等写法。这里是单进程
    // 单用户、写入口只有 add()，MAX+1 撞不上。
    const seq = Number(d.get('SELECT MAX(seq_no) AS m FROM tasks')?.m || 0);
    t.seq_no = Number.isFinite(seq) && seq > 0 ? seq + 1 : 1;

    d.run(
      `INSERT INTO tasks
         (id, title, kind, payload, project, project_id, category, status, priority, note, source,
          brief, brief_at, classify_state, classify_reason, classify_model, claimed_by, needs_project,
          dev_ready, dev_gaps, archived_at, seq_no, owner, estimate_hours, actual_hours,
          plan_start_at, plan_end_at, created_at, updated_at, doing_at, done_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        t.id, t.title, t.kind, JSON.stringify(t.payload), t.project, t.project_id,
        t.category, t.status, t.priority, t.note, t.source,
        t.brief, t.brief_at,
        t.classify_state, t.classify_reason, t.classify_model, t.claimed_by,
        t.needs_project ? 1 : 0,
        t.dev_ready ? 1 : 0, JSON.stringify(t.dev_gaps || []), t.archived_at,
        t.seq_no, t.owner, t.estimate_hours, t.actual_hours,
        t.plan_start_at, t.plan_end_at,
        t.created_at, t.updated_at, t.doing_at, t.done_at
      ]
    );

    return { ...t, no: seqLabel(t.seq_no), message_count: 0 };
  }

  function getTask(id) {
    if (!id) return null;
    const t = rowToTask(conn().get(TASK_SELECT + ' WHERE t.id = ?', [id]));
    // 单条也要带 has_merge / has_split / link_counts：抽屉的「关系」区
    // 和卡片上的徽章读的是同一份数据，分两套就一定会有一处忘了更新。
    return t ? decorateOne(t) : null;
  }

  function decorateOne(t) {
    applyLinkStat(t, linkStats(new Set([t.id])).get(t.id));
    return applyChildStat(t);
  }

  function requireTask(id) {
    const t = getTask(id);
    if (!t) throw new Error('任务不存在: ' + id);
    return t;
  }

  /**
   * 改状态。唯一的写入口 —— patch / move / 拆分都走这里，所以依赖拦截放这儿：
   * CLI 和 API 都绕不过去（只在前端拦是假的，curl 一条 /move 就进去了）。
   *
   * opts.skipBlock 是给内部用的逃生口：拆分会把原卡标成 done，那不是我「干完了」
   * 的声明，而是这条卡被拆散了 —— 它不该被自己那些前置堵住。
   */
  function applyStatus(t, status, opts = {}) {
    if (!STATUSES.includes(status)) throw new Error('非法状态: ' + status);
    if (t.status === status) return { changed: false };

    // 依赖拦截：前置没做完就不许进「进行中」或「已完成」。
    // 往回退（todo）永远放行 —— 退回不做不欠任何前置。
    if (!opts.skipBlock && (status === 'doing' || status === 'done')) {
      const b = blockedBy(t.id);
      if (b.blocked) {
        throw new Error('还有 ' + b.waiting.length + ' 条前置没做完：'
          + b.waiting.map((x) => '「' + x.title + '」').join('、'));
      }
    }

    const now = nowIso();
    const next = { status };
    if (status === 'doing' && !t.doing_at) next.doing_at = now;
    if (status === 'done') {
      next.done_at = now;
      if (!t.doing_at) next.doing_at = now;
    }
    if (status === 'todo') { next.doing_at = null; next.done_at = null; }
    return { changed: true, fields: next };
  }

  /**
   * 从 taskId 往上爬祖先链，逐级重算「有子项的卡」的状态（文档 1.3 第 3 条）。
   *
   * 规则：全 done → done；任一 doing → doing；否则 todo。
   * 起点是 taskId **自己**：新挂上去的父卡需要立刻派生一次（那时它是从
   * 「没子项」变成「有子项」，只有它自己需要重算）；之后逐级往上。
   *
   * 为什么是循环不是递归：祖先最多 5 层（MAX_DEPTH），循环足够，而且没有
   * 栈深度的心理负担 —— 写「不能递归就停」的时候，循环是最直白的答案。
   *
   * 两个刻意的选择，都写在下面：
   *
   * 1. **直接 UPDATE，不走 applyStatus。**
   *    applyStatus 会做 depends_on 拦截（派生必须 skipBlock）和写
   *    doing_at/done_at；把它拉进来一起用，就得加一个 skipBlock 参数、
   *    再解释一遍「这次为什么可以跳」，语义会搅在一起。
   *    但 done_at 不能省 —— archiveStale() 只认 `done_at IS NOT NULL` 的行，
   *    派生 done 却不写 done_at，这张父卡就永远不进归档，会一直占着已完成列。
   *    所以这里照 applyStatus 的写法补三个时间戳（done 写 done_at、
   *    doing 补 doing_at、todo 清两个），和手改的落库形状保持一致。
   *
   * 2. **归档的祖先不动。** 它已经出了流水线（看板上不占位），再去改它的
   *    status 只会让归档视图里的记录和当时的事实打架；而且「取消子项 done」
   *    把一张归档卡拽回看板更吓人。所以跳过、继续往上。
   *
   * 事务由调用方保证（patch / linkTasks / unlinkTasks 都包在 d.tx 里）。
   *
   * @returns {Array<{id, from, to}>} 这次真的变了的卡（测试和调试用）
   */
  function recomputeStatus(taskId) {
    const d = conn();
    const adj = parentMap();
    const idx = childIndex();
    const now = nowIso();
    const updated = [];
    const seen = new Set();
    let cur = String(taskId || '');

    for (let hop = 0; hop <= MAX_DEPTH + 2 && cur; hop++) {
      if (seen.has(cur)) break;              // 脏数据成环时兜底，别死循环
      seen.add(cur);

      const kids = idx.get(cur) || [];
      const want = deriveStatus(kids);
      if (want) {
        const row = d.get('SELECT id, status, doing_at, done_at, archived_at FROM tasks WHERE id = ?', [cur]);
        if (row && !row.archived_at && row.status !== want) {
          const sets = ['status = ?', 'updated_at = ?'];
          const args = [want, now];
          if (want === 'done') {
            sets.push('done_at = ?'); args.push(now);
            if (!row.doing_at) { sets.push('doing_at = ?'); args.push(now); }
          } else if (want === 'doing') {
            if (!row.doing_at) { sets.push('doing_at = ?'); args.push(now); }
          } else {
            sets.push('doing_at = NULL', 'done_at = NULL');
          }
          d.run('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?', [...args, cur]);
          updated.push({ id: cur, from: row.status, to: want });
          // 快照要跟着改：idx 是进函数时拍的一张表，再往上爬的时候
          // 上一级读的还是这张表。不同步的话「叶子 done → 中间 done」成立，
          // 但「→ 祖父 done」永远是 todo（实测过，就是这里）。
          for (const list of idx.values()) {
            for (const c of list) if (c.id === cur) c.status = want;
          }
        }
      }
      cur = adj.get(cur);                    // 往上一级
    }
    return updated;
  }

  const PATCHABLE = [
    'title', 'kind', 'project', 'project_id', 'category', 'priority', 'note', 'claimed_by',
    'classify_state', 'classify_reason', 'classify_model'
    // v8 那五个（owner / estimate_hours / actual_hours / plan_start_at /
    // plan_end_at）**不在这条循环里** —— 它们要归一化，见下面那段。
    // seq_no 也**不在**：它是身份，改它等于把「这是第 7 条需求」改成别人。
  ];

  /**
   * opts.skipParentStatus：内部用的逃生口，允许直接改「有子项的卡」的状态。
   * 现在只有测试和将来可能的「强制对齐」会用到 —— 正常路径是让子项决定。
   */
  function patch(id, fields = {}, opts = {}) {
    const d = conn();
    const t = requireTask(id);
    const sets = [];
    const args = [];
    let nextProject = t.project;
    let nextProjectId = t.project_id;

    // 被合并的卡是历史记录，只读。
    // 唯一的例外是 merged_into 本身 —— 撤销合并（revertMerge）要靠它把卡放回来，
    // 而那时库里这张卡还带着 merged_into。
    if (t.merged_into) {
      // link_warn 也放行：它只是「前置断了，看一眼」的便签，不是卡片内容，
      // 清掉它不会改动任何历史事实。
      const others = Object.keys(fields)
        .filter((k) => fields[k] !== undefined && k !== 'merged_into' && k !== 'link_warn');
      if (others.length) {
        const into = getTask(t.merged_into);
        throw new Error('这条已被合并进「' + (into?.title || t.merged_into) + '」，是历史记录，不能改');
      }
    }

    for (const k of PATCHABLE) {
      if (fields[k] === undefined) continue;
      sets.push(k + ' = ?');
      args.push(fields[k]);
      if (k === 'project') nextProject = fields[k];
      if (k === 'project_id') nextProjectId = fields[k];
    }

    // 只给了 project 名字时，必须把旧的 project_id 丢掉。
    // 否则下面 ensureProject(name, 旧 id) 会按 id 命中**原来那个项目**，
    // 把刚写进去的新名字原样改回去 —— 表现就是「改项目没反应」：
    // 请求 200、值却没变。前端下拉只发名字（它不知道新项目 id），
    // 所以这条必须在这里兜住，不能指望调用方把两个字段一起发。
    if (fields.project !== undefined && fields.project_id === undefined) {
      nextProjectId = null;
    }

    // ---- v8：表格行内编辑的四个字段 ----
    // 不走 PATCHABLE 那条循环，因为它们进来的是用户在一个 <input> 里敲的字，
    // 必须归一化后才能落库（'' / 'abc' / -1 一律存 NULL；日期不合法就抛错）。
    //
    // `null` 是「清空这一格」的合法请求，`undefined` 才是「这次没改它」——
    // 两者的区别在这里很关键：模糊掉的话，点一下格子再失焦就会把已有值清掉。
    if (fields.estimate_hours !== undefined) {
      sets.push('estimate_hours = ?');
      args.push(normalizeHours(fields.estimate_hours));
    }
    if (fields.actual_hours !== undefined) {
      sets.push('actual_hours = ?');
      args.push(normalizeHours(fields.actual_hours));
    }
    // 负责人同理：表格里清空那一格 = 「这人不管了」，存 NULL 而不是空串。
    if (fields.owner !== undefined) {
      sets.push('owner = ?');
      args.push(normalizeOwner(fields.owner));
    }
    if (fields.plan_start_at !== undefined) {
      sets.push('plan_start_at = ?');
      args.push(normalizeDate(fields.plan_start_at, '计划开始'));
    }
    if (fields.plan_end_at !== undefined) {
      sets.push('plan_end_at = ?');
      args.push(normalizeDate(fields.plan_end_at, '计划结束'));
    }

    // 布尔列单独处理：库里存 0/1，外面看到的是 true/false
    if (fields.needs_project !== undefined) {
      sets.push('needs_project = ?');
      args.push(fields.needs_project ? 1 : 0);
    }
    // dev_ready 0/1 同理。归档走 archived_at 时间戳，不设单独的布尔列。
    if (fields.dev_ready !== undefined) {
      sets.push('dev_ready = ?');
      args.push(fields.dev_ready ? 1 : 0);
    }
    // dev_gaps 跟着 dev_ready 走：说「不够开发」就得同时说清楚缺什么。
    // 反过来单独改 gaps 也允许 —— 用户手写「还缺这些」是有意义的。
    if (fields.dev_gaps !== undefined) {
      sets.push('dev_gaps = ?');
      args.push(JSON.stringify(normalizeGaps(fields.dev_gaps)));
    }
    // 确认可以开工之后，那次初判留下的「缺什么」就过期了 —— 留着会让
    // 表面上已经能做的任务还挂着一串疑问。只在调用方没显式给 gaps 时清。
    if (fields.dev_ready && fields.dev_gaps === undefined) {
      sets.push('dev_gaps = ?');
      args.push('[]');
    }
    if (fields.archived_at !== undefined) {
      sets.push('archived_at = ?');
      args.push(fields.archived_at === null ? null : String(fields.archived_at));
    }
    // merged_into 只能是 null 或一个真实存在的任务 id。
    // 它同时是「只读闸门」的开关，所以这里也要校验 —— 前端不该能写任意值进来。
    if (fields.merged_into !== undefined) {
      const target = fields.merged_into === null ? null : String(fields.merged_into);
      if (target !== null) {
        if (target === id) throw new Error('不能合并到自己身上');
        if (!getTask(target)) throw new Error('要合并进的卡片不存在: ' + target);
      }
      sets.push('merged_into = ?');
      args.push(target);
    }

    // 前置断开提示：用户看过就清空（前端「知道了」按钮）。
    // 它不是正文，只是一句便签 —— 截到 500 字，别让它变成一个能塞长文章的字段。
    if (fields.link_warn !== undefined) {
      sets.push('link_warn = ?');
      args.push(String(fields.link_warn ?? '').slice(0, 500));
    }

    if (fields.payload && typeof fields.payload === 'object') {
      const merged = { ...t.payload, ...fields.payload };
      sets.push('payload = ?');
      args.push(JSON.stringify(merged));
    }

    // 有子项的卡：status 是派生的，只读（文档 1.3 第 3 条）。
    // 拦在这里而不是前端：curl 一条 PATCH 就绕过界面，库里立刻出现
    // 「父卡 done、下面三个 doing」—— 那比不做这个功能更糟。
    // 逃生口 skipParentStatus 只给内部/测试用。
    let statusChanged = false;
    if (fields.status !== undefined) {
      if (t.has_children && !opts.skipParentStatus) {
        throw new Error('这张卡有 ' + t.child_count + ' 个子项，状态由子项决定');
      }
      const r = applyStatus(t, fields.status, opts);
      if (r.changed) {
        statusChanged = true;
        for (const [k, v] of Object.entries(r.fields)) {
          sets.push(k + ' = ?');
          args.push(v);
        }
      }
    }

    // 项目被改名/新建时，保持 tasks.project 这个冗余字段同步
    if (nextProject !== t.project || nextProjectId !== t.project_id) {
      const proj = ensureProject(nextProject, nextProjectId);
      if (proj) {
        sets.push('project = ?');
        args.push(proj.name);
        sets.push('project_id = ?');
        args.push(proj.id);
      }
    }

    sets.push('updated_at = ?');
    args.push(nowIso());
    args.push(id);

    // 写 + 向上传播放同一个事务：中间失败会留下「子项变了两级祖先没变」，
    // 那正是这个功能要防的那种不一致。
    //
    // 防抖（比如 200ms 内合并多次传播）刻意不做：单机自用，一次 patch
    // 只传播一次，最多 5 层、每层一条 UPDATE，成本比定时器的故障面小得多。
    d.tx(() => {
      d.run('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?', args);
      if (statusChanged) {
        // 从父卡开始爬，不从自己：起点这一层会「用子项算自己」，而自己刚被
        // 人手改过 —— 尤其是 skipParentStatus 那条路，从自己开始等于刚写就被
        // 算回去。子项状态变了，该重算的本来就是它的祖先。
        const up = parentMap().get(id);
        if (up) recomputeStatus(up);
      }
    });
    return getTask(id);
  }

  function move(id, status) { return patch(id, { status }); }

  // ---------- 卡片关系（links） ----------
  //
  // 一张表装四种边，用 kind 区分。语义差别不在数据结构上，在约束上：
  //   merge_parent  新卡 → 旧卡（合并产出，历史事实，不可改，可撤销）
  //   split_of      原卡 → 子卡（拆分产出，历史事实，不可改）
  //   parent        层级（第 3 步；本轮只允许建边删边）
  //   depends_on    依赖（第 2 步；本轮只允许建边删边）
  //
  // 为什么合并要新建一张卡而不是「把 B 塞进 A」：A 的身份会变成
  // 「既是原来的 A，又是合并后的 A」—— 三个月后看到 A 的 created_at 是
  // 第一次记下的时间，内容却是后来并的。新建 C 最干净：C 的出生时间就是
  // 这次合并的时间，A、B 原样留作历史。

  function rowToLink(r) {
    if (!r) return null;
    return {
      id: r.id,
      kind: r.kind,
      from_id: r.from_id,
      to_id: r.to_id,
      note: r.note || '',
      created_at: r.created_at
    };
  }

  // 一条边两端各带一份任务摘要。只用摘要而不是整条任务：
  // 浮层里要显示的就是「标题 + 状态」，整条任务（含 payload / brief）
  // 在 links 视图里是噪音，而且会让返回体翻几倍。
  const LINK_TASK_FIELDS = 'id, title, status, project, priority, category, archived_at, merged_into';

  function taskBrief(id) {
    const r = conn().get('SELECT ' + LINK_TASK_FIELDS + ' FROM tasks WHERE id = ?', [id]);
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      project: r.project,
      priority: r.priority,
      category: r.category,
      archived_at: r.archived_at ?? null,
      merged_into: r.merged_into ?? null
    };
  }

  /** 一批边里，某个 kind 的 from → [to...] 邻接表。爬链用，只查一次。 */
  function edgeMap(kind) {
    const map = new Map();
    for (const r of conn().all(
      'SELECT from_id, to_id FROM links WHERE kind = ? ORDER BY created_at, rowid', [kind]
    )) {
      if (!map.has(r.from_id)) map.set(r.from_id, []);
      map.get(r.from_id).push(r.to_id);
    }
    return map;
  }

  /**
   * 从 start 沿某个 kind 的边往上爬，能不能爬到 target。爬到了 = 加这条边会成环。
   *
   * 两种 kind 共用这一个算法，因为**检环的形状是一样的**：
   * 「from → to 这条边要成立，先得确认从 to 顺着同一个方向走不到 from」。
   * merge_parent（新卡 → 旧卡）和 depends_on（等的人 → 被等的人）方向语义相反，
   * 但拓扑上都是「有向图里加一条边之前，检查 to 的可达集合里有没有 from」。
   * 层级（parent）将来也一样。
   *
   * 边界只看同一个 kind：合并链和依赖链是两张完全独立的图，
   * 混着爬会把「A 依赖 B、B 合并自 C」误判成环。
   *
   * 用访问集合兜底 —— 就算库里已经存着一个环（老数据/手改），也不会死循环。
   */
  function reachable(kind, start, target) {
    const adj = edgeMap(kind);
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) || []) stack.push(next);
    }
    return false;
  }

  /** 会成环的 kind 和它们各自的报错话术。 */
  const ACYCLIC = {
    merge_parent: (from, to) => '合并关系会成环：' + from + ' 已经在 ' + to + ' 的合并链上',
    depends_on: (from, to) => '依赖关系会成环：「' + (getTask(to)?.title || to)
      + '」已经（间接）在等「' + (getTask(from)?.title || from) + '」了，两条会永远卡住',
    // 层级成环 = 一张卡成了自己的祖先。往上爬重算状态时会立刻死循环，
    // 而且「谁是父卡」在环里没有答案 —— 必须在加边时就拒。
    parent: (from, to) => '层级会成环：「' + (getTask(to)?.title || to)
      + '」已经在「' + (getTask(from)?.title || from) + '」下面了，不能反过来再挂一次'
  };

  /**
   * 把 tasks.parent_id 这一列和 parent 边对齐（单值）。
   *
   * parent_id 是冗余列（见 storage.mjs MIGRATIONS[6]），真值始终是 links 里
   * 那条件。所以每次增删 parent 边之后都调这里重算一次，而不是自己 +/- 1 ——
   * 增量维护是最容易两边走歪的写法。
   */
  function syncParentId(taskId) {
    const d = conn();
    const id = String(taskId || '');
    if (!id) return null;
    const r = d.get(
      "SELECT to_id FROM links WHERE kind = 'parent' AND from_id = ? ORDER BY created_at, rowid LIMIT 1",
      [id]
    );
    const next = r ? r.to_id : null;
    d.run('UPDATE tasks SET parent_id = ? WHERE id = ?', [next, id]);
    return next;
  }

  /**
   * 建一条边。
   * - kind 必须是四种之一
   * - 两端都得真实存在
   * - 不能自己连自己
   * - 重复不报错（返回已有的那条）—— 合并/拆分是幂等的，
   *   重试一次请求不该变成一个错误
   * - merge_parent / depends_on / parent 查环：合并成环会让【合】徽章无限套娃，
   *   依赖成环会让两条卡永远等不到对方，层级成环会让「谁是父卡」没有答案
   * - parent 还要查深度（≤ MAX_DEPTH 层），且一张卡只能有一个父卡
   *   （再挂一次 = 换父卡：旧边先解掉，两边的状态都重算）
   */
  function linkTasks(fromId, toId, kind, note, opts = {}) {
    const d = conn();
    if (!LINK_KINDS.includes(kind)) throw new Error('未知关系类型: ' + kind);
    const from = String(fromId || '');
    const to = String(toId || '');
    if (!from || !to) throw new Error('两端都要给');
    if (from === to) throw new Error('不能自己连自己');
    if (!getTask(from)) throw new Error('任务不存在: ' + from);
    if (!getTask(to)) throw new Error('任务不存在: ' + to);

    const exist = d.get('SELECT * FROM links WHERE kind = ? AND from_id = ? AND to_id = ?', [kind, from, to]);
    if (exist) return rowToLink(exist);

    if (ACYCLIC[kind] && reachable(kind, to, from)) {
      throw new Error(ACYCLIC[kind](from, to));
    }

    // 层级的两条额外约束（文档 1.3 的第 1、2 条；第 1 条已经在上面走 ACYCLIC）
    let oldParent = null;
    if (kind === 'parent') {
      // 深度：一张卡只有一个父卡，所以「挂上去之后最深能到几层」是可算的。
      //   to 的深度      = 它的祖先数 + 1
      //   from 的深度    = to 的深度 + 1（新加的这条边）
      //   整条链最深     = from 的深度 + from 自己的子树高
      // 超过 MAX_DEPTH 就拒 —— 这一步能在「加边」时拦住，就不用等渲染时才发现
      // 有一棵 9 层的树。
      const depth = ancestorDepth(to) + 2 + subtreeHeight(from);
      if (depth > MAX_DEPTH) {
        throw new Error('层级最多 ' + MAX_DEPTH + ' 层，这条挂上去就是 ' + depth
          + ' 层 —— 超过 ' + MAX_DEPTH + ' 层就该拆项目，不是加深层级');
      }
      // 一张卡只能有一个父卡：已经有别的父卡就是「换父卡」。
      // 旧的边在这里解掉（拖进拖出就是这么实现的），并记住它是谁 ——
      // 它少了一个子项，状态得跟着重算。
      const cur = d.get(
        "SELECT id, to_id FROM links WHERE kind = 'parent' AND from_id = ? ORDER BY created_at, rowid LIMIT 1",
        [from]
      );
      if (cur && cur.to_id !== to) {
        d.run('DELETE FROM links WHERE id = ?', [cur.id]);
        oldParent = cur.to_id;
      }
    }

    const row = {
      id: shortId('l_'),
      kind,
      from_id: from,
      to_id: to,
      note: String(note || '').slice(0, 500),
      created_at: nowIso()
    };
    // 边 + parent_id + 派生状态是同一件事，必须一起成功或一起失败
    d.tx(() => {
      d.run(
        'INSERT INTO links (id, kind, from_id, to_id, note, created_at) VALUES (?,?,?,?,?,?)',
        [row.id, row.kind, row.from_id, row.to_id, row.note, row.created_at]
      );
      // 关系变了也是「这张卡变了」：列表里的 has_merge / has_split 要跟着刷。
      // 批量建边（合并/拆分）时调用方传 touch:false —— 外层一次事务里已经统一刷过了。
      if (opts.touch !== false) {
        const now = nowIso();
        d.run('UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)', [now, from, to]);
      }
      if (kind === 'parent') {
        syncParentId(from);
        // 从 to 开始往上是正确的：to 第一次有子项时自己要先派生一次，
        // 之后逐级把它的祖先一起重算（祖先可能 5 层）
        recomputeStatus(to);
        if (oldParent) recomputeStatus(oldParent);
      }
    });
    return row;
  }

  function unlinkTasks(fromId, toId, kind) {
    const d = conn();
    if (!LINK_KINDS.includes(kind)) throw new Error('未知关系类型: ' + kind);
    const from = String(fromId || '');
    const to = String(toId || '');
    let removed = 0;
    d.tx(() => {
      const r = d.run('DELETE FROM links WHERE kind = ? AND from_id = ? AND to_id = ?', [kind, from, to]);
      removed = Number(r.changes || 0);
      if (removed && kind === 'parent') {
        syncParentId(from);
        // 少了一个子项：父卡和它上面的链状态都得重算（可能从 done 退回 doing/todo）
        recomputeStatus(to);
      }
    });
    return { removed };
  }

  function deleteLink(id) {
    const d = conn();
    const row = d.get('SELECT * FROM links WHERE id = ?', [String(id || '')]);
    if (!row) throw new Error('关系不存在: ' + id);
    let removed = 0;
    d.tx(() => {
      removed = Number(d.run('DELETE FROM links WHERE id = ?', [row.id]).changes || 0);
      if (removed && row.kind === 'parent') {
        syncParentId(row.from_id);
        recomputeStatus(row.to_id);
      }
    });
    return { removed };
  }

  /**
   * 这张卡身上的所有关系。
   *   asFrom —— 我指向谁（我合并了谁 / 我拆出了谁）
   *   asTo   —— 谁指向我（我被谁合并 / 我从哪拆出来）
   * 每条都带两端任务的摘要，前端不用再逐条查任务。
   */
  function listLinks(taskId) {
    const d = conn();
    const id = String(taskId || '');
    if (!id) throw new Error('缺 taskId');
    const rows = d.all(
      'SELECT * FROM links WHERE from_id = ? OR to_id = ? ORDER BY created_at, rowid',
      [id, id]
    );
    const cache = new Map();
    const brief = (tid) => {
      if (!cache.has(tid)) cache.set(tid, taskBrief(tid));
      return cache.get(tid);
    };
    const asFrom = [];
    const asTo = [];
    for (const r of rows) {
      const one = {
        ...rowToLink(r),
        from: brief(r.from_id),
        to: brief(r.to_id)
      };
      // 两栏是「我指向别人 / 别人指向我」——一条边只会进其中一栏，
      // 不会两边都算（否则同一个关系会出现两次）
      if (r.from_id === id) asFrom.push(one);
      else asTo.push(one);
    }
    return { asFrom, asTo };
  }

  function linksOf(taskId, kind) {
    return conn().all(
      'SELECT * FROM links WHERE from_id = ? AND kind = ? ORDER BY created_at, rowid',
      [String(taskId || ''), kind]
    ).map(rowToLink);
  }

  /**
   * 这张卡还在等谁 —— depends_on 出边里「真的还没做完」的那些前置。
   *
   * 方向按文档第 1.4 节：**from_id 是等的人，to_id 是被等的（前置）**。
   * 「算不算还欠着」的判定只有一份，在 prereqBlocks() 里 ——
   * blockedBy、卡片上的 blocked 徽章、blocking_count 三处都读它，
   * 分开写必然出现「徽章说等 1 条、拖拽却放行」这种自相矛盾。
   *
   * @returns {{blocked:boolean, waiting:Array<{id,title,status,project}>}}
   */
  function blockedBy(taskId) {
    const id = String(taskId || '');
    if (!getTask(id)) throw new Error('任务不存在: ' + id);
    const waiting = [];
    for (const r of conn().all(
      `SELECT l.to_id AS id, t.title, t.status, t.project,
              t.archived_at, t.merged_into
         FROM links l JOIN tasks t ON t.id = l.to_id
        WHERE l.kind = 'depends_on' AND l.from_id = ?
        ORDER BY l.created_at, l.rowid`, [id]
    )) {
      if (!prereqBlocks(r)) continue;
      waiting.push({ id: r.id, title: r.title, status: r.status, project: r.project });
    }
    return { blocked: waiting.length > 0, waiting };
  }

  /**
   * 前置没了，在下游卡上留一行提示。
   *
   * 边本身由 ON DELETE CASCADE 清（删除）/ 原样保留（合并），但「我这里曾经
   * 有一条约束」这件事不该静默消失 —— 人得知道要重新确认一次。
   * 已经写过提示的不覆盖，追加一行（上限一行字，多了就顶掉最老的）。
   */
  function warnDependents(taskId, title, reason) {
    const d = conn();
    const line = '原来的前置「' + title + '」被' + reason + '了，重新确认依赖';
    const rows = d.all("SELECT from_id FROM links WHERE kind = 'depends_on' AND to_id = ?", [taskId]);
    const now = nowIso();
    for (const r of rows) {
      const cur = String(d.get('SELECT link_warn FROM tasks WHERE id = ?', [r.from_id])?.link_warn || '').trim();
      const next = (cur ? cur + '\n' + line : line).slice(-500);
      d.run('UPDATE tasks SET link_warn = ?, updated_at = ? WHERE id = ?', [next, now, r.from_id]);
    }
    return rows.length;
  }

  /**
   * 合并：把 N 张旧卡并成一张新卡。
   *
   * 严格按 docs/relations-and-table.md 第 1.1 条：
   * - **新建一张卡**，不把内容塞进某张旧卡（否则那张卡的 created_at 会撒谎）
   * - 每张旧卡 merged_into = 新卡 id，status 保持不变，**不删、不归档**
   * - 建 N 条 merge_parent：from = 新卡，to = 旧卡
   * - 旧卡的对话和附件**不搬走**，留在原来那张卡上 —— 搬走就等于删了
   * - 全部在一个事务里
   *
   * @param {string[]} targetIds 要被合并掉的旧卡（至少 2 张，去重后）
   * @param {{title?:string,text?:string,project?:string,category?:string,priority?:string}} opts
   * @returns 新卡
   */
  function mergeTasks(targetIds, opts = {}) {
    const d = conn();
    // 去重 + 去空：同一张卡传两遍是前端拼参数的常见手滑，不该算两次
    const ids = [...new Set((Array.isArray(targetIds) ? targetIds : [])
      .map((x) => String(x || '').trim()).filter(Boolean))];
    if (ids.length < 2) throw new Error('合并至少要 2 张卡（现在 ' + ids.length + ' 张）');

    const olds = ids.map((id) => requireTask(id));
    for (const t of olds) {
      if (t.merged_into) {
        throw new Error('「' + t.title + '」已经被合并过了，不能重复合并');
      }
    }

    // 默认标题：把旧卡标题并起来，长的优先露出来。
    // 这是给人一个能改的起点，不是「智能摘要」—— 摘要该由模型给（第 5 节：
    // 「模型给建议 + 用户确认」），这里只保证不留一张没名字的卡。
    const fallbackTitle = olds.map((t) => t.title).join(' / ').slice(0, 200);
    const title = String(opts.title || '').trim() || fallbackTitle;
    // 正文默认把每张旧卡的原文并起来，前面标上它的出处 ——
    // 「原始记录」是唯一的事实来源，合并时不能只剩标题
    const fallbackText = olds.map((t) => {
      const body = String(t.payload?.text || '').trim();
      return body ? '【' + t.title + '】\n' + body : '【' + t.title + '】';
    }).join('\n\n');
    const text = opts.text === undefined ? fallbackText : opts.text;

    // 合并后的卡先落哪个项目：opts 优先，其次第一张旧卡的（它们通常同项目）
    const head = olds[0];

    return d.tx(() => {
      const created = add({
        title,
        text,
        project: opts.project ?? head.project,
        project_id: opts.project ? null : head.project_id,
        category: opts.category ?? head.category,
        priority: PRIORITIES.includes(opts.priority) ? opts.priority : head.priority,
        kind: head.kind,
        source: 'merge',
        // 合并出来的卡是「人做的决定」，不是模型初判 —— 直接可开工
        dev_ready: true
      });

      const now = nowIso();
      const parents = new Set();
      for (const t of olds) {
        // 这张旧卡如果正被别人当前置：边留着（卡没删，历史该看得见），
        // 但下游要留一行提示 —— 它已经"变成别人"了，依赖关系得人重新确认。
        // 阻塞判定那边会把 merged_into 非空的前置当作已完成（见 prereqBlocks），
        // 所以合并不会把下游永久卡死，只是要人来看一眼。
        warnDependents(t.id, t.title, '合并');
        d.run('UPDATE tasks SET merged_into = ?, updated_at = ? WHERE id = ?', [created.id, now, t.id]);
        linkTasks(created.id, t.id, 'merge_parent', '', { touch: false });
        // 被合并的子项「视为已完成」（childDone），所以它原来挂着的父卡
        // 可能因此变成 done —— 合并也是进度变化，得往上重算。
        if (t.parent_id) parents.add(t.parent_id);
      }
      for (const p of parents) recomputeStatus(p);
      d.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, created.id]);
      return getTask(created.id);
    });
  }

  /**
   * 撤销合并。
   *
   * 按文档第 1.1 条第 3 点：撤销 = 删掉新卡的 merge_parent 边 + 让旧卡回来。
   * 新卡本身**归档**（archived_at = now）而不是删除 —— 撤销的语义是
   * 「回到合并前」，那张新卡是合并的产物，留档但不占看板。
   * 直接删会把人手写进合并卡的标题/正文一起删掉，那是真丢东西。
   */
  function revertMerge(newId) {
    const d = conn();
    const id = String(newId || '');
    const t = requireTask(id);
    const edges = linksOf(id, 'merge_parent');
    if (!edges.length) throw new Error('这张卡没有合并记录，无法撤销');

    return d.tx(() => {
      const now = nowIso();
      const restored = [];
      const parents = new Set();
      for (const e of edges) {
        d.run("DELETE FROM links WHERE id = ?", [e.id]);
        // 只清指向这张卡的引用：万一某张旧卡后来又被合并进别的卡，
        // 无条件清空会把它后来的关系一起擦掉
        d.run('UPDATE tasks SET merged_into = NULL, updated_at = ? WHERE id = ? AND merged_into = ?',
          [now, e.to_id, id]);
        const back = getTask(e.to_id);
        if (back) {
          restored.push(back.id);
          // 旧卡「不再是已完成」，它上面的父卡可能要从 done 退回来
          if (back.parent_id) parents.add(back.parent_id);
        }
      }
      d.run('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
        [now, now, id]);
      for (const p of parents) recomputeStatus(p);
      return { task: getTask(id), restored };
    });
  }

  /**
   * 拆分：一张卡拆成 N 张子卡。
   *
   * 方向按文档第 1.2 条：**原卡 → 子卡**（split_of）。
   * 原卡自己：内容一个字不动，状态改成 done + 备注追加一行「已拆分为 N 条」。
   * 这是已经拍过的决策 —— 不引入第四种 `split` 状态（多一个状态要改 7 处）。
   * 拆分这个动作确实结束了：一件含糊的事变成了四件清楚的事。
   *
   * `split_state` 列本轮只占位不写。
   *
   * @param {string} sourceId
   * @param {Array<{title:string,text?:string,priority?:string,category?:string,project?:string}>} parts
   * @returns {{source:object, children:object[]}}
   */
  function splitTask(sourceId, parts, opts = {}) {
    const d = conn();
    const source = requireTask(sourceId);
    if (source.merged_into) throw new Error('这条已被合并进别的卡，是历史记录，不能再拆');

    const list = (Array.isArray(parts) ? parts : [])
      .map((p) => (typeof p === 'string' ? { title: p } : p))
      .filter((p) => p && String(p.title || '').trim());
    if (!list.length) throw new Error('拆分至少要有 1 条（每行一条）');

    return d.tx(() => {
      const children = [];
      for (const p of list) {
        const child = add({
          title: String(p.title).trim(),
          text: p.text ?? null,
          kind: 'text',
          // 子卡默认跟原卡同一个项目/类别，除非这一条自己指定了 ——
          // 从一条卡拆出来的几条，绝大多数是同一个项目里的几件事
          project: p.project ?? source.project,
          project_id: p.project ? null : source.project_id,
          category: p.category ?? source.category,
          priority: PRIORITIES.includes(p.priority) ? p.priority : source.priority,
          source: 'split',
          dev_ready: true
        });
        children.push(child);
        linkTasks(source.id, child.id, 'split_of', '', { touch: false });
      }

      // 原卡：done + 备注。备注追加而不是覆盖 —— 用户原本写在备注里的东西不能丢
      const stamp = nowIso();
      const line = '已拆分为 ' + children.length + ' 条：' + children.map((c) => '「' + c.title + '」').join('、');
      const note = String(source.note || '').trim();
      d.run(
        'UPDATE tasks SET note = ?, updated_at = ? WHERE id = ?',
        [note ? note + '\n' + line : line, stamp, source.id]
      );
      // status 走 applyStatus 那条路，doing_at / done_at 才会按现有规则落。
      // skipBlock：「我被拆散了」不是「我干完了」，不该被自己的前置挡住 ——
      // 否则一条等前置的卡就永远拆不开了。
      const done = applyStatus(source, 'done', { skipBlock: true });
      if (done.changed) {
        const sets = Object.entries(done.fields).map(([k]) => k + ' = ?');
        d.run('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?',
          [...Object.values(done.fields), source.id]);
      }

      if (opts.note) {
        d.run('UPDATE tasks SET note = note || ? WHERE id = ?', ['\n' + String(opts.note), source.id]);
      }

      // 原卡被标成 done，它上面的父卡（如果有）状态要跟着重算 ——
      // 「一张卡拆着拆着就完成了」对父卡来说是实打实的进度变化。
      const up = parentMap().get(source.id);
      if (up) recomputeStatus(up);

      return { source: getTask(source.id), children: children.map((c) => getTask(c.id)) };
    });
  }

  // 从 payload 里那堆「可能是字符串、可能是对象」的条目里取出文件名
  function attachmentNames(list, dir) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      const raw = typeof item === 'string' ? item : (item?.path || item?.url || item?.name || '');
      if (!raw) continue;
      const base = path.basename(String(raw));
      // 只认这个目录里的文件，防止 payload 里塞了别的路径把人文件删了
      if (!base || base === '.' || base === '..') continue;
      if (fs.existsSync(path.join(dir, base))) out.push(base);
    }
    return out;
  }

  /**
   * 这张任务下面还没结束的 Turn。删除任务前必须为空 —— 否则外部 Agent
   * 还在 --auto 跑命令，而卡已经从界面上消失了，用户既看不到也停不了。
   */
  function openTurnsForTask(taskId) {
    return conn().all(
      `SELECT t.* FROM session_turns t
         JOIN agent_sessions s ON s.id = t.session_id
        WHERE s.task_id = ? AND t.status IN ('queued', 'running')`,
      [taskId]
    ).map(rowToTurn);
  }

  /**
   * 删除 dataDir/sessions/ 下的事件文件。只认这个目录下的相对路径：
   * 库字段不该变成能删任意文件的入口，手工改库塞 ../ 或绝对路径的直接跳过。
   */
  function removeEventFiles(files) {
    const sessionsDir = path.join(dataDir, 'sessions');
    let removed = 0;
    for (const rel of files) {
      const full = path.resolve(dataDir, rel);
      if (full !== sessionsDir && !full.startsWith(sessionsDir + path.sep)) {
        console.warn('[task-inbox] 事件文件路径不在 sessions/ 下，跳过 ' + rel);
        continue;
      }
      try {
        fs.unlinkSync(full);
        removed++;
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.warn('[task-inbox] 事件文件没删掉 ' + rel + '：' + e.message);
        }
      }
    }
    return removed;
  }

  function remove(id) {
    const d = conn();
    const t = requireTask(id);

    // 运行中的外部 Agent 不受 CASCADE 管。先拒绝删除，让用户停止后再删；
    // 强行删库只会留下一个还在改文件、但没有任何入口能停的进程。
    const open = openTurnsForTask(id);
    if (open.length) throw new Error('还有 Agent 正在执行，先停止再删除');

    // 先把要清的文件列出来，删库之后 payload 和 messages 就都没了。
    // 对话里的附件也算：只清 tasks.payload 的话，删任务会在 images/ 里留一堆垃圾
    // （就是 P0-3 那个坑，只是换了个入口）。
    const imgSet = new Set(attachmentNames(t.payload?.images, imagesDir));
    const fileSet = new Set(attachmentNames(t.payload?.files, filesDir));
    for (const m of listMessages(id)) {
      for (const n of attachmentNames(m.attachments?.images, imagesDir)) imgSet.add(n);
      for (const n of attachmentNames(m.attachments?.files, filesDir)) fileSet.add(n);
    }
    const imgs = [...imgSet];
    const fls = [...fileSet];

    // 会话事件文件也在这张任务下面。和附件一样，先记下来再删库 ——
    // 删完 tasks 之后 CASCADE 会把 agent_sessions / session_turns 一起清掉，
    // 那时就查不到 events_file 了。
    const turnFiles = d.all(
      `SELECT t.events_file FROM session_turns t
         JOIN agent_sessions s ON s.id = t.session_id
        WHERE s.task_id = ? AND t.events_file IS NOT NULL`,
      [id]
    ).map((r) => r.events_file).filter(Boolean);

    // messages / links 靠 ON DELETE CASCADE 一并清掉。
    // 但 merged_into 是个普通 TEXT 列（没有外键），删掉被合并的旧卡之后
    // 别处指向它的引用会悬空 —— 手工清一遍。
    //
    // 依赖边同样被 CASCADE 清掉，但「我原来在等这条卡」这件事不能跟着消失：
    // 删除之前先在下游卡上写一行 link_warn。顺序不能反 —— 边没了就找不到
    // 谁在等它了。
    //
    // 层级：parent 边被 CASCADE 清掉，但两端都得跟着反应过来 ——
    //   · 子卡的 parent_id 要清空（否则它带着一个指向空气的父卡 id，
    //     「有没有子项」和「我在谁下面」两处全算错）
    //   · 这张卡自己的父卡少了一个子项，状态要重算（可能从 done 退回）
    // 两件事都先记下来，删完再动 —— 删完就查不到这些关系了。
    const up = t.parent_id || null;

    d.tx(() => {
      warnDependents(id, t.title, '删除');
      d.run('UPDATE tasks SET merged_into = NULL WHERE merged_into = ?', [id]);
      // parent_id 是普通 TEXT 列（和外键无关），CASCADE 只清 links 表里那条边，
      // 子卡上冗余的 parent_id 得手工清 —— 不然后端「有没有父卡」和
      // 「有没有子项」两边立刻打架。
      d.run('UPDATE tasks SET parent_id = NULL, updated_at = ? WHERE parent_id = ?', [nowIso(), id]);
      d.run('DELETE FROM tasks WHERE id = ?', [id]);
      if (up) recomputeStatus(up);
    });

    // 库删成功才动文件。反过来的话，删文件成功、删库失败，就留下一条指向空文件的任务。
    // 文件删失败只记日志：库里已经没有引用了，留着孤儿文件比回滚更安全。
    const removed = [];
    for (const [dir, names] of [[imagesDir, imgs], [filesDir, fls]]) {
      for (const n of names) {
        try {
          fs.unlinkSync(path.join(dir, n));
          removed.push(n);
        } catch (e) {
          console.warn('[task-inbox] 附件没删掉 ' + n + '：' + e.message);
        }
      }
    }

    const removedTurnFiles = removeEventFiles(turnFiles);

    return { ...t, removedFiles: removed, removedTurnFiles };
  }

  // ---------- 聊天消息 ----------

  function listMessages(taskId, opts = {}) {
    const d = conn();
    const limit = Number(opts.limit || MAX_MESSAGES_PER_TASK);
    const rows = d.all(
      'SELECT * FROM messages WHERE task_id = ? ORDER BY at, rowid LIMIT ?',
      [taskId, limit]
    );
    return rows.map(rowToMessage);
  }

  // 只要最近 N 条 —— 给模型当上下文用，别把整条线程塞进去
  function recentMessages(taskId, n = 20) {
    const d = conn();
    const rows = d.all(
      'SELECT * FROM messages WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT ?',
      [taskId, Number(n)]
    );
    return rows.reverse().map(rowToMessage);
  }

  function pushMessage(id, msg) {
    const d = conn();
    requireTask(id);

    const m = {
      id: newMessageId(),
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      text: String(msg.text || '').slice(0, 4000),
      patch: msg.patch && typeof msg.patch === 'object' && Object.keys(msg.patch).length ? msg.patch : null,
      attachments: normalizeAttachments(msg.attachments),
      at: nowIso()
    };

    d.tx(() => {
      d.run(
        'INSERT INTO messages (id, task_id, role, text, patch, attachments, at) VALUES (?,?,?,?,?,?,?)',
        [m.id, id, m.role, m.text, m.patch ? JSON.stringify(m.patch) : null,
          m.attachments ? JSON.stringify(m.attachments) : null, m.at]
      );
      // 超出上限就丢掉最旧的几条，保持单卡片体积可控
      const count = Number(d.get('SELECT COUNT(*) AS c FROM messages WHERE task_id = ?', [id])?.c || 0);
      if (count > MAX_MESSAGES_PER_TASK) {
        d.run(
          `DELETE FROM messages WHERE id IN (
             SELECT id FROM messages WHERE task_id = ? ORDER BY at, rowid LIMIT ?
           )`,
          [id, count - MAX_MESSAGES_PER_TASK]
        );
      }
      d.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [m.at, id]);
    });

    return m;
  }

  function clearMessages(id) {
    const d = conn();
    requireTask(id);
    d.tx(() => {
      d.run('DELETE FROM messages WHERE task_id = ?', [id]);
      d.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [nowIso(), id]);
    });
    return getTask(id);
  }

  function setBrief(id, text) {
    const d = conn();
    requireTask(id);
    const brief = String(text || '').slice(0, 20000);
    const briefAt = brief ? nowIso() : null;
    d.run(
      'UPDATE tasks SET brief = ?, brief_at = ?, updated_at = ? WHERE id = ?',
      [brief, briefAt, nowIso(), id]
    );
    return getTask(id);
  }

  // ---------- Agent Session / Turn（阶段 1A） ----------
  //
  // 这一层只管数据：不 spawn 进程、不解析 CLI、不判断「这一轮算不算成功」。
  // 那些在 agent.mjs / opencode-agent.mjs。这样测试可以只验状态机，
  // 不用真的拉起一个 Agent。

  const SESSION_SELECT = `
    SELECT s.*,
           lt.id            AS last_turn_id,
           lt.status        AS last_turn_status,
           lt.user_text     AS last_turn_user_text,
           lt.result_text   AS last_turn_result_text,
           lt.error         AS last_turn_error,
           lt.started_at    AS last_turn_started_at,
           lt.ended_at      AS last_turn_ended_at,
           (SELECT COUNT(*) FROM session_turns t WHERE t.session_id = s.id) AS turn_count
      FROM agent_sessions s
      LEFT JOIN session_turns lt ON lt.id = (
        SELECT t.id FROM session_turns t
         WHERE t.session_id = s.id
         ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1
      )`;

  function requireSession(id) {
    const s = getSession(id);
    if (!s) throw new Error('会话不存在: ' + id);
    return s;
  }

  function requireTurn(id) {
    const t = getTurn(id);
    if (!t) throw new Error('Turn 不存在: ' + id);
    return t;
  }

  function getSession(id) {
    if (!id) return null;
    return rowToSession(conn().get(SESSION_SELECT + ' WHERE s.id = ?', [id]));
  }

  function listSessions(taskId) {
    if (!taskId) return [];
    return conn().all(
      SESSION_SELECT + ' WHERE s.task_id = ? ORDER BY s.created_at, s.rowid',
      [taskId]
    ).map(rowToSession);
  }

  /**
   * 建一个会话。外部 Session ID 先留空 —— 它要等第一次发消息时由 Adapter
   * 生成。这样「建会话」和「真的能跑」是两件事：CLI 没装好也能先把卡挂上，
   * 失败信息在第一次发送时给，而不是在建会话时假装成功。
   */
  function createSession(input = {}) {
    const d = conn();
    const taskId = String(input.taskId || '').trim();
    requireTask(taskId);

    const role = String(input.role || 'dev').trim();
    if (!AGENT_ROLES.includes(role)) throw new Error('非法角色: ' + role);
    const agent = String(input.agent || 'opencode').trim();
    if (!AGENT_TYPES.includes(agent)) throw new Error('非法 Agent: ' + agent);

    const workingDirectory = String(input.workingDirectory || '').trim();
    if (!workingDirectory) throw new Error('工作目录不能为空');
    // 必须是绝对路径：相对路径会相对「服务器进程当前目录」解析，换个地方
    // 启动服务，同一个 Session 就跑到另一个目录去了。
    if (!path.isAbsolute(workingDirectory)) {
      throw new Error('工作目录必须是绝对路径: ' + workingDirectory);
    }
    try {
      if (!fs.statSync(workingDirectory).isDirectory()) throw new Error('不是目录');
    } catch {
      throw new Error('工作目录不存在: ' + workingDirectory);
    }

    const now = nowIso();
    const s = {
      id: newSessionId(),
      task_id: taskId,
      role,
      agent,
      external_session_id: null,
      working_directory: workingDirectory,
      model: input.model ? String(input.model).trim() : null,
      status: 'idle',
      created_at: now,
      updated_at: now
    };
    d.run(
      `INSERT INTO agent_sessions
         (id, task_id, role, agent, external_session_id, working_directory, model, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [s.id, s.task_id, s.role, s.agent, s.external_session_id, s.working_directory,
        s.model, s.status, s.created_at, s.updated_at]
    );
    return getSession(s.id);
  }

  /**
   * 只允许改模型和工作目录。工作目录一旦跑过至少一轮就不能改 ——
   * 外部 Session 是按工作目录归属的，换了目录之后同一个 ID 可能根本打不开。
   */
  function updateSession(id, fields = {}) {
    const d = conn();
    const cur = requireSession(id);
    const sets = [];
    const args = [];

    if (fields.model !== undefined) {
      sets.push('model = ?');
      args.push(fields.model ? String(fields.model).trim() : null);
    }
    if (fields.working_directory !== undefined) {
      const dir = String(fields.working_directory || '').trim();
      if (!dir) throw new Error('工作目录不能为空');
      if (!path.isAbsolute(dir)) throw new Error('工作目录必须是绝对路径: ' + dir);
      try {
        if (!fs.statSync(dir).isDirectory()) throw new Error('不是目录');
      } catch {
        throw new Error('工作目录不存在: ' + dir);
      }
      const n = Number(d.get('SELECT COUNT(*) AS c FROM session_turns WHERE session_id = ?', [id])?.c || 0);
      if (n > 0 && dir !== cur.working_directory) {
        throw new Error('工作目录在首次发送后不能改');
      }
      if (dir !== cur.working_directory) {
        sets.push('working_directory = ?');
        args.push(dir);
      }
    }

    if (!sets.length) return cur;
    sets.push('updated_at = ?');
    args.push(nowIso(), id);
    d.run('UPDATE agent_sessions SET ' + sets.join(', ') + ' WHERE id = ?', args);
    return getSession(id);
  }

  /**
   * 绑定外部 Session ID。幂等：同一个 ID 重复写不报错，换一个 ID 拒绝。
   * 这条约束防的是「同一个角色实例悄悄换了一个会话」—— 那会让历史 Turn
   * 指向一个再也打不开的旧 ID。
   */
  function bindExternalSession(sessionId, externalSessionId) {
    const d = conn();
    const cur = requireSession(sessionId);
    const ext = String(externalSessionId || '').trim();
    if (!ext) throw new Error('外部 Session ID 不能为空');
    if (cur.external_session_id && cur.external_session_id !== ext) {
      throw new Error('这个会话已经绑定了外部 Session，不能更换');
    }
    if (!cur.external_session_id) {
      d.run('UPDATE agent_sessions SET external_session_id = ?, updated_at = ? WHERE id = ?',
        [ext, nowIso(), sessionId]);
    }
    return getSession(sessionId);
  }

  /**
   * 删一个会话。运行中的先拒绝；历史 Turn 和事件文件跟着清掉。
   * 删除后可以重新挂一个（同一角色/Agent 的旧会话已经没了，不会再被复用）。
   */
  function deleteSession(id) {
    const d = conn();
    const s = requireSession(id);
    if (openTurn(id)) throw new Error('这个会话还有一轮没执行完，先停止');
    const files = d.all(
      'SELECT events_file FROM session_turns WHERE session_id = ? AND events_file IS NOT NULL',
      [id]
    ).map((r) => r.events_file).filter(Boolean);
    d.run('DELETE FROM agent_sessions WHERE id = ?', [id]);   // turns 走 CASCADE
    return { removed: s, removedTurnFiles: removeEventFiles(files) };
  }

  function startTurn(sessionId, userText) {
    const d = conn();
    requireSession(sessionId);
    const text = String(userText || '').trim();
    if (!text) throw new Error('说点什么再发送');

    const now = nowIso();
    const id = newTurnId();
    try {
      d.run(
        `INSERT INTO session_turns
           (id, session_id, status, user_text, result_text, error, events_file, external_ref,
            exit_code, started_at, ended_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, sessionId, 'queued', text, '', '', null, null, null, null, null, now, now]
      );
    } catch (e) {
      // 部分唯一索引负责并发拦截。把数据库错误翻成人话，别让前端看到
      // "UNIQUE constraint failed: session_turns.session_id"。
      if (/UNIQUE|constraint/i.test(String(e.message || ''))) {
        throw new Error('这个会话还有一轮没结束');
      }
      throw e;
    }
    d.run('UPDATE agent_sessions SET updated_at = ? WHERE id = ?', [now, sessionId]);
    return getTurn(id);
  }

  function markTurnRunning(turnId, opts = {}) {
    const d = conn();
    const cur = requireTurn(turnId);
    if (cur.status !== 'queued' && cur.status !== 'running') {
      throw new Error('这一轮已经结束，不能再标记为运行中');
    }
    const now = nowIso();
    d.tx(() => {
      d.run(
        `UPDATE session_turns
            SET status = 'running', started_at = COALESCE(started_at, ?),
                external_ref = COALESCE(?, external_ref),
                events_file = COALESCE(?, events_file), updated_at = ?
          WHERE id = ?`,
        [now, opts.externalRef ?? null, opts.eventsFile ?? null, now, turnId]
      );
      d.run("UPDATE agent_sessions SET status = 'busy', updated_at = ? WHERE id = ?",
        [now, cur.session_id]);
    });
    return getTurn(turnId);
  }

  function finishTurn(turnId, result = {}) {
    const d = conn();
    const cur = requireTurn(turnId);
    const status = String(result.status || '');
    if (!['completed', 'failed', 'interrupted', 'unknown'].includes(status)) {
      throw new Error('非法 Turn 终态: ' + status);
    }

    // 事件文件保留完整流；这里只截展示用正文。200 KB 已经远大于一屏，
    // 再大只会拖慢 /api/sessions 的响应。
    let text = String(result.resultText || '');
    const MAX = 200 * 1024;
    if (text.length > MAX) {
      text = text.slice(0, MAX) + '\n[结果超过 200 KB，已截断；完整事件见 events_file]';
    }

    const now = nowIso();
    d.tx(() => {
      d.run(
        `UPDATE session_turns
            SET status = ?, result_text = ?, error = ?, exit_code = ?,
                ended_at = ?, updated_at = ?
          WHERE id = ?`,
        [status, text, String(result.error || '').slice(0, 4000),
          result.exitCode === undefined || result.exitCode === null ? null : Number(result.exitCode),
          now, now, turnId]
      );
      // 一轮结束后会话本身是可用的；只有「不知道这一轮到底跑完没有」才留 unknown。
      d.run('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?',
        [status === 'unknown' ? 'unknown' : 'idle', now, cur.session_id]);
    });
    return getTurn(turnId);
  }

  function getTurn(id) {
    if (!id) return null;
    return rowToTurn(conn().get('SELECT * FROM session_turns WHERE id = ?', [id]));
  }

  function listTurns(sessionId, limit = 20) {
    if (!sessionId) return [];
    const n = Math.max(1, Math.min(200, Number(limit) || 20));
    return conn().all(
      'SELECT * FROM session_turns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [sessionId, n]
    ).map(rowToTurn).reverse();
  }

  function openTurn(sessionId) {
    if (!sessionId) return null;
    return rowToTurn(conn().get(
      "SELECT * FROM session_turns WHERE session_id = ? AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
      [sessionId]
    ));
  }

  /**
   * 显式设置会话状态。只有 Adapter 的导出核对会用到它 —— 那个状态来自
   * 外部 CLI，不是从本地 Turn 推导出来的，refreshSessionStatus 算不出来。
   */
  function setSessionStatus(sessionId, status) {
    if (!SESSION_STATUSES.includes(status)) throw new Error('非法会话状态: ' + status);
    const d = conn();
    requireSession(sessionId);
    d.run('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?',
      [status, nowIso(), sessionId]);
    return getSession(sessionId);
  }

  function refreshSessionStatus(sessionId) {
    const d = conn();
    const cur = requireSession(sessionId);
    const open = openTurn(sessionId);
    const last = d.get(
      'SELECT status FROM session_turns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [sessionId]
    );
    let next = 'idle';
    if (open) next = 'busy';
    else if (last && last.status === 'unknown') next = 'unknown';
    else if (cur.status === 'unavailable' && !last) next = 'unavailable';
    if (next !== cur.status) {
      d.run('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?', [next, nowIso(), sessionId]);
      return getSession(sessionId);
    }
    return cur;
  }

  /**
   * 服务启动时把所有没结束的 Turn 收成 unknown。不能收成 failed ——
   * 进程退出不等于执行失败，可能 CLI 已经跑完了只是 Cabinet 没来得及写回。
   * 收成 completed 更不行，那是把「不知道」说成「成功」。
   */
  function recoverOpenTurns() {
    const d = conn();
    const rows = d.all("SELECT id, session_id FROM session_turns WHERE status IN ('queued','running')");
    if (!rows.length) return 0;
    const now = nowIso();
    d.tx(() => {
      for (const r of rows) {
        d.run(
          `UPDATE session_turns
              SET status = 'unknown', error = ?, ended_at = ?, updated_at = ?
            WHERE id = ?`,
          ['Cabinet 重启，执行状态待核对', now, now, r.id]
        );
        d.run("UPDATE agent_sessions SET status = 'unknown', updated_at = ? WHERE id = ?",
          [now, r.session_id]);
      }
    });
    return rows.length;
  }

  // ---------- 列表 / 看板 ----------

  // 查询参数是从 URL 上原样透传下来的，全是字符串：
  // "0" / "false" 是真值，不能直接 if()。这里统一按语义判断一次。
  function truthy(v) {
    if (v === true || v === 1) return true;
    if (typeof v === 'number') return v !== 0;
    const s = String(v ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  }

  // dev_ready 只认 0 / 1 / true / false，其它（空串、undefined、"abc"）当没传
  function devReadyFilter(v) {
    if (v === undefined || v === null || v === '') return null;
    if (v === true || v === 'true') return 1;
    if (v === false || v === 'false') return 0;
    const n = Number(v);
    return (n === 0 || n === 1) ? n : null;
  }

  function buildWhere(opts = {}) {
    const where = [];
    const args = [];
    // 归档是「done 之后」的阶段，默认不进任何视图；要看得显式要
    if (!truthy(opts.include_archived)) where.push('t.archived_at IS NULL');
    // 被合并的卡是历史记录：不删不归档，但也不占看板。
    // 默认过滤掉，`include_merged=1` 才看得到 —— 它是「点【合】徽章」那扇门后面的东西，
    // 和归档一样属于「要看就显式要」的那类。
    if (!truthy(opts.include_merged)) where.push('t.merged_into IS NULL');
    if (opts.project) {
      where.push('(t.project = ? OR t.project_id = ?)');
      args.push(opts.project, opts.project);
    }
    if (opts.status) { where.push('t.status = ?'); args.push(opts.status); }
    if (opts.category) { where.push('t.category = ?'); args.push(opts.category); }
    const dr = devReadyFilter(opts.dev_ready);
    if (dr !== null) { where.push('t.dev_ready = ?'); args.push(dr); }
    return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', args };
  }

  function list(opts = {}) {
    const d = conn();
    const w = buildWhere(opts);
    let sql = TASK_SELECT + w.sql + ` ORDER BY ${PRIORITY_ORDER_SQL}, t.created_at DESC`;
    const args = [...w.args];
    if (opts.limit) { sql += ' LIMIT ?'; args.push(Number(opts.limit)); }

    const tasks = decorateLinks(d.all(sql, args).map(rowToTask));
    // total 是「这个视图里有多少条」，跟 tasks 受同一个归档过滤，
    // 但不吃 project/status/category —— 前端拿它当分母画比例。
    //
    // 被合并的卡不算：它们是历史记录，看板上不占位（前端 inView 也会排掉）。
    // 算进 total 就会出现「侧栏写 12、页脚写 9」这种对不上的账。
    const total = opts.include_archived
      ? Number(d.get('SELECT COUNT(*) AS c FROM tasks WHERE merged_into IS NULL')?.c || 0)
      : Number(d.get(
        'SELECT COUNT(*) AS c FROM tasks WHERE archived_at IS NULL AND merged_into IS NULL'
      )?.c || 0);
    return { projects: listProjects(), tasks, total };
  }

  function state(opts = {}) {
    const d = conn();
    const w = buildWhere(opts);
    const tasks = decorateLinks(
      d.all(TASK_SELECT + w.sql + ` ORDER BY ${PRIORITY_ORDER_SQL}, t.created_at DESC`).map(rowToTask)
    );

    // 计数必须和**看板上真正画出来的卡片**逐条对齐，否则侧栏写 9、
    // 列头写 2，用户只会认为筛选坏了（真实反馈：「点击菜单筛选的结果也不对」）。
    //
    // 和 board.html 的 inView() 一一对应，一个都不能少：
    //   archived_at IS NULL      归档只在归档视图
    //   merged_into IS NULL      被合并的卡不占位
    //   dev_ready = 1            待澄清的归「待澄清」页签，不进看板三列
    //   project <> 未分配        收件筐里的只在点「默认」时才出现
    //
    // 以前只过滤了前两条，于是 9 条「未开始」里 6 条其实是待澄清、
    // 1 条在收件筐 —— 列里只剩 2 条，账对不上。
    const counts = { todo: 0, doing: 0, done: 0 };
    for (const r of d.all(
      `SELECT t.status, COUNT(*) AS c FROM tasks t
        WHERE t.archived_at IS NULL
          AND t.merged_into IS NULL
          AND COALESCE(t.dev_ready, 1) = 1
          AND t.project <> ?
          AND t.project_id NOT IN (SELECT id FROM projects WHERE name = ?)
        GROUP BY t.status`,
      [DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_NAME]
    )) {
      if (counts[r.status] !== undefined) counts[r.status] = Number(r.c || 0);
    }
    // ▼ 总数 = 三列之和。以前是 tasks.length（全库条数），所以「全部任务 32」
    //   和标题「23 条」同屏打架。两个数字都有出处，但没有人解释过差在哪。
    const total = counts.todo + counts.doing + counts.done;
    return { projects: listProjects(), tasks, counts, total };
  }

  function count() {
    return Number(conn().get('SELECT COUNT(*) AS c FROM tasks')?.c || 0);
  }

  // ---------- 归档 ----------

  /**
   * 把「做完很久了」的任务移出看板。不删任何东西 —— 附件、对话、brief 全留着。
   *
   * 只在启动时和每次 add() 之后各扫一次，不起定时器：这是单机自用，
   * 多一个定时器就多一条平时看不见、出事又难查的故障线。
   *
   * @returns {number} 这次归档了几条
   */
  function archiveStale(days) {
    const d = conn();
    const n = days === undefined || days === null ? loadSettings().archive_after_days : days;
    const num = Number(n);
    const useDays = Number.isFinite(num) && num > 0 ? num : DEFAULT_SETTINGS.archive_after_days;
    const cutoff = new Date(Date.now() - useDays * 24 * 60 * 60 * 1000).toISOString();

    // 只认 done_at：done_at 为空的行是脏数据（正常路径改状态一定会写它），
    // 拿 updated_at 兜底会把「刚点完又被别处改过」的新任务一起扫进去。
    const r = d.run(
      `UPDATE tasks SET archived_at = ?
        WHERE status = 'done'
          AND archived_at IS NULL
          AND done_at IS NOT NULL
          AND done_at < ?`,
      [nowIso(), cutoff]
    );
    return Number(r.changes || 0);
  }

  // ---------- 变更指纹 ----------
  //
  // 轮询不该每次都把整个看板重传一遍。这里算一个「库里有没有变」的摘要。
  //
  // 试过两个方案，第一个是错的，记下来：
  //   方案 A（错）：各表 COUNT + MAX(updated_at)。
  //     漏掉两种情况 —— 改状态只动 status 列，updated_at 同毫秒内不变；
  //     改 settings 那张表根本没有 updated_at 列。两个都实测漏判。
  //   方案 B（现在这个）：
  //     · total_changes() —— 本连接累计改了多少行，单调递增
  //     · PRAGMA data_version —— 别的连接提交时会变（实测 2→3）
  //     两者相加，本进程改的和别的进程改的都能看到，O(1) 不扫表。
  //
  // 代价是值本身不可读（不是「8 条任务」而是个哈希），但它只用来比是否相等，
  // 不需要看懂。重启后 total_changes 归零 → 值变了 → 前端拉一次全量，正确。
  //
  // scope 是「这个 revision 属于哪个视图」。不带它的话，带
  // ?dev_ready=0 和 ?include_archived=1 的两个请求会拿同一个指纹，
  // 前端做完 since 短路就会把 A 视图的缓存当成 B 视图的数据用 —— 数据没坏，
  // 但显示的是另一套过滤结果，比没缓存更糟。现在指纹里带上视图参数，
  // 换视图必然 fingerprint 不同，短路不会误命中。
  function revision(scope) {
    const d = conn();
    const chg = Number(d.get('SELECT total_changes() AS v')?.v || 0);
    const dv = Number(d.get('PRAGMA data_version')?.data_version || 0);
    const s = chg + ':' + dv + (scope ? ':' + String(scope) : '');
    // FNV-1a：短、稳定、不依赖 crypto
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  // ---------- 设置（放库里的 key/value 小表） ----------

  function loadSettings() {
    const d = conn();
    const out = { ...DEFAULT_SETTINGS };
    for (const r of d.all('SELECT key, value FROM settings')) {
      out[r.key] = parseJson(r.value, r.value);
    }
    return out;
  }

  function saveSettings(patch = {}) {
    const d = conn();
    const next = { ...loadSettings() };

    if (patch.backend !== undefined) {
      const ok = ['auto', 'magpie', 'opencode', 'codex'];
      if (!ok.includes(patch.backend)) throw new Error('未知通道: ' + patch.backend);
      next.backend = patch.backend;
    }
    if (patch.model !== undefined) {
      const m = String(patch.model || '').trim();
      if (!m) throw new Error('模型不能为空');
      next.model = m;
    }
    if (patch.classify !== undefined) next.classify = !!patch.classify;
    // 归档阈值不做 UI，但要让脚本/CLI 能改；非法值直接拒，别留下一个「永不归档」的 0
    if (patch.archive_after_days !== undefined) {
      const n = Number(patch.archive_after_days);
      if (!Number.isFinite(n) || n <= 0) throw new Error('archive_after_days 必须是正整数');
      next.archive_after_days = Math.round(n);
    }

    d.tx(() => {
      for (const k of ['backend', 'model', 'classify', 'archive_after_days']) {
        d.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [k, JSON.stringify(next[k])]
        );
      }
    });
    return next;
  }

  // ---------- 导出 / 备份 ----------

  /**
   * 把整库导成老的 tasks.json 形状（version 2）。
   * 这个格式正是 migrateFromJson 认识的，所以导出文件既是备份，
   * 也是一个能原样倒回去的迁移包。
   */
  function exportAll() {
    const d = conn();
    // 备份语义是全都要：归档的任务照样导出来，否则「备份」就不是备份了
    const projects = d.all('SELECT * FROM projects ORDER BY sort_order, created_at').map(rowToProject);
    const tasks = d.all(TASK_SELECT + ' ORDER BY t.created_at').map((r) => {
      const t = rowToTask(r);
      // 老格式里没有 message_count / no 这类派生字段，messages 是实数组 —— 去干净点，
      // 导出的文件才好跟历史 tasks.json 直接 diff（no 由 seq_no 推得出来，不必存两遍）
      delete t.message_count;
      delete t.no;
      t.messages = listMessages(t.id);
      return t;
    });
    return {
      // 3 起导出里多了 dev_gaps（归档/待澄清的状态在 v2 就已经带了）。
      // 版本号只增不改语义：老导出文件仍然能被 migrateFromJson 读进来。
      version: 3,
      exported_at: nowIso(),
      schema_version: Number(d.get("SELECT value FROM meta WHERE key = 'schema_version'")?.value || 0),
      projects,
      tasks
    };
  }

  /** 备份：优先用 SQLite 自带的 VACUUM INTO（WAL 下也安全，不用先停服务）。 */
  function backupTo(target) {
    const d = conn();
    const file = target || path.join(
      dataDir,
      'backup-' + nowIso().replace(/[:.]/g, '-').slice(0, 19) + '.db'
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // VACUUM INTO 要求目标不存在
    if (fs.existsSync(file)) throw new Error('目标已存在：' + file);
    d.run('VACUUM INTO ?', [file]);
    return { file, bytes: fs.statSync(file).size };
  }

  // ---------- 附件（继续放文件系统，不进库） ----------

  // 存一张 base64 图片，返回 { path, url }
  function saveImage(dataUrl) {
    const m = String(dataUrl || '').match(/^data:image\/([a-z]+);base64,(.+)$/i);
    if (!m) throw new Error('需要 dataUrl: data:image/png;base64,...');
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 12 * 1024 * 1024) throw new Error('图片太大（>12MB）');
    fs.mkdirSync(imagesDir, { recursive: true });
    const name = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
    fs.writeFileSync(path.join(imagesDir, name), buf);
    return { path: path.join(imagesDir, name), url: '/images/' + name, name };
  }

  // 存任意附件（base64），保留原文件名便于识别
  function saveFile(dataUrl, filename) {
    const m = String(dataUrl || '').match(/^data:[^;]*;base64,(.+)$/i);
    if (!m) throw new Error('需要 dataUrl');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 25 * 1024 * 1024) throw new Error('附件太大（>25MB）');
    fs.mkdirSync(filesDir, { recursive: true });
    const safe = String(filename || 'file')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/^[.]+/, '')
      .slice(-80);
    const name = Date.now().toString(36) + '_' + (safe || 'file');
    fs.writeFileSync(path.join(filesDir, name), buf);
    return { path: path.join(filesDir, name), name, original: safe, size: buf.length };
  }

  function filePath(name) {
    return path.join(filesDir, path.basename(name));
  }

  function imagePath(name) {
    return path.join(imagesDir, path.basename(name));
  }

  function close() {
    if (!db) return;
    // 正常关停时把 WAL 收回去：不然目录里会留一个几 MB 的 -wal，
    // 跟几十 KB 的主库放在一起看着不成比例（虽然不影响正确性）。
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 只读库等情况，忽略 */ }
    try { db.close(); } catch { /* 已关闭 */ }
    db = null;
  }

  return {
    dataDir,
    dbFile,
    jsonFile,
    dataFile: dbFile,   // 兼容旧调用方的命名，指向的已经是 .db
    imagesDir, filesDir, settingsFile,
    conn, init, close,
    add, getTask, patch, move, remove, list, state, count, revision, archiveStale,
    linkTasks, unlinkTasks, deleteLink, listLinks, linksOf,
    blockedBy, reachable,
    // 层级（第 3 步）：增删 parent 边时内部会同步 parent_id + 重算祖先状态，
    // 这里把只读的那几个（childrenOf / subtreeStats / recomputeStatus）也开出去，
    // 服务端和测试要能单独验它们。
    childrenOf, childCount, subtreeStats, recomputeStatus, deriveStatus, MAX_DEPTH,
    mergeTasks, splitTask, revertMerge,
    // 阶段 1A：持久 Agent Session / Turn
    createSession, listSessions, getSession, updateSession, bindExternalSession, deleteSession,
    startTurn, markTurnRunning, finishTurn, getTurn, listTurns, openTurn,
    recoverOpenTurns, refreshSessionStatus, setSessionStatus, openTurnsForTask,
    pushMessage, listMessages, recentMessages, clearMessages, setBrief,
    listProjects, getProject, addProject, updateProject, deleteProject, findProject, ensureProject,
    reorderProjects,
    loadSettings, saveSettings,
    exportAll, backupTo,
    saveImage, imagePath, saveFile, filePath
  };
}
