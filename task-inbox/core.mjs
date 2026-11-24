// core.mjs —— 任务存储的纯逻辑层
//
// 这里不碰 http、不碰 Alma API，只做一件事：把任务存进 SQLite、读出来、改掉。
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

export const PRIORITY_LABEL = {
  p0: 'P0 阻塞', p1: 'P1 紧急', p2: 'P2 常规', p3: 'P3 低', p4: 'P4 待定'
};

export const KIND_LABEL = {
  text: '文字', image: '图片', image_text: '图+文', link: '链接',
  file: '附件', mixed: '混合'
};

export const DEFAULT_SETTINGS = {
  backend: 'auto',                      // auto | magpie | alma | opencode | codex
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

  function rowToProject(r) {
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      aliases: parseJson(r.aliases, []),
      dirs: parseJson(r.dirs, []),
      sort_order: Number(r.sort_order || 0),
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
      created_at: r.created_at,
      updated_at: r.updated_at,
      doing_at: r.doing_at,
      done_at: r.done_at
    };
    if (r.message_count !== undefined) t.message_count = Number(r.message_count || 0);
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

  /** 任务查询统一带一个消息计数，前端不用再为了「有几条」把消息全读出来 */
  const TASK_SELECT = `
    SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.task_id = t.id) AS message_count
      FROM tasks t`;

  // ---------- 关系派生字段 ----------
  //
  // 列表里每张卡要带 has_merge / has_split / link_counts。这三个都是派生的，
  // 不能存在 tasks 上（否则「改了层级，合并历史也跟着变」那种事就会出现）。
  //
  // 一次把 links 全捞出来在内存里归并：这张表很小（一条边两行数据），
  // 一次全表扫比「每张卡再查一次」便宜一个数量级 —— 后者 2000 条任务
  // 就是 2000 次 SQL，而 /api/state 每 3 秒被轮询一次。
  function linkStats(ids) {
    const stat = new Map();
    if (!ids.size) return stat;
    for (const r of conn().all('SELECT kind, from_id, to_id FROM links')) {
      if (ids.has(r.from_id)) {
        let s = stat.get(r.from_id);
        if (!s) { s = { from: {}, to: {} }; stat.set(r.from_id, s); }
        s.from[r.kind] = (s.from[r.kind] || 0) + 1;
      }
      if (ids.has(r.to_id)) {
        let s = stat.get(r.to_id);
        if (!s) { s = { from: {}, to: {} }; stat.set(r.to_id, s); }
        s.to[r.kind] = (s.to[r.kind] || 0) + 1;
      }
    }
    return stat;
  }

  /**
   * 给一批任务挂上关系派生字段。原地改，返回同一个数组。
   *
   *   has_merge    这张卡有 merge_parent 边指向旧卡（= 它是合并出来的新卡）
   *   has_split    这张卡有 split_of 边指向子卡（= 它被拆过）
   *   link_counts  两个方向都算：这张卡身上一共有多少条边，按 kind 分
   *
   * 方向的选择是刻意的：has_merge / has_split 只看「我指向谁」，
   * 因为徽章是入口 —— 点开看的是「我从哪来 / 我拆出了什么」。
   * 反方向的边（谁合并了我 / 我是谁拆出来的）在 link_counts 和抽屉的
   * 「关系」区里都能看到，不占卡片上那点位置。
   */
  function decorateLinks(tasks) {
    const ids = new Set(tasks.map((t) => t.id));
    const stat = linkStats(ids);
    for (const t of tasks) {
      const s = stat.get(t.id) || { from: {}, to: {} };
      t.has_merge = (s.from.merge_parent || 0) > 0;
      t.has_split = (s.from.split_of || 0) > 0;
      const counts = {};
      for (const k of LINK_KINDS) counts[k] = (s.from[k] || 0) + (s.to[k] || 0);
      t.link_counts = counts;
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

  function listProjects() {
    const d = conn();
    // 顺序 = 用户拖出来的 sort_order；同值（老库刚升上来）时退回创建时间，保证稳定
    const rows = d.all(
      `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS taskCount
         FROM projects p
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
    next.updated_at = nowIso();

    d.tx(() => {
      d.run(
        'UPDATE projects SET name = ?, aliases = ?, dirs = ?, updated_at = ? WHERE id = ?',
        [next.name, JSON.stringify(next.aliases), JSON.stringify(next.dirs), next.updated_at, id]
      );
      // 任务上的冗余项目名跟着改，保持「外部直接读」的那个便利
      if (next.name !== cur.name) {
        d.run('UPDATE tasks SET project = ? WHERE project_id = ?', [next.name, id]);
      }
    });

    return next;
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
    const known = new Map(d.all('SELECT id, name FROM projects').map((r) => [r.id, r.name]));

    const ordered = [];
    for (const id of list) {
      const name = known.get(id);
      if (name === undefined) throw new Error('项目不存在: ' + id);
      if (name === DEFAULT_PROJECT_NAME) continue;   // 固定第一位，跳过而不是报错
      if (ordered.includes(id)) continue;
      ordered.push(id);
    }

    const rest = d.all('SELECT id, name FROM projects ORDER BY sort_order, created_at')
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
  function findProject(key) {
    if (!key) return null;
    const d = conn();
    const k = String(key);
    const byId = d.get('SELECT * FROM projects WHERE id = ?', [k]);
    if (byId) return rowToProject(byId);
    const byName = d.get('SELECT * FROM projects WHERE name = ?', [k]);
    if (byName) return rowToProject(byName);
    // 别名是 JSON 数组，用 json_each 展开匹配（SQLite 3.38+ / node:sqlite 自带）
    const byAlias = d.get('SELECT * FROM projects, json_each(projects.aliases) WHERE json_each.value = ? LIMIT 1', [k]);
    return rowToProject(byAlias);
  }

  // 项目不存在就按名字补一个 —— 收任务时最常见的情况
  // 这里是内部兜底，不受 deleteProject 那条「「默认」不能删」的保护影响：
  // 收件筐被误删过之后，下一条没项目的任务还得能落回来。
  function ensureProject(name, projectId) {
    const d = conn();
    if (projectId) {
      const hit = d.get('SELECT * FROM projects WHERE id = ?', [projectId]);
      if (hit) return rowToProject(hit);
    }
    const n = String(name || DEFAULT_PROJECT_NAME).trim() || DEFAULT_PROJECT_NAME;
    const byName = d.get('SELECT * FROM projects WHERE name = ?', [n]);
    if (byName) return rowToProject(byName);

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

    d.run(
      `INSERT INTO tasks
         (id, title, kind, payload, project, project_id, category, status, priority, note, source,
          brief, brief_at, classify_state, classify_reason, classify_model, claimed_by, needs_project,
          dev_ready, dev_gaps, archived_at, created_at, updated_at, doing_at, done_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        t.id, t.title, t.kind, JSON.stringify(t.payload), t.project, t.project_id,
        t.category, t.status, t.priority, t.note, t.source,
        t.brief, t.brief_at,
        t.classify_state, t.classify_reason, t.classify_model, t.claimed_by,
        t.needs_project ? 1 : 0,
        t.dev_ready ? 1 : 0, JSON.stringify(t.dev_gaps || []), t.archived_at,
        t.created_at, t.updated_at, t.doing_at, t.done_at
      ]
    );

    return { ...t, message_count: 0 };
  }

  function getTask(id) {
    if (!id) return null;
    const t = rowToTask(conn().get(TASK_SELECT + ' WHERE t.id = ?', [id]));
    // 单条也要带 has_merge / has_split / link_counts：抽屉的「关系」区
    // 和卡片上的徽章读的是同一份数据，分两套就一定会有一处忘了更新。
    return t ? decorateOne(t) : null;
  }

  function decorateOne(t) {
    const stat = linkStats(new Set([t.id]));
    const s = stat.get(t.id) || { from: {}, to: {} };
    t.has_merge = (s.from.merge_parent || 0) > 0;
    t.has_split = (s.from.split_of || 0) > 0;
    const counts = {};
    for (const k of LINK_KINDS) counts[k] = (s.from[k] || 0) + (s.to[k] || 0);
    t.link_counts = counts;
    return t;
  }

  function requireTask(id) {
    const t = getTask(id);
    if (!t) throw new Error('任务不存在: ' + id);
    return t;
  }

  function applyStatus(t, status) {
    if (!STATUSES.includes(status)) throw new Error('非法状态: ' + status);
    if (t.status === status) return { changed: false };
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

  const PATCHABLE = [
    'title', 'kind', 'project', 'project_id', 'category', 'priority', 'note', 'claimed_by',
    'classify_state', 'classify_reason', 'classify_model'
  ];

  function patch(id, fields = {}) {
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
      const others = Object.keys(fields).filter((k) => fields[k] !== undefined && k !== 'merged_into');
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

    if (fields.payload && typeof fields.payload === 'object') {
      const merged = { ...t.payload, ...fields.payload };
      sets.push('payload = ?');
      args.push(JSON.stringify(merged));
    }

    if (fields.status !== undefined) {
      const r = applyStatus(t, fields.status);
      if (r.changed) {
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

    d.run('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?', args);
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

  /**
   * 建一条边。
   * - kind 必须是四种之一
   * - 两端都得真实存在
   * - 不能自己连自己
   * - 重复不报错（返回已有的那条）—— 合并/拆分是幂等的，
   *   重试一次请求不该变成一个错误
   * - merge_parent 专门查一次环：合并关系理论上不该成环，
   *   但一旦成环，「点【合】徽章」那个入口就会无限套娃
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

    if (kind === 'merge_parent') {
      // 环检测：从 to 往上爬它已有的 merge_parent 祖先，撞到 from 就是环。
      // 用迭代 + 访问集合兜底 —— 就算库里已经存着一个环，也不会死循环。
      const seen = new Set();
      let cur = to;
      while (cur && !seen.has(cur)) {
        if (cur === from) throw new Error('合并关系会成环：' + from + ' 已经在 ' + to + ' 的合并链上');
        seen.add(cur);
        const up = d.get("SELECT to_id FROM links WHERE kind = 'merge_parent' AND from_id = ? LIMIT 1", [cur]);
        cur = up?.to_id || null;
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
    return row;
  }

  function unlinkTasks(fromId, toId, kind) {
    const d = conn();
    if (!LINK_KINDS.includes(kind)) throw new Error('未知关系类型: ' + kind);
    const r = d.run('DELETE FROM links WHERE kind = ? AND from_id = ? AND to_id = ?',
      [kind, String(fromId || ''), String(toId || '')]);
    return { removed: Number(r.changes || 0) };
  }

  function deleteLink(id) {
    const d = conn();
    const r = d.run('DELETE FROM links WHERE id = ?', [String(id || '')]);
    if (!Number(r.changes || 0)) throw new Error('关系不存在: ' + id);
    return { removed: 1 };
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
      for (const t of olds) {
        d.run('UPDATE tasks SET merged_into = ?, updated_at = ? WHERE id = ?', [created.id, now, t.id]);
        linkTasks(created.id, t.id, 'merge_parent', '', { touch: false });
      }
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
      for (const e of edges) {
        d.run("DELETE FROM links WHERE id = ?", [e.id]);
        // 只清指向这张卡的引用：万一某张旧卡后来又被合并进别的卡，
        // 无条件清空会把它后来的关系一起擦掉
        d.run('UPDATE tasks SET merged_into = NULL, updated_at = ? WHERE id = ? AND merged_into = ?',
          [now, e.to_id, id]);
        const back = getTask(e.to_id);
        if (back) restored.push(back.id);
      }
      d.run('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
        [now, now, id]);
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
      // status 走 applyStatus 那条路，doing_at / done_at 才会按现有规则落
      const done = applyStatus(source, 'done');
      if (done.changed) {
        const sets = Object.entries(done.fields).map(([k]) => k + ' = ?');
        d.run('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?',
          [...Object.values(done.fields), source.id]);
      }

      if (opts.note) {
        d.run('UPDATE tasks SET note = note || ? WHERE id = ?', ['\n' + String(opts.note), source.id]);
      }

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

  function remove(id) {
    const d = conn();
    const t = requireTask(id);

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

    // messages / links 靠 ON DELETE CASCADE 一并清掉。
    // 但 merged_into 是个普通 TEXT 列（没有外键），删掉被合并的旧卡之后
    // 别处指向它的引用会悬空 —— 手工清一遍。
    d.tx(() => {
      d.run('UPDATE tasks SET merged_into = NULL WHERE merged_into = ?', [id]);
      d.run('DELETE FROM tasks WHERE id = ?', [id]);
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

    return { ...t, removedFiles: removed };
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

    // 计数单独查一遍，只看未归档 —— 已归档的「已完成」不该还挂在侧栏上。
    // 键固定 todo/doing/done 三个，不加 draft/archived：那是视图，不是列。
    //
    // 被合并的卡（merged_into 非空）也不计：它们在看板上不占位（见 board.html
    // 的 inView），算进计数就会出现「侧栏写 3、列里只有 1 条」这种对不上的账。
    const counts = { todo: 0, doing: 0, done: 0 };
    for (const r of d.all(
      'SELECT status, COUNT(*) AS c FROM tasks WHERE archived_at IS NULL AND merged_into IS NULL GROUP BY status'
    )) {
      if (counts[r.status] !== undefined) counts[r.status] = Number(r.c || 0);
    }
    return { projects: listProjects(), tasks, counts, total: tasks.length };
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
      const ok = ['auto', 'magpie', 'alma', 'opencode', 'codex'];
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
      // 老格式里没有 message_count 这个派生字段，messages 是实数组 —— 去干净点，
      // 导出的文件才好跟历史 tasks.json 直接 diff
      delete t.message_count;
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
    mergeTasks, splitTask, revertMerge,
    pushMessage, listMessages, recentMessages, clearMessages, setBrief,
    listProjects, getProject, addProject, updateProject, deleteProject, findProject, ensureProject,
    reorderProjects,
    loadSettings, saveSettings,
    exportAll, backupTo,
    saveImage, imagePath, saveFile, filePath
  };
}
