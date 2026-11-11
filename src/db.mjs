// SQLite 存储层。只依赖 node:sqlite（Node 24 内置，22.5+ 也可用）。
// 用文件路径打开，WAL 模式，允许多进程（hub + CLI）同时读写。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir, nowIso } from './util.mjs';

/** 未终结状态：同一 dedupe_key 在这些状态里出现就认为重复。 */
export const ACTIVE_STATUSES = ['queued', 'awaiting_approval', 'running', 'review'];
/** 终结状态。 */
export const FINAL_STATUSES = ['done', 'failed', 'rejected', 'accepted', 'interrupted'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  type         TEXT NOT NULL,
  subject      TEXT,
  summary      TEXT,
  link         TEXT,
  dedupe_key   TEXT,
  payload      TEXT,
  received_at  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'received',  -- received | queued | no_rule | duplicate | error
  rule_id      TEXT,
  job_id       TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_dedupe ON events(dedupe_key);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  event_id         TEXT,
  rule_id          TEXT,
  agent            TEXT,
  cwd              TEXT,
  status           TEXT NOT NULL,
  prompt           TEXT,
  transcript_path  TEXT,
  log_path         TEXT,
  last_message_file TEXT,
  last_message     TEXT,
  decision         TEXT,
  decision_note    TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  ended_at         TEXT,
  exit_code        INTEGER,
  error            TEXT,
  needs_attention  INTEGER NOT NULL DEFAULT 0,
  duplicate_count  INTEGER NOT NULL DEFAULT 0,
  dedupe_key       TEXT,
  approval         TEXT,
  notify_when      TEXT,
  model            TEXT,
  sandbox          TEXT,
  reasoning        TEXT,
  concurrency_key  TEXT,
  timeout_ms       INTEGER,
  command          TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key, status);

-- 规则文件加载记录（hash 变化即热加载）
CREATE TABLE IF NOT EXISTS rules_seen (
  path       TEXT PRIMARY KEY,
  hash       TEXT,
  mtime_ms   INTEGER,
  rule_count INTEGER,
  loaded_at  TEXT,
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/** 允许外部 patch 的列（防止拼 SQL 时注入）。 */
const JOB_COLUMNS = new Set([
  'status',
  'started_at',
  'ended_at',
  'exit_code',
  'error',
  'last_message',
  'transcript_path',
  'log_path',
  'last_message_file',
  'decision',
  'decision_note',
  'needs_attention',
  'duplicate_count',
  'command',
]);

export function openDb(dbPath) {
  const file = dbPath && dbPath !== ':memory:' ? dbPath : ':memory:';
  if (file !== ':memory:') ensureDir(path.dirname(file));
  const db = new DatabaseSync(file);
  // WAL：hub 与 CLI 两个进程同时读写不打架
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    /* 内存库不支持，忽略 */
  }
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

export function createStore(db) {
  const stmt = (sql) => db.prepare(sql);
  const cache = new Map();
  let closed = false;
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = stmt(sql);
      cache.set(sql, s);
    }
    return s;
  };

  // ---------- events ----------
  function insertEvent(ev) {
    prep(
      `INSERT INTO events (id, source, type, subject, summary, link, dedupe_key, payload, received_at, status, rule_id, job_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ev.id,
      ev.source,
      ev.type,
      ev.subject ?? null,
      ev.summary ?? null,
      ev.link ?? null,
      ev.dedupe_key ?? null,
      typeof ev.payload === 'string' ? ev.payload : ev.payload == null ? null : JSON.stringify(ev.payload),
      ev.received_at ?? nowIso(),
      ev.status ?? 'received',
      ev.rule_id ?? null,
      ev.job_id ?? null,
      ev.error ?? null,
    );
    return ev.id;
  }

  function updateEvent(id, patch) {
    const cols = ['status', 'rule_id', 'job_id', 'error'].filter((c) => c in patch);
    if (cols.length === 0) return;
    const sql = `UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    prep(sql).run(...cols.map((c) => patch[c] ?? null), id);
  }

  function getEvent(id) {
    return prep('SELECT * FROM events WHERE id = ?').get(id) ?? null;
  }

  function listEvents(limit = 50) {
    return prep('SELECT * FROM events ORDER BY received_at DESC LIMIT ?').all(limit);
  }

  // ---------- jobs ----------
  function insertJob(job) {
    prep(
      `INSERT INTO jobs (id, event_id, rule_id, agent, cwd, status, prompt, transcript_path, log_path,
        last_message_file, last_message, decision, decision_note, created_at, started_at, ended_at,
        exit_code, error, needs_attention, duplicate_count, dedupe_key, approval, notify_when,
        model, sandbox, reasoning, concurrency_key, timeout_ms, command)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.id,
      job.event_id ?? null,
      job.rule_id ?? null,
      job.agent ?? null,
      job.cwd ?? null,
      job.status ?? 'queued',
      job.prompt ?? null,
      job.transcript_path ?? null,
      job.log_path ?? null,
      job.last_message_file ?? null,
      job.last_message ?? null,
      job.decision ?? null,
      job.decision_note ?? null,
      job.created_at ?? nowIso(),
      job.started_at ?? null,
      job.ended_at ?? null,
      job.exit_code ?? null,
      job.error ?? null,
      job.needs_attention ? 1 : 0,
      job.duplicate_count ?? 0,
      job.dedupe_key ?? null,
      job.approval ?? null,
      Array.isArray(job.notify_when) ? JSON.stringify(job.notify_when) : job.notify_when ?? null,
      job.model ?? null,
      job.sandbox ?? null,
      job.reasoning ?? null,
      job.concurrency_key ?? null,
      job.timeout_ms ?? null,
      job.command ?? null,
    );
    return job.id;
  }

  function updateJob(id, patch) {
    const cols = Object.keys(patch).filter((c) => JOB_COLUMNS.has(c));
    if (cols.length === 0) return;
    const sql = `UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    const values = cols.map((c) => {
      const v = patch[c];
      if (c === 'needs_attention') return v ? 1 : 0;
      return v === undefined ? null : v;
    });
    prep(sql).run(...values, id);
  }

  function getJob(id) {
    return prep('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  function listJobs({ status, limit = 50, offset = 0 } = {}) {
    if (status) {
      const statuses = String(status)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const holes = statuses.map(() => '?').join(', ');
      return prep(
        `SELECT * FROM jobs WHERE status IN (${holes}) ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(...statuses, limit, offset);
    }
    return prep('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  function listQueued() {
    return prep("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC").all();
  }

  function countRunning() {
    return prep("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'").get().n;
  }

  function countRunningByKey(key) {
    if (!key) return 0;
    return prep("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND concurrency_key = ?").get(key).n;
  }

  function findActiveByDedupe(dedupeKey) {
    if (!dedupeKey) return null;
    const holes = ACTIVE_STATUSES.map(() => '?').join(', ');
    return (
      prep(
        `SELECT * FROM jobs WHERE dedupe_key = ? AND status IN (${holes})
         ORDER BY created_at ASC LIMIT 1`,
      ).get(dedupeKey, ...ACTIVE_STATUSES) ?? null
    );
  }

  function bumpDuplicate(jobId) {
    prep('UPDATE jobs SET duplicate_count = duplicate_count + 1 WHERE id = ?').run(jobId);
  }

  /**
   * 抢占式状态迁移：只有当前状态确实是 from 时才改成 running。
   * 多进程（hub + CLI）同时 tick 时靠这个避免同一个 job 被拉两次。
   */
  function claimJob(id, from = 'queued') {
    const res = prep('UPDATE jobs SET status = ?, started_at = ? WHERE id = ? AND status = ?').run(
      'running',
      nowIso(),
      id,
      from,
    );
    return res.changes === 1;
  }

  function countByStatus() {
    const rows = prep('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** 统计：状态计数 + 按规则分组的耗时 + 需要留意的数量。 */
  function stats() {
    const byStatus = countByStatus();
    const byRule = prep(
      `SELECT rule_id,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' OR status = 'accepted' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                       THEN (julianday(ended_at) - julianday(started_at)) * 86400000 END) AS avg_ms
       FROM jobs GROUP BY rule_id ORDER BY total DESC`,
    ).all();
    const attention = prep(
      "SELECT COUNT(*) AS n FROM jobs WHERE needs_attention = 1 AND status IN ('awaiting_approval','review')",
    ).get().n;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayCount = prep('SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ?').get(
      today.toISOString(),
    ).n;
    const total = prep('SELECT COUNT(*) AS n FROM jobs').get().n;
    return {
      total,
      today: todayCount,
      needsAttention: attention,
      byStatus,
      byRule: byRule.map((r) => ({
        rule_id: r.rule_id ?? 'no_rule',
        total: r.total,
        ok: r.ok ?? 0,
        failed: r.failed ?? 0,
        avgMs: r.avg_ms == null ? null : Math.round(r.avg_ms),
      })),
    };
  }

  /** 进程启动时把残留的 running 标成 interrupted（单机版：worker 即 hub）。 */
  function markRunningInterrupted(reason = '进程退出') {
    const res = prep(
      "UPDATE jobs SET status = 'interrupted', ended_at = ?, error = ? WHERE status = 'running'",
    ).run(nowIso(), reason);
    return res.changes;
  }

  // ---------- rules_seen ----------
  function saveRulesSeen(rec) {
    prep(
      `INSERT INTO rules_seen (path, hash, mtime_ms, rule_count, loaded_at, ok, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         hash = excluded.hash, mtime_ms = excluded.mtime_ms, rule_count = excluded.rule_count,
         loaded_at = excluded.loaded_at, ok = excluded.ok, error = excluded.error`,
    ).run(
      rec.path,
      rec.hash ?? null,
      rec.mtime_ms ?? null,
      rec.rule_count ?? null,
      rec.loaded_at ?? nowIso(),
      rec.ok === false ? 0 : 1,
      rec.error ?? null,
    );
  }

  function getRulesSeen(p) {
    return prep('SELECT * FROM rules_seen WHERE path = ?').get(p) ?? null;
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  /** 子进程回调可能在 close 之后才到，调用方用它避免 ERROR_INVALID_STATE。 */
  function isClosed() {
    return closed;
  }

  return {
    raw: db,
    isClosed,
    insertEvent,
    updateEvent,
    getEvent,
    listEvents,
    insertJob,
    updateJob,
    getJob,
    listJobs,
    listQueued,
    countRunning,
    countRunningByKey,
    findActiveByDedupe,
    bumpDuplicate,
    claimJob,
    countByStatus,
    stats,
    markRunningInterrupted,
    saveRulesSeen,
    getRulesSeen,
    close,
  };
}

/** 便捷入口：给路径直接拿到 store。 */
export function openStore(dbPath) {
  return createStore(openDb(dbPath));
}

export function dbFileExists(dbPath) {
  try {
    return fs.existsSync(dbPath);
  } catch {
    return false;
  }
}
