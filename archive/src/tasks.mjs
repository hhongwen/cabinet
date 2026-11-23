// 任务存储层。只做 CRUD + 状态迁移，不含调度决策。
// 调度在 scheduler.mjs，拆解在 planner.mjs。
import { TASK_SCHEMA, IDEMPOTENCY_INDEX } from './schema-tasks.mjs';
import { createLogger, nowIso, newId } from './util.mjs';

const log = createLogger('tasks');

/** 任务状态。blocked 不在这里——它是算出来的。 */
export const TASK_STATUSES = [
  'inbox',            // 收到，待拆解
  'awaiting_plan',    // 拆解完成但模糊，等人审
  'ready',            // 可调度
  'queued',           // 已建 run，等 worker
  'running',
  'review',           // 跑完要人看一眼
  'done',
  'failed',
  'rejected',
  'interrupted',
];

/** 终结态。 */
export const TASK_FINAL = ['done', 'failed', 'rejected'];

/** run 的状态沿用原来 job 的 7 个。 */
export const RUN_STATUSES = [
  'queued',
  'awaiting_approval',
  'running',
  'done',
  'failed',
  'review',
  'interrupted',
];

/** 允许外部 patch 的列，防 SQL 注入。 */
const TASK_COLUMNS = new Set([
  'status',
  'priority',
  'agent',
  'model',
  'reasoning',
  'cwd',
  'done_when',
  'effect',
  'approval',
  'session_id',
  'attempt',
  'started_at',
  'ended_at',
  'title',
  'body',
  'sort_key',
]);

export function ensureTaskSchema(db) {
  db.exec(TASK_SCHEMA);
  // 幂等索引单独建：老库里如果已有重复数据会失败，
  // 那种情况降级成「没有约束」，不能把启动搞崩
  try {
    db.exec(IDEMPOTENCY_INDEX);
  } catch (err) {
    log.warn(`幂等索引建不了（老库里可能已有重复数据）: ${err.message}`);
  }
}

export function createTaskStore(db) {
  const cache = new Map();
  let closed = false;

  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  const run = (sql, ...args) => prep(sql).run(...args);
  const get = (sql, ...args) => prep(sql).get(...args) ?? null;
  const all = (sql, ...args) => prep(sql).all(...args);

  // ---------- projects ----------

  function upsertProject({ id, name, cwd, maxConcurrency = null }) {
    const existing = get('SELECT * FROM projects WHERE cwd = ?', cwd);
    if (existing) return existing;
    const row = {
      id: id ?? newId('prj'),
      name: name ?? cwd,
      cwd,
      max_concurrency: maxConcurrency,
      first_run: 1,
      created_at: nowIso(),
    };
    run(
      `INSERT INTO projects (id, name, cwd, max_concurrency, first_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      row.name,
      row.cwd,
      row.max_concurrency,
      row.first_run,
      row.created_at,
    );
    return row;
  }

  function getProject(id) {
    return get('SELECT * FROM projects WHERE id = ?', id);
  }

  function listProjects() {
    return all('SELECT * FROM projects ORDER BY created_at ASC');
  }

  // ---------- tasks ----------

  function insertTask(t) {
    const row = {
      id: t.id ?? newId('task'),
      project_id: t.project_id ?? null,
      parent_id: t.parent_id ?? null,
      root_id: t.root_id ?? t.parent_id ?? null,
      title: t.title ?? '(无标题)',
      body: t.body ?? null,
      status: t.status ?? 'inbox',
      priority: Number(t.priority) || 0,
      agent: t.agent ?? null,
      model: t.model ?? null,
      reasoning: t.reasoning ?? null,
      cwd: t.cwd ?? null,
      done_when: t.done_when ?? null,
      effect: t.effect ?? null,
      approval: t.approval ?? 'never',
      session_id: t.session_id ?? null,
      source: t.source ?? null,
      source_ref: t.source_ref ?? null,
      attempt: 0,
      max_attempts: Number(t.max_attempts) > 0 ? Number(t.max_attempts) : 3,
      sort_key: t.sort_key ?? Date.now(),
      created_at: t.created_at ?? nowIso(),
    };
    // 根任务自己是自己的 root
    if (!row.root_id) row.root_id = row.id;

    run(
      `INSERT INTO tasks (id, project_id, parent_id, root_id, title, body, status, priority,
        agent, model, reasoning, cwd, done_when, effect, approval, session_id, source,
        source_ref, attempt, max_attempts, sort_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.project_id, row.parent_id, row.root_id, row.title, row.body, row.status,
      row.priority, row.agent, row.model, row.reasoning, row.cwd, row.done_when, row.effect,
      row.approval, row.session_id, row.source, row.source_ref, row.attempt,
      row.max_attempts, row.sort_key, row.created_at,
    );
    return row.id;
  }

  function updateTask(id, patch) {
    const cols = Object.keys(patch).filter((c) => TASK_COLUMNS.has(c));
    if (cols.length === 0) return false;
    const sql = `UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    const res = run(sql, ...cols.map((c) => (patch[c] === undefined ? null : patch[c])), id);
    return res.changes === 1;
  }

  /**
   * 抢占式迁态：只有当前状态确实是 from 才改成 to。
   * 多进程 / tick 重叠时靠这个避免同一个 task 被拉两次。
   * 这是原 claimJob 的思路，直接沿用。
   */
  function claimTask(id, from = 'ready', to = 'running') {
    const res = run(
      "UPDATE tasks SET status = ?, started_at = ? WHERE id = ? AND status = ?",
      to, nowIso(), id, from,
    );
    return res.changes === 1;
  }

  function getTask(id) {
    return get('SELECT * FROM tasks WHERE id = ?', id);
  }

  function listTasks({ status, projectId, parentId, rootId, limit = 100, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (status) {
      const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) {
        where.push(`status IN (${list.map(() => '?').join(', ')})`);
        args.push(...list);
      }
    }
    if (projectId) { where.push('project_id = ?'); args.push(projectId); }
    if (parentId) { where.push('parent_id = ?'); args.push(parentId); }
    if (rootId) { where.push('root_id = ?'); args.push(rootId); }
    const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY priority DESC, sort_key ASC LIMIT ? OFFSET ?`;
    return all(sql, ...args, limit, offset);
  }

  /** 该任务的所有子任务（直接子级）。 */
  /**
   * 按外部消息查已建的任务。幂等的核心。
   * @returns {object|null}
   */
  function findBySourceRef(source, sourceRef) {
    if (!sourceRef) return null;
    return get(
      'SELECT * FROM tasks WHERE source = ? AND source_ref = ? ORDER BY created_at ASC LIMIT 1',
      source, sourceRef,
    );
  }

  function listChildren(taskId) {
    return all('SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_key ASC', taskId);
  }

  // ---------- 依赖 ----------

  function addDep(taskId, dependsOn) {
    if (taskId === dependsOn) return false;
    run('INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)', taskId, dependsOn);
    return true;
  }

  function listDeps(taskId) {
    return all('SELECT depends_on FROM task_deps WHERE task_id = ?', taskId).map((r) => r.depends_on);
  }

  /** 谁依赖我（反向）。删任务时检查用。 */
  function listDependents(taskId) {
    return all('SELECT task_id FROM task_deps WHERE depends_on = ?', taskId).map((r) => r.task_id);
  }

  /**
   * 依赖是否全部满足。
   * 判据：每个前置任务都必须是 done。
   * rejected / failed 都算不满足 —— 下游不该在前置失败时照跑。
   */
  function depsSatisfied(taskId) {
    const deps = listDeps(taskId);
    if (deps.length === 0) return { ok: true, waiting: [] };
    const holes = deps.map(() => '?').join(', ');
    const rows = all(`SELECT id, status FROM tasks WHERE id IN (${holes})`, ...deps);
    const waiting = rows.filter((r) => r.status !== 'done');
    return { ok: waiting.length === 0, waiting };
  }

  /** 防环：加新依赖后，检查 dependsOn 的祖先链里有没有自己。 */
  function wouldCycle(taskId, dependsOn) {
    const seen = new Set();
    const stack = [dependsOn];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...listDeps(cur));
    }
    return false;
  }

  // ---------- runs ----------

  function insertRun(r) {
    const row = {
      id: r.id ?? newId('run'),
      task_id: r.task_id,
      attempt: Number(r.attempt) || 1,
      agent: r.agent ?? null,
      model: r.model ?? null,
      agent_session_id: r.agent_session_id ?? null,
      status: r.status ?? 'queued',
      prompt: r.prompt ?? null,
      transcript_path: r.transcript_path ?? null,
      log_path: r.log_path ?? null,
      created_at: nowIso(),
    };
    run(
      `INSERT INTO task_runs (id, task_id, attempt, agent, model, agent_session_id, status,
        prompt, transcript_path, log_path, needs_attention, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      row.id, row.task_id, row.attempt, row.agent, row.model, row.agent_session_id,
      row.status, row.prompt, row.transcript_path, row.log_path, row.created_at,
    );
    return row.id;
  }

  function updateRun(id, patch) {
    const cols = Object.keys(patch).filter((c) =>
      ['status', 'agent_session_id', 'last_message', 'exit_code', 'error',
        'transcript_path', 'log_path', 'needs_attention', 'started_at', 'ended_at'].includes(c));
    if (cols.length === 0) return false;
    const sql = `UPDATE task_runs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    const values = cols.map((c) => {
      if (c === 'needs_attention') return patch[c] ? 1 : 0;
      return patch[c] === undefined ? null : patch[c];
    });
    return run(sql, ...values, id).changes === 1;
  }

  function getRun(id) {
    return get('SELECT * FROM task_runs WHERE id = ?', id);
  }

  function listRuns(taskId) {
    return all('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt DESC', taskId);
  }

  function latestRun(taskId) {
    return get('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1', taskId);
  }

  function countRunning() {
    return get("SELECT COUNT(*) AS n FROM task_runs WHERE status = 'running'").n;
  }

  function countRunningByAgent(agent) {
    return get(
      "SELECT COUNT(*) AS n FROM task_runs WHERE status = 'running' AND agent = ?", agent,
    ).n;
  }

  // ---------- 调度查询 ----------

  /**
   * 所有 ready 的任务，按优先级排序。
   * 依赖是否满足不在这里过滤——交给调用方用 depsSatisfied 现算，
   * 这样「前置刚完成」的下一 tick 就能被捞到，不依赖任何落库的 blocked 标记。
   */
  function listReady(limit = 200) {
    return all(
      "SELECT * FROM tasks WHERE status = 'ready' ORDER BY priority DESC, sort_key ASC LIMIT ?",
      limit,
    );
  }

  /** 有待办的任务（给面板用）。 */
  function listNeedingAttention() {
    return all(
      `SELECT * FROM tasks WHERE status IN ('review', 'awaiting_plan', 'failed')
       ORDER BY priority DESC, sort_key ASC`,
    );
  }

  // ---------- groups & messages ----------

  function upsertGroup({ kind, scope_id, name }) {
    const existing = get('SELECT * FROM groups WHERE kind = ? AND scope_id = ?', kind, scope_id);
    if (existing) return existing.id;
    const id = newId('grp');
    run(
      'INSERT INTO groups (id, kind, scope_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
      id, kind, scope_id, name, nowIso(),
    );
    return id;
  }

  function getGroupByScope(kind, scopeId) {
    return get('SELECT * FROM groups WHERE kind = ? AND scope_id = ?', kind, scopeId);
  }

  function getGroup(id) {
    return get('SELECT * FROM groups WHERE id = ?', id);
  }

  function listGroups() {
    return all('SELECT * FROM groups ORDER BY created_at ASC');
  }

  function addMessage({ group_id, sender_kind, sender_id = null, task_id = null, run_id = null, body }) {
    const id = newId('msg');
    run(
      `INSERT INTO messages (id, group_id, sender_kind, sender_id, task_id, run_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, group_id, sender_kind, sender_id, task_id, run_id, String(body ?? ''), nowIso(),
    );
    return id;
  }

  function listMessages(groupId, { limit = 200, afterId = null, since = null } = {}) {
    if (since) {
      return all(
        'SELECT * FROM messages WHERE group_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?',
        groupId, since, limit,
      );
    }
    return all(
      'SELECT * FROM messages WHERE group_id = ? ORDER BY created_at ASC LIMIT ?',
      groupId, limit,
    );
  }

  /** 某 session 在某群里的读水位。 */
  function getReadWatermark(groupId, sessionId) {
    return get(
      'SELECT * FROM message_reads WHERE group_id = ? AND session_id = ?', groupId, sessionId,
    );
  }

  function setReadWatermark(groupId, sessionId, lastMsgId) {
    run(
      `INSERT INTO message_reads (group_id, session_id, last_msg_id, read_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(group_id, session_id) DO UPDATE SET
         last_msg_id = excluded.last_msg_id, read_at = excluded.read_at`,
      groupId, sessionId, lastMsgId ?? null, nowIso(),
    );
  }

  /**
   * 某 session 还没读的消息。
   * 水位之后的所有消息，按时间升序。没有水位就从第一条开始。
   */
  function unreadMessages(groupId, sessionId, limit = 50, { senderKinds = null } = {}) {
    const wm = getReadWatermark(groupId, sessionId);
    // 只喂人和别的 session 说的话。系统自己发的进度播报不是给 agent 的输入，
    // 否则「▶ 开始执行」会被当成人类指令回灌给它。
    const kinds = senderKinds ?? ['human', 'session'];
    const holes = kinds.map(() => '?').join(', ');
    if (!wm?.read_at) {
      return all(
        `SELECT * FROM messages WHERE group_id = ? AND sender_kind IN (${holes})
          ORDER BY created_at ASC LIMIT ?`,
        groupId, ...kinds, limit,
      );
    }
    return all(
      `SELECT * FROM messages WHERE group_id = ? AND created_at > ? AND sender_kind IN (${holes})
        ORDER BY created_at ASC LIMIT ?`,
      groupId, wm.read_at, ...kinds, limit,
    );
  }

  // ---------- todos ----------

  function addTodo({ kind, task_id = null, run_id = null, title, detail = null, options = null }) {
    const id = newId('todo');
    run(
      `INSERT INTO todos (id, kind, task_id, run_id, title, detail, options, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      id, kind, task_id, run_id, title, detail,
      options == null ? null : JSON.stringify(options), nowIso(),
    );
    return id;
  }

  function resolveTodo(id, resolution) {
    return run(
      "UPDATE todos SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
      resolution ?? null, nowIso(), id,
    ).changes === 1;
  }

  function dismissTodo(id) {
    return run(
      "UPDATE todos SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'open'",
      nowIso(), id,
    ).changes === 1;
  }

  function getTodo(id) {
    return get('SELECT * FROM todos WHERE id = ?', id);
  }

  function listTodos({ status = 'open', limit = 100 } = {}) {
    if (status) {
      return all(
        'SELECT * FROM todos WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, limit,
      );
    }
    return all('SELECT * FROM todos ORDER BY created_at DESC LIMIT ?', limit);
  }

  function countOpenTodos() {
    return get("SELECT COUNT(*) AS n FROM todos WHERE status = 'open'").n;
  }

  // ---------- timeline ----------

  function logEvent({ task_id = null, run_id = null, actor = 'system', action, detail = null }) {
    run(
      'INSERT INTO timeline (task_id, run_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)',
      task_id, run_id, nowIso(), actor, action, detail,
    );
  }

  function listTimeline(taskId, limit = 200) {
    return all('SELECT * FROM timeline WHERE task_id = ? ORDER BY seq ASC LIMIT ?', taskId, limit);
  }

  /**
   * 整条任务链的时间线：根任务 + 所有后代。
   * 面板要看的是「这件事从进来到结束」，而不是某个子节点自己那几条。
   */
  function listTimelineTree(rootId, limit = 500) {
    return all(
      `SELECT * FROM timeline
       WHERE task_id = ? OR task_id IN (
         WITH RECURSIVE sub(id) AS (
           SELECT id FROM tasks WHERE root_id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
         ) SELECT id FROM sub
       ) ORDER BY seq ASC LIMIT ?`,
      rootId, rootId, limit,
    );
  }

  // ---------- 统计 ----------

  function stats() {
    const byStatus = {};
    for (const r of all('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')) {
      byStatus[r.status] = r.n;
    }
    const byProject = all(
      `SELECT p.id, p.name, COUNT(t.id) AS total,
              SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
       FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
       GROUP BY p.id ORDER BY total DESC`,
    );
    const openTodos = countOpenTodos();
    const running = get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").n;
    const total = get('SELECT COUNT(*) AS n FROM tasks').n;
    return { total, byStatus, byProject, openTodos, running };
  }

  function close() {
    if (closed) return;
    closed = true;
    cache.clear();
  }

  function isClosed() {
    return closed;
  }

  return {
    // projects
    upsertProject, getProject, listProjects,
    // tasks
    insertTask, updateTask, claimTask, getTask, listTasks, listChildren, findBySourceRef,
    // deps
    addDep, listDeps, listDependents, depsSatisfied, wouldCycle,
    // runs
    insertRun, updateRun, getRun, listRuns, latestRun, countRunning, countRunningByAgent,
    // 调度查询
    listReady, listNeedingAttention,
    // groups & messages
    upsertGroup, getGroupByScope, getGroup, listGroups,
    addMessage, listMessages, getReadWatermark, setReadWatermark, unreadMessages,
    // todos
    addTodo, resolveTodo, dismissTodo, getTodo, listTodos, countOpenTodos,
    // timeline
    logEvent, listTimeline, listTimelineTree,
    // 其他
    stats, close, isClosed,
  };
}
