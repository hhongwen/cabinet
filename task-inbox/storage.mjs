// storage.mjs —— SQLite 存储底层
//
// 只做三件事：
//   1. 找出可用的 sqlite 驱动（Node 内置 node:sqlite / Bun 内置 bun:sqlite）
//   2. 建表、建索引、设置 PRAGMA
//   3. 提供一层统一的 prepare/run/get/all/exec —— 抹平两个驱动的差异
//
// 上层 core.mjs 只认这层暴露的 SQL 接口，不关心底下是哪个运行时。
// 这样即使 Alma 哪天把插件宿主从 node 换成 bun，这里自动跟着换，业务代码不动。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------- 驱动探测 ----------

// 两个驱动的差异只在这几处：
//   node:sqlite  → new DatabaseSync(file)     然后 db.prepare(sql).run/get/all
//   bun:sqlite   → new Database(file, {...})  然后 db.prepare(sql) 或 db.query(sql)，同样有 run/get/all
// 语句对象的方法名两边一致，所以包一层就够了。
function openNodeSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  return wrapDriver(db, 'node');
}

function openBunSqlite(file) {
  const { Database } = require('bun:sqlite');
  // create: true —— 文件不存在就建，跟 node:sqlite 的行为对齐
  const db = new Database(file, { create: true, readwrite: true });
  return wrapDriver(db, 'bun');
}

// 统一的语句包装：位置参数 ?，两边语义一致，不碰命名参数方言
function wrapDriver(raw, kind) {
  const cache = new Map();
  let txDepth = 0;

  // node:sqlite 不接受 undefined / boolean 作为绑定值（会抛 TypeError），
  // bun 接受但会存成不同类型。统一在这里归一化，避免两边行为分叉。
  function norm(params) {
    return params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'bigint') return Number(v);
      return v;
    });
  }

  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  }

  return {
    kind,
    file: raw.filename || raw.path || '',

    exec(sql) {
      raw.exec(sql);
    },

    run(sql, params = []) {
      const r = stmt(sql).run(...norm(params));
      // 两边返回 { changes, lastInsertRowid }，但 bun 的类型是 bigint
      return { changes: Number(r?.changes ?? 0), lastInsertRowid: Number(r?.lastInsertRowid ?? 0) };
    },

    get(sql, params = []) {
      const r = stmt(sql).get(...norm(params));
      return r === undefined ? null : r;
    },

    all(sql, params = []) {
      const rows = stmt(sql).all(...norm(params));
      return Array.isArray(rows) ? rows : [];
    },

    close() {
      try { raw.close(); } catch { /* 已经关了 */ }
      cache.clear();
      txDepth = 0;
    },

    // 事务：失败自动回滚。
    // 支持嵌套 —— 里层用 SAVEPOINT，外层还是真事务。
    // 否则任何「批量操作里再调一个自带事务的方法」都会直接炸。
    tx(fn) {
      const depth = txDepth;
      if (depth === 0) raw.exec('BEGIN IMMEDIATE');

      const sp = 'sp_' + depth;
      if (depth > 0) raw.exec('SAVEPOINT ' + sp);

      txDepth++;
      try {
        const out = fn();
        txDepth--;
        if (depth > 0) raw.exec('RELEASE ' + sp);
        else raw.exec('COMMIT');
        return out;
      } catch (e) {
        txDepth--;
        try {
          if (depth > 0) raw.exec('ROLLBACK TO ' + sp);
          else raw.exec('ROLLBACK');
        } catch { /* 回滚也失败了，抛原始错误 */ }
        throw e;
      }
    }
  };
}

/**
 * 打开数据库并返回统一句柄。
 * 优先用当前运行时的内置驱动：
 *   - Bun  → bun:sqlite
 *   - Node → node:sqlite（22.5+ 内置，24 起不需要 flag）
 * Bun 里没有 node:sqlite（会抛 No such built-in module），所以顺序不能反。
 */
export function openSqlite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const errors = [];

  if (typeof globalThis.Bun !== 'undefined') {
    try {
      return openBunSqlite(file);
    } catch (e) {
      errors.push('bun:sqlite → ' + e.message);
    }
  }

  try {
    return openNodeSqlite(file);
  } catch (e) {
    errors.push('node:sqlite → ' + e.message);
  }

  throw new Error(
    '找不到可用的 SQLite 驱动。\n' +
    '需要 Node 22.5+（推荐 24+）或 Bun 1.x。\n' +
    '当前运行时: ' + (typeof globalThis.Bun !== 'undefined' ? 'Bun ' + (globalThis.Bun.version || '?') : 'Node ' + process.version) + '\n' +
    errors.map((x) => '  · ' + x).join('\n')
  );
}

// ---------- schema ----------

// 版本号存在 meta 里，将来加字段时按版本走迁移
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  aliases    TEXT NOT NULL DEFAULT '[]',   -- JSON array
  dirs       TEXT NOT NULL DEFAULT '[]',   -- JSON array of {path,note,primary}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'text',
  payload         TEXT NOT NULL DEFAULT '{}',   -- JSON {text,images,files,urls,path}
  project         TEXT NOT NULL DEFAULT '默认',  -- 冗余的项目名，方便直接读
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  category        TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'todo',
  priority        TEXT NOT NULL DEFAULT 'p3',
  note            TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'chat',
  brief           TEXT NOT NULL DEFAULT '',
  brief_at        TEXT,
  classify_state  TEXT NOT NULL DEFAULT 'off',
  classify_reason TEXT NOT NULL DEFAULT '',
  classify_model  TEXT NOT NULL DEFAULT '',
  claimed_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  doing_at        TEXT,
  done_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_sort    ON tasks(priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS messages (
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role    TEXT NOT NULL,
  text    TEXT NOT NULL DEFAULT '',
  patch   TEXT,                                 -- JSON 或 NULL
  at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function applySchema(db) {
  db.exec('PRAGMA journal_mode = WAL');       // 多进程读写不打架
  db.exec('PRAGMA busy_timeout = 10000');     // 撞锁等 10 秒而不是立刻报错
  db.exec('PRAGMA synchronous = NORMAL');     // WAL 下够安全，快很多
  db.exec('PRAGMA foreign_keys = ON');        // 删任务级联删消息
  db.exec(SCHEMA);

  const cur = db.get('SELECT value FROM meta WHERE key = ?', ['schema_version']);
  if (!cur) {
    db.run('INSERT INTO meta(key, value) VALUES(?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
  }
  return db;
}

// ---------- 从 tasks.json 迁移 ----------

// 只认带 version 字段的对象格式。别的形状（比如 Alma 自己那个数组）
// 一律当成「不是我的文件」，绝不覆盖 —— 这是踩过的坑。
export function looksLikeTaskInboxJson(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj)
    && (obj.version === 1 || obj.version === 2) && Array.isArray(obj.tasks);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error('tasks.json 读取失败（' + file + '）：' + e.message);
  }
}

/**
 * 把老的单文件 JSON 灌进 SQLite。
 * - 只在库是空的时候执行
 * - 整个导入在一个事务里，失败回滚，原文件不动
 * - 成功后把 tasks.json 改名成 .migrated-<时间戳>，不删
 *
 * @returns {{migrated:boolean, reason?:string, tasks?:number, projects?:number, messages?:number, backup?:string}}
 */
export function migrateFromJson(db, dataDir, opts = {}) {
  const jsonFile = path.join(dataDir, 'tasks.json');
  const existing = db.get('SELECT COUNT(*) AS c FROM tasks');
  if (Number(existing?.c || 0) > 0) {
    return { migrated: false, reason: '库里已经有任务了，不重复迁移' };
  }

  const raw = readJsonSafe(jsonFile);
  if (raw === null) return { migrated: false, reason: '没有 tasks.json，没东西可迁' };
  if (!looksLikeTaskInboxJson(raw)) {
    return { migrated: false, reason: 'tasks.json 不是 task-inbox 的格式，拒绝导入（文件未改动）' };
  }

  // 沿用原来的结构升级逻辑：字符串项目 → 对象，任务补 project_id
  const { projects, tasks } = normalizeLegacyStore(raw);

  const stats = db.tx(() => {
    const projByName = new Map();
    const projIds = new Set();
    for (const p of projects) {
      db.run(
        `INSERT OR IGNORE INTO projects (id, name, aliases, dirs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [p.id, p.name, JSON.stringify(p.aliases || []), JSON.stringify(p.dirs || []), p.created_at, p.updated_at]
      );
      projByName.set(p.name, p);
      projIds.add(p.id);
    }

    const fallbackProj = projects[0];
    let msgCount = 0;
    for (const t of tasks) {
      // project_id 指向的项目必须真实存在，否则外键会挡下来
      const pid = (t.project_id && projIds.has(t.project_id))
        ? t.project_id
        : (projByName.get(t.project)?.id || fallbackProj.id);
      db.run(
        `INSERT OR REPLACE INTO tasks
           (id, title, kind, payload, project, project_id, category, status, priority, note, source,
            brief, brief_at, classify_state, classify_reason, classify_model, claimed_by,
            created_at, updated_at, doing_at, done_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          t.id, t.title, t.kind, JSON.stringify(t.payload || {}), t.project, pid,
          t.category || '', t.status || 'todo', t.priority || 'p3', t.note || '', t.source || 'chat',
          t.brief || '', t.brief_at || null,
          t.classify_state || 'off', t.classify_reason || '', t.classify_model || '', t.claimed_by || null,
          t.created_at, t.updated_at, t.doing_at || null, t.done_at || null
        ]
      );
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      for (const m of msgs) {
        db.run(
          'INSERT OR REPLACE INTO messages (id, task_id, role, text, patch, at) VALUES (?,?,?,?,?,?)',
          [
            m.id || ('m_' + Math.random().toString(36).slice(2, 10)),
            t.id,
            m.role === 'assistant' ? 'assistant' : 'user',
            String(m.text || '').slice(0, 4000),
            m.patch && typeof m.patch === 'object' ? JSON.stringify(m.patch) : null,
            m.at || t.updated_at || t.created_at
          ]
        );
        msgCount++;
      }
    }

    // settings.json 一并搬进来（如果存在），然后由调用方决定改名
    const settingsFile = path.join(dataDir, 'settings.json');
    let settingsMoved = 0;
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      for (const [k, v] of Object.entries(s || {})) {
        db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, JSON.stringify(v)]);
        settingsMoved++;
      }
    } catch { /* 没有就算了 */ }

    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['migrated_from_json_at', new Date().toISOString()]);
    return { projectCount: projects.length, taskCount: tasks.length, msgCount, settingsMoved };
  });

  let backup = '';
  if (!opts.keepJson) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    backup = jsonFile + '.migrated-' + stamp;
    try {
      fs.renameSync(jsonFile, backup);
    } catch { backup = ''; }
  }

  return {
    migrated: true,
    projects: stats.projectCount,
    tasks: stats.taskCount,
    messages: stats.msgCount,
    settings: stats.settingsMoved,
    backup
  };
}

// 老数据结构升级：projects 可能是字符串数组，任务可能只有 project 名字
// （这段逻辑原来在 core.mjs 的 migrate() 里，搬过来给迁移和 core 共用）
export function normalizeLegacyStore(d) {
  let pidSeq = 0;
  const newProjectId = () => 'p_' + Date.now().toString(36) + ((pidSeq = (pidSeq + 1) % 1000), pidSeq.toString(36).padStart(2, '0'));
  const nowIso = () => new Date().toISOString();
  const normalizeDir = (x = {}) => {
    const raw = typeof x === 'string' ? { path: x } : x;
    return {
      path: String(raw.path || '').trim(),
      note: String(raw.note || '').trim().slice(0, 200),
      primary: !!raw.primary
    };
  };

  const list = Array.isArray(d.projects) ? d.projects : [];
  const objects = [];
  const byName = new Map();

  for (const item of list) {
    if (typeof item === 'string') {
      const name = item.trim() || '默认';
      if (byName.has(name)) continue;
      const proj = { id: newProjectId(), name, aliases: [], dirs: [], created_at: nowIso(), updated_at: nowIso() };
      objects.push(proj);
      byName.set(name, proj);
    } else if (item && typeof item === 'object' && item.name) {
      const proj = {
        id: item.id || newProjectId(),
        name: String(item.name),
        aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
        dirs: Array.isArray(item.dirs) ? item.dirs.map(normalizeDir) : [],
        created_at: item.created_at || nowIso(),
        updated_at: item.updated_at || nowIso()
      };
      objects.push(proj);
      byName.set(proj.name, proj);
    }
  }

  if (!objects.length) {
    const proj = { id: 'p_default', name: '默认', aliases: [], dirs: [], created_at: nowIso(), updated_at: nowIso() };
    objects.push(proj);
    byName.set('默认', proj);
  }

  const tasks = Array.isArray(d.tasks) ? d.tasks : [];
  for (const t of tasks) {
    if (!Array.isArray(t.messages)) t.messages = [];
    if (typeof t.brief !== 'string') t.brief = '';
    const known = t.project_id && objects.some((x) => x.id === t.project_id);
    if (!known) {
      const name = String(t.project || '默认');
      const proj = byName.get(name) || objects[0];
      t.project_id = proj.id;
      t.project = proj.name;
    }
  }

  return { projects: objects, tasks };
}
