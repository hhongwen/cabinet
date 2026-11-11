// 任务编排层的表定义。和 events/jobs 分开维护，便于迁移期两套并存。
//
// 设计原则（见 DESIGN.md 第二节）：
//   每次状态变化都能追溯到一条记录 → timeline 只追加不改
//   blocked 状态是算出来的，不落库 → 避免「前置完成但忘记解锁」
export const TASK_SCHEMA = `
-- 项目：cwd 就是边界
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  cwd             TEXT NOT NULL UNIQUE,
  max_concurrency INTEGER,
  first_run       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

-- 任务：可嵌套（拆解产物）
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  parent_id   TEXT,
  root_id     TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  status      TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  agent       TEXT,
  model       TEXT,
  reasoning   TEXT,
  cwd         TEXT,
  done_when   TEXT,
  effect      TEXT,
  approval    TEXT,
  session_id  TEXT,
  source      TEXT,
  source_ref  TEXT,
  attempt     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  sort_key    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  ended_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project  ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_root     ON tasks(root_id);
CREATE INDEX IF NOT EXISTS idx_tasks_ready    ON tasks(status, priority DESC, sort_key ASC);

-- 依赖：task 依赖 depends_on
CREATE TABLE IF NOT EXISTS task_deps (
  task_id    TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_deps_target ON task_deps(depends_on);

-- 执行尝试：一个 task 可以跑多次
CREATE TABLE IF NOT EXISTS task_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 1,
  agent            TEXT,
  model            TEXT,
  agent_session_id TEXT,
  status           TEXT NOT NULL,
  prompt           TEXT,
  last_message     TEXT,
  exit_code        INTEGER,
  error            TEXT,
  transcript_path  TEXT,
  log_path         TEXT,
  needs_attention  INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT,
  ended_at         TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_task   ON task_runs(task_id, attempt DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON task_runs(status);

-- 群：kind 决定挂在哪
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  scope_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, scope_id)
);

-- 消息
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  sender_id   TEXT,
  task_id     TEXT,
  run_id      TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_group ON messages(group_id, created_at);

-- 已读水位：哪个 session 读到了哪条消息
CREATE TABLE IF NOT EXISTS message_reads (
  group_id   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_msg_id TEXT,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (group_id, session_id)
);

-- 待办：所有等人拍板的事
CREATE TABLE IF NOT EXISTS todos (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  task_id     TEXT,
  run_id      TEXT,
  title       TEXT NOT NULL,
  detail      TEXT,
  options     TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  resolution  TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status, created_at DESC);

-- 时间线：只追加
CREATE TABLE IF NOT EXISTS timeline (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  run_id  TEXT,
  at      TEXT NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeline_task ON timeline(task_id, seq);
`;

/**
 * 幂等索引：同一个来源的同一条外部消息只允许建一个任务。
 *
 * 单独拿出来是因为它可能在老库上建失败 —— 如果历史上已经存在重复数据，
 * 唯一索引建不下去。那种情况不能把整个启动搞崩，降级成「没有这个约束」，
 * 应用层仍然会先查一次。
 */
export const IDEMPOTENCY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_ref
  ON tasks(source, source_ref) WHERE source_ref IS NOT NULL;
`;
