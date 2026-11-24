// storage.mjs —— SQLite 存储底层
//
// 只做三件事：
//   1. 找出可用的 sqlite 驱动（Node 内置 node:sqlite / Bun 内置 bun:sqlite）
//   2. 建表、建索引、设置 PRAGMA
//   3. 提供一层统一的 prepare/run/get/all/exec —— 抹平两个驱动的差异
//
// 上层 core.mjs 只认这层暴露的 SQL 接口，不关心底下是哪个运行时。
// 这样即使将来把运行时从 node 换成 bun，这里自动跟着换，业务代码不动。

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

// 版本号存在 meta 里。加字段时：把 SCHEMA_VERSION +1，在 MIGRATIONS 里补一条。
export const SCHEMA_VERSION = 9;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  aliases       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  dirs          TEXT NOT NULL DEFAULT '[]',   -- JSON array of {path,note,primary}
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,   -- 侧栏拖拽顺序，「默认」永远是 0
  default_agent TEXT,                          -- opencode | codex | NULL
  default_model TEXT,                          -- NULL = 用 Agent 默认模型
  archived_at   TEXT                           -- NULL = 未归档
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
  needs_project   INTEGER NOT NULL DEFAULT 0,   -- 1 = 判不出项目，界面上提示手选
  dev_ready       INTEGER NOT NULL DEFAULT 1,   -- 0 = 需求待澄清，不进看板
  dev_gaps        TEXT NOT NULL DEFAULT '[]',   -- JSON array：初判说「还缺这些」
  archived_at     TEXT,                          -- NULL = 未归档
  merged_into     TEXT,                          -- 被合并进的卡片 id（NULL = 没被合并）
  split_state     TEXT,                          -- 预留：拆分状态（本轮不写，恒 NULL）
  link_warn       TEXT NOT NULL DEFAULT '',      -- 前置被删/合并后的提示（看过就清空）
  parent_id       TEXT,                          -- 冗余的父卡 id（跟着 parent 边同步，单值）
  -- v8：表格视图要的 6 个业务字段。doing_at / done_at 是**事实**，
  -- plan_* 是**意图**，两回事，绝不合并。
  seq_no          INTEGER,                       -- 短编号（显示成 T-001）。唯一性不靠 UNIQUE 约束，
                                                 -- 见 MIGRATIONS[7] 的说明
  plan_start_at   TEXT,                          -- 计划开始 YYYY-MM-DD
  plan_end_at     TEXT,                          -- 计划结束 YYYY-MM-DD
  owner           TEXT,                          -- 需求负责人
  estimate_hours  REAL,                          -- 预估工时
  actual_hours    REAL,                          -- 实际工时
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  doing_at        TEXT,
  done_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_sort    ON tasks(priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
-- idx_tasks_parent 不放在这里：它引用的 parent_id 是 v7 才有的列，
-- 而 db.exec(SCHEMA) 在迁移之前跑 —— 写在 SCHEMA 里会让 v6 老库升级时
-- 卡在「no such column: parent_id」。那条索引由 MIGRATIONS[6] 和新库分支各自建。

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  patch       TEXT,                             -- JSON 或 NULL
  attachments TEXT,                             -- JSON {images:[],files:[]} 或 NULL
  at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, at);

-- 卡片关系：三种关系（合并 / 拆分 / 层级 / 依赖）共用一张有向边表，用 kind 区分。
-- 放在一张表里是因为它们的形状完全一样（有向边 + 两端 + 一句说明），
-- 各自的约束写在 core.mjs 里；分三张表就会出现「同一件事三处同步」。
-- ON DELETE CASCADE：删任务时它的边跟着走，不会留悬空引用。
CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,        -- 'merge_parent' | 'split_of' | 'parent' | 'depends_on'
  from_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(kind, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(kind, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(kind, to_id);

-- 一张卡下挂的外部 Agent 会话。一个角色实例一条，external_session_id
-- 在首次发送时绑定；在那之前为 NULL（前端显示「待首次消息绑定」）。
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'dev',
  agent               TEXT NOT NULL DEFAULT 'opencode',
  external_session_id TEXT,
  working_directory   TEXT NOT NULL,
  model               TEXT,
  status              TEXT NOT NULL DEFAULT 'idle',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 每一轮实际执行。status 是 Turn 的状态，不是 Task 的状态；
-- 一轮完成不等于任务验收通过。
CREATE TABLE IF NOT EXISTS session_turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued',
  user_text     TEXT NOT NULL,
  result_text   TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  events_file   TEXT,                          -- 相对 dataDir，如 sessions/turn_x.jsonl
  external_ref  TEXT,                          -- 外部 messageID，核对时用来对回这一轮
  exit_code     INTEGER,
  started_at    TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 同一会话同时只能有一轮没结束。部分唯一索引比「先查再插」可靠：
-- 两个请求同时进来时，数据库自己保证只有一个成功。
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_open
  ON session_turns(session_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_turns_session ON session_turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_task  ON agent_sessions(task_id, updated_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// 老库升级：key 是「从这个版本升到下一个」要做的事。
// 只在 tasks 表已经存在（也就是老库）的时候才需要跑，新库由 SCHEMA 一次建全。
const MIGRATIONS = {
  // v1 → v2：needs_project 从「前端读但库里没有」变成真的有这一列
  1: (db) => {
    const cols = db.all('PRAGMA table_info(tasks)').map((c) => c.name);
    if (!cols.includes('needs_project')) {
      db.exec('ALTER TABLE tasks ADD COLUMN needs_project INTEGER NOT NULL DEFAULT 0');
    }
  },

  // v2 → v3：待澄清（dev_ready）、归档（archived_at）、对话附件、项目排序
  //
  // 四个字段一次加完。分开升级的话，后一个落地时会把先落的那个跳过去 ——
  // 老库的版本号已经写进 meta，再 `fromVersion < SCHEMA_VERSION` 就不成立了。
  // 所以这一批只占一个版本号。
  2: (db) => {
    const addColumn = (table, column, ddl) => {
      const cols = db.all('PRAGMA table_info(' + table + ')').map((c) => c.name);
      if (!cols.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
    };

    addColumn('tasks', 'dev_ready', 'dev_ready INTEGER NOT NULL DEFAULT 1');
    addColumn('tasks', 'archived_at', 'archived_at TEXT');
    addColumn('messages', 'attachments', 'attachments TEXT');
    addColumn('projects', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');

    // 回填顺序：老库没有顺序概念，按 rowid（≈插入顺序）拿一个稳定值，
    // 再用 created_at 排序就不需要排序遗产了。
    db.exec('UPDATE projects SET sort_order = rowid');

    // 「默认」是未分配收件筐，不是普通项目 —— 它永远钉在第一行。
    // 用名字判断，因为老库里它的 id 可能是 p_default，也可能是迁移时现生成的。
    db.exec("UPDATE projects SET sort_order = 0 WHERE name = '默认'");
  },

  // v3 → v4：dev_gaps
  //
  // 上一版把 dev_ready 落了库，但把「还缺什么」丢掉了 —— 模型判出 false 之后
  // 界面上只能显示「待澄清」，说不了缺在哪儿，用户还得自己再问一遍模型。
  // 单开一个版本号，因为 v3 那批已经落过地了（真库现在就是 3），
  // 再往 2 里加字段会被 `fromVersion < SCHEMA_VERSION` 跳过。
  3: (db) => {
    const cols = db.all('PRAGMA table_info(tasks)').map((c) => c.name);
    if (!cols.includes('dev_gaps')) {
      db.exec("ALTER TABLE tasks ADD COLUMN dev_gaps TEXT NOT NULL DEFAULT '[]'");
    }
  },

  // v4 → v5：卡片关系（合并 / 拆分）
  //
  // links 是新表，SCHEMA 里已经用 CREATE TABLE IF NOT EXISTS 建过一遍，
  // 这一步对老库是「把表补上」。tasks 只加两个状态列：
  //   merged_into —— 被合并进的卡片 id，NULL = 正常卡片
  //   split_state —— 本轮不用（拆分按「done + 备注」处理），先占住列位，
  //                  免得第 3 步真想上 split 状态时再升一次版本。
  4: (db) => {
    db.exec(`
CREATE TABLE IF NOT EXISTS links (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  from_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(kind, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(kind, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(kind, to_id);`);

    const addColumn = (column, ddl) => {
      const cols = db.all('PRAGMA table_info(tasks)').map((c) => c.name);
      if (!cols.includes(column)) db.exec('ALTER TABLE tasks ADD COLUMN ' + ddl);
    };
    addColumn('merged_into', 'merged_into TEXT');
    addColumn('split_state', 'split_state TEXT');
  },

  // v5 → v6：依赖（depends_on）的前置断开提示
  //
  // 前置卡被删除 / 被合并时，那条边会被级联清掉（ON DELETE CASCADE），
  // 但「这条约束曾经存在过」这件事不该静默消失 —— 下游卡上留一行提示，
  // 让人重新确认依赖关系。只加这一列，依赖关系本身仍然活在 links 表里。
  5: (db) => {
    const cols = db.all('PRAGMA table_info(tasks)').map((c) => c.name);
    if (!cols.includes('link_warn')) {
      db.exec("ALTER TABLE tasks ADD COLUMN link_warn TEXT NOT NULL DEFAULT ''");
    }
  },

  // v6 → v7：层级（parent / child）的冗余父卡 id
  //
  // parent 关系本身活在 links 表里（kind = 'parent'，方向：子 → 父）。
  // 但看板每帧都要判断「这张卡有没有父卡、要不要显示折叠箭头」，
  // 走 links join 会把 state() 那条已经够复杂的 SQL 再搅一遍；
  // 而 parent_id 是**单值**（一张卡只能有一个父卡），跟着 parent 边同步，
  // 冗余成本很低 —— 一个 TEXT 列 + 一个索引，换掉每帧一次 join。
  //
  // 回填：从已有的 parent 边刷一遍。现在真库里还没有这种边（第 3 步才落地），
  // 但迁移必须写成幂等的 —— 万一哪次手工插过边、或者以后又有人把这个
  // 版本重跑一遍，结果都得一样：parent_id 和 parent 边完全一致。
  6: (db) => {
    const cols = db.all('PRAGMA table_info(tasks)').map((c) => c.name);
    if (!cols.includes('parent_id')) {
      db.exec('ALTER TABLE tasks ADD COLUMN parent_id TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)');

    // 先清空，再按边回填 —— 只回填、不清空的话，边已经被删掉的卡会留着一个
    // 指向空气的 parent_id，"有没有子项"就会一直算错
    db.exec('UPDATE tasks SET parent_id = NULL');
    db.exec(`
      UPDATE tasks SET parent_id = (
        SELECT l.to_id FROM links l
         WHERE l.kind = 'parent' AND l.from_id = tasks.id
         ORDER BY l.created_at, l.rowid LIMIT 1
      )
      WHERE EXISTS (SELECT 1 FROM links l WHERE l.kind = 'parent' AND l.from_id = tasks.id)`);
  },

  // v7 → v8：表格视图的 6 个业务字段
  //
  // 表格是「同一份数据的第二种渲染」，缺的不是布局而是列 —— 编号、计划时间、
  // 负责人、工时这些业务字段以前根本没有地方存。这批一次加完，理由和 v2 那条
  // 一样：分开升版本，后落地的那个落地时会把先落的那个跳过去。
  //
  // `seq_no` 的唯一性**不靠 UNIQUE 约束**：SQLite 给已存在的表加 UNIQUE 只能
  // 走「建新表 + 拷数据 + 改名」，那一步没有幂等写法，中途失败会留下半张表。
  // 改成「插入时算 MAX(seq_no)+1」（core.mjs 的 add()），代价是并发插入理论上
  // 会撞号，而这个应用是单进程单用户、写入口只有 add()，撞不到。
  //
  // 回填按 `created_at, rowid` 排序 —— created_at 相同（同一毫秒里批量收进来的）
  // 时靠 rowid 兜出一个稳定顺序，否则重跑一次这个迁移号的分配就变了。
  // 只用 `WHERE seq_no IS NULL`，且起点接在已有最大值后面：整体回填时正好是
  // 1..N，部分已填时不会和现有编号撞车。
  7: (db) => {
    const addColumn = (column, ddl) => {
      const cols = db.all('PRAGMA table_info(tasks)').map((c) => c.name);
      if (!cols.includes(column)) db.exec('ALTER TABLE tasks ADD COLUMN ' + ddl);
    };
    addColumn('seq_no', 'seq_no INTEGER');
    addColumn('plan_start_at', 'plan_start_at TEXT');
    addColumn('plan_end_at', 'plan_end_at TEXT');
    addColumn('owner', 'owner TEXT');
    addColumn('estimate_hours', 'estimate_hours REAL');
    addColumn('actual_hours', 'actual_hours REAL');

    db.exec(`
      WITH base AS (
        SELECT COALESCE(MAX(seq_no), 0) AS m FROM tasks WHERE seq_no IS NOT NULL
      ), numbered AS (
        SELECT id, (SELECT m FROM base) + ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS rn
          FROM tasks WHERE seq_no IS NULL
      )
      UPDATE tasks SET seq_no = (SELECT rn FROM numbered WHERE numbered.id = tasks.id)
       WHERE seq_no IS NULL`);
  },

  // v8 → v9：持久 Agent Session
  //
  // 项目三列 + 两张会话表一次加完，理由和 v2/v8 一样：分开升版本时，
  // 后落地的那条会被 `fromVersion < SCHEMA_VERSION` 跳过，字段永远补不上。
  //
  // 两张表的 CREATE 不写进 SCHEMA 常量之外的迁移号里会重复，但这里必须再写一遍：
  // `db.exec(SCHEMA)` 在迁移之前跑，老库能靠 IF NOT EXISTS 建出来；
  // 写在这里是给「迁移单独重跑」和未来手工降级兜底，保持幂等。
  8: (db) => {
    const addColumn = (table, column, ddl) => {
      const cols = db.all('PRAGMA table_info(' + table + ')').map((c) => c.name);
      if (!cols.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
    };

    addColumn('projects', 'default_agent', 'default_agent TEXT');
    addColumn('projects', 'default_model', 'default_model TEXT');
    addColumn('projects', 'archived_at', 'archived_at TEXT');

    db.exec(`
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'dev',
  agent               TEXT NOT NULL DEFAULT 'opencode',
  external_session_id TEXT,
  working_directory   TEXT NOT NULL,
  model               TEXT,
  status              TEXT NOT NULL DEFAULT 'idle',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued',
  user_text     TEXT NOT NULL,
  result_text   TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  events_file   TEXT,
  external_ref  TEXT,
  exit_code     INTEGER,
  started_at    TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_open
  ON session_turns(session_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_turns_session ON session_turns(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_task  ON agent_sessions(task_id, updated_at);`);
  }
};

export function applySchema(db) {
  db.exec('PRAGMA journal_mode = WAL');       // 多进程读写不打架
  db.exec('PRAGMA busy_timeout = 10000');     // 撞锁等 10 秒而不是立刻报错
  db.exec('PRAGMA synchronous = NORMAL');     // WAL 下够安全，快很多
  db.exec('PRAGMA foreign_keys = ON');        // 删任务级联删消息

  // 先看这是不是老库：meta 有版本号、tasks 表也已经有数据
  const metaExists = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
  const recorded = metaExists ? db.get('SELECT value FROM meta WHERE key = ?', ['schema_version']) : null;
  const fromVersion = recorded ? Number(recorded.value) : null;

  db.exec(SCHEMA);   // 全部 CREATE TABLE IF NOT EXISTS，对老库是空操作

  if (fromVersion === null) {
    // 新库：SCHEMA 已经建全，只差那条不能写进 SCHEMA 的索引（见上面注释）
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)');
    db.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
    return db;
  }

  if (fromVersion < SCHEMA_VERSION) {
    db.tx(() => {
      for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (step) step(db);
      }
      db.run('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
    });
  }

  return db;
}

// ---------- 从 tasks.json 迁移 ----------

// 只认带 version 字段的对象格式。别的形状（比如旧版那种裸数组）
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
    let projSeq = 0;
    for (const p of projects) {
      // 导入时给一个新顺序：JSON 里没有这个概念，按数组位置排，「默认」还是 0
      const sortOrder = p.name === '默认' ? 0 : ++projSeq;
      db.run(
        `INSERT OR IGNORE INTO projects (id, name, aliases, dirs, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.name, JSON.stringify(p.aliases || []), JSON.stringify(p.dirs || []),
          sortOrder, p.created_at, p.updated_at]
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
            dev_ready, dev_gaps, archived_at, seq_no, owner, estimate_hours, actual_hours,
            plan_start_at, plan_end_at, created_at, updated_at, doing_at, done_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          t.id, t.title, t.kind, JSON.stringify(t.payload || {}), t.project, pid,
          t.category || '', t.status || 'todo', t.priority || 'p3', t.note || '', t.source || 'chat',
          t.brief || '', t.brief_at || null,
          t.classify_state || 'off', t.classify_reason || '', t.classify_model || '', t.claimed_by || null,
          // 老 tasks.json 里没有这几个字段，缺了就是「已确认可开工、未归档、没记缺什么」。
          // 但 exportAll 会带上它们，所以原样导回去时这些状态不会丢。
          t.dev_ready === 0 || t.dev_ready === false ? 0 : 1,
          JSON.stringify(Array.isArray(t.dev_gaps) ? t.dev_gaps : []),
          t.archived_at || null,
          // v8 那 6 个：exportAll 会带，所以原样倒回去时编号和工时都不丢；
          // 老 tasks.json 没有它们，缺的（null）在循环结束后统一回填。
          Number.isFinite(Number(t.seq_no)) && Number(t.seq_no) > 0 ? Number(t.seq_no) : null,
          t.owner || null,
          Number.isFinite(Number(t.estimate_hours)) && Number(t.estimate_hours) >= 0 ? Number(t.estimate_hours) : null,
          Number.isFinite(Number(t.actual_hours)) && Number(t.actual_hours) >= 0 ? Number(t.actual_hours) : null,
          t.plan_start_at || null, t.plan_end_at || null,
          t.created_at, t.updated_at, t.doing_at || null, t.done_at || null
        ]
      );
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      for (const m of msgs) {
        const att = m.attachments && typeof m.attachments === 'object'
          && ((m.attachments.images || []).length || (m.attachments.files || []).length)
          ? JSON.stringify({ images: m.attachments.images || [], files: m.attachments.files || [] })
          : null;
        db.run(
          'INSERT OR REPLACE INTO messages (id, task_id, role, text, patch, attachments, at) VALUES (?,?,?,?,?,?,?)',
          [
            m.id || ('m_' + Math.random().toString(36).slice(2, 10)),
            t.id,
            m.role === 'assistant' ? 'assistant' : 'user',
            String(m.text || '').slice(0, 4000),
            m.patch && typeof m.patch === 'object' ? JSON.stringify(m.patch) : null,
            att,
            m.at || t.updated_at || t.created_at
          ]
        );
        msgCount++;
      }
    }

    // v8 的短编号回填：从 JSON 导入的任务没有 seq_no（老文件里没有这一列），
    // 按 created_at, rowid 排一遍补上 —— 和 MIGRATIONS[7] 的回填是同一个规则。
    // 有些任务可能从 exportAll 的导出里带着 seq_no 回来，所以起点接在
    // 已有最大值后面，不是从 1 硬来（否则会和带回来的编号撞车）。
    db.exec(`
      WITH base AS (
        SELECT COALESCE(MAX(seq_no), 0) AS m FROM tasks WHERE seq_no IS NOT NULL
      ), numbered AS (
        SELECT id, (SELECT m FROM base) + ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS rn
          FROM tasks WHERE seq_no IS NULL
      )
      UPDATE tasks SET seq_no = (SELECT rn FROM numbered WHERE numbered.id = tasks.id)
       WHERE seq_no IS NULL`);

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
