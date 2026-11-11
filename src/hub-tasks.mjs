// 任务面板的 API 路由。从 hub.mjs 里拆出来，避免那个文件继续膨胀。
//
// 约定：所有路由都用 /api/tasks* 前缀，和现有的 /api/jobs* 并存。
// 面板切换后，旧的 jobs 接口保留一个版本，方便回退。
import { createLogger, nowIso } from './util.mjs';

const log = createLogger('hub-tasks');

/** 把一行 task 变成面板要的视图。 */
export function taskView(task, tasks, { full = false } = {}) {
  if (!task) return null;
  const run = tasks.latestRun(task.id);
  const runs = full ? tasks.listRuns(task.id) : null;
  const deps = tasks.listDeps(task.id);
  const children = full ? tasks.listChildren(task.id) : null;

  const depInfo = deps.map((id) => {
    const d = tasks.getTask(id);
    return { id, title: d?.title ?? '(已删除)', status: d?.status ?? 'unknown' };
  });

  const view = {
    id: task.id,
    project_id: task.project_id,
    parent_id: task.parent_id,
    root_id: task.root_id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    agent: task.agent,
    model: task.model,
    cwd: task.cwd,
    effect: task.effect,
    approval: task.approval,
    source: task.source,
    attempt: task.attempt,
    max_attempts: task.max_attempts,
    created_at: task.created_at,
    started_at: task.started_at,
    ended_at: task.ended_at,
    // 依赖：面板上要能看见「等 2 个前置」
    deps: depInfo,
    depsWaiting: depInfo.filter((d) => d.status !== 'done').length,
    session_id: task.session_id,
    duration_ms: task.started_at && task.ended_at
      ? new Date(task.ended_at).getTime() - new Date(task.started_at).getTime()
      : null,
    run: run
      ? {
          id: run.id,
          attempt: run.attempt,
          status: run.status,
          exit_code: run.exit_code,
          last_message: run.last_message,
          error: run.error,
          needs_attention: !!run.needs_attention,
        }
      : null,
  };

  if (full) {
    view.body = task.body;
    view.done_when = task.done_when;
    view.prompt = run?.prompt ?? null;
    view.log_path = run?.log_path ?? null;
    view.transcript_path = run?.transcript_path ?? null;
    view.runs = (runs ?? []).map((r) => ({
      id: r.id, attempt: r.attempt, status: r.status, exit_code: r.exit_code,
      error: r.error, started_at: r.started_at, ended_at: r.ended_at,
      agent_session_id: r.agent_session_id,
    }));
    view.children = (children ?? []).map((c) => ({
      id: c.id, title: c.title, status: c.status, priority: c.priority,
    }));
    // 时间线：整条链，不只看自己
    view.timeline = tasks.listTimelineTree(task.root_id ?? task.id, 200).map((e) => ({
      seq: e.seq, at: e.at, actor: e.actor, action: e.action, detail: e.detail,
    }));
  }
  return view;
}

/** 群视图。 */
export function groupView(group, tasks, { withMessages = 0 } = {}) {
  if (!group) return null;
  const msgs = withMessages > 0 ? tasks.listMessages(group.id, { limit: withMessages }) : [];
  return {
    id: group.id,
    kind: group.kind,
    scope_id: group.scope_id,
    name: group.name,
    created_at: group.created_at,
    messages: msgs.map((m) => ({
      id: m.id, sender_kind: m.sender_kind, sender_id: m.sender_id,
      task_id: m.task_id, run_id: m.run_id, body: m.body, created_at: m.created_at,
    })),
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 挂任务路由。
 * @param {object} ctx { req, res, method, pathname, url, tasks, sched, readBody }
 * @returns {boolean} 处理了就返回 true，没匹配上返回 false 让 hub 继续试
 */
export async function handleTaskRoutes(ctx) {
  const { req, res, method, pathname, url, tasks, sched, readBody, ingest } = ctx;

  // ---------- 总览 ----------
  if (method === 'GET' && pathname === '/api/tasks/state') {
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 300) || 300, 1000);
    const list = tasks.listTasks({ status: status || undefined, limit });
    const stats = tasks.stats();
    const todos = tasks.listTodos({ status: 'open', limit: 50 });
    const groups = tasks.listGroups().map((g) => {
      const last = tasks.listMessages(g.id, { limit: 1 });
      return {
        id: g.id, kind: g.kind, scope_id: g.scope_id, name: g.name,
        last_message: last[0]?.body ?? null,
        last_at: last[0]?.created_at ?? null,
      };
    });
    sendJson(res, 200, {
      ok: true,
      tasks: list.map((t) => taskView(t, tasks)),
      stats,
      todos: todos.map((t) => ({
        id: t.id, kind: t.kind, task_id: t.task_id, title: t.title,
        detail: t.detail, options: t.options, created_at: t.created_at,
      })),
      groups,
      projects: tasks.listProjects(),
      now: nowIso(),
    });
    return true;
  }

  // ---------- 单个任务详情 ----------
  const detail = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && detail && detail[1] !== 'state') {
    const task = tasks.getTask(detail[1]);
    if (!task) { sendJson(res, 404, { ok: false, error: '任务不存在' }); return true; }
    const withMessages = Math.min(Number(url.searchParams.get('messages') ?? 100) || 100, 500);
    const groups = tasks.listGroups().filter(
      (g) => g.scope_id === (task.root_id ?? task.id) || g.scope_id === task.project_id || g.scope_id === task.id,
    );
    sendJson(res, 200, {
      ok: true,
      task: taskView(task, tasks, { full: true }),
      groups: groups.map((g) => groupView(g, tasks, { withMessages })),
    });
    return true;
  }

  // ---------- 动作 ----------
  const action = /^\/api\/tasks\/([^/]+)\/(approve|reject|priority|rerun)$/.exec(pathname);
  if (method === 'POST' && action) {
    const [, taskId, verb] = action;
    let body = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch { body = {}; }

    try {
      let result;
      if (verb === 'approve') result = sched.approve(taskId, body.note ?? null);
      else if (verb === 'reject') result = sched.reject(taskId, body.note ?? null);
      else if (verb === 'priority') {
        result = sched.updateTask(taskId, { priority: body.priority });
      } else if (verb === 'rerun') {
        // 把任务退回 ready 重新排队
        const t = tasks.getTask(taskId);
        if (!t) throw new Error('任务不存在');
        if (['running', 'queued'].includes(t.status)) throw new Error('正在执行，不能重跑');
        tasks.updateTask(taskId, { status: 'ready', ended_at: null });
        tasks.logEvent({ task_id: taskId, actor: 'human', action: 'rerun', detail: body.note ?? null });
        result = { status: 'ready' };
      }
      sendJson(res, 200, { ok: true, ...result, task: taskView(tasks.getTask(taskId), tasks, { full: true }) });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  // ---------- 新建任务 ----------
  if (method === 'POST' && pathname === '/api/tasks') {
    let body = {};
    try {
      const text = await readBody(req);
      body = JSON.parse(text || '{}');
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `JSON 解析失败: ${err.message}` });
      return true;
    }
    // 编码校验：如果请求体不是 UTF-8，JSON.parse 后会出现 U+FFFD 替换字符。
    // 这种标题存进去就是乱码，宁可拒绝也不落库。
    const joined = [body.title, body.body, body.project].filter(Boolean).join(' ');
    if (joined.includes('�')) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法的 UTF-8，标题已损坏。请确认发送端用 UTF-8 编码。' });
      return true;
    }

    if (!body.title || !String(body.title).trim()) {
      sendJson(res, 400, { ok: false, error: '缺少 title' });
      return true;
    }
    try {
      // 走入口：立刻返回 inbox，拆解在后台跑（拆一次要 7~25 秒，不能卡住请求）
      const r = ingest.accept({
        title: String(body.title).trim(),
        body: body.body ?? null,
        cwd: body.cwd ?? null,
        project: body.project ?? null,
        priority: body.priority ?? 0,
        source: body.source ?? 'panel',
      });
      sendJson(res, 200, {
        ok: true, id: r.id,
        task: taskView(tasks.getTask(r.id), tasks, { full: true }),
        planning: true,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  // ---------- 拆解审批 ----------
  // 形如 /api/tasks/<id>/plan/approve
  const pparts = pathname.split('/').filter(Boolean);
  if (method === 'POST' && pparts.length === 5 &&
      pparts[0] === 'api' && pparts[1] === 'tasks' && pparts[3] === 'plan') {
    const tid = pparts[2];
    const verb = pparts[4];
    try {
      if (verb === 'approve') {
        const n = ingest.approvePlan(tid);
        sendJson(res, 200, { ok: true, released: n });
      } else if (verb === 'reject') {
        const n = ingest.rejectPlan(tid);
        sendJson(res, 200, { ok: true, rejected: n });
      } else {
        sendJson(res, 400, { ok: false, error: '未知动作: ' + verb });
      }
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  // ---------- 待办 ----------
  const todoParts = pathname.split('/').filter(Boolean);
  // 形如 /api/todos/<id>/resolve
  if (method === 'POST' && todoParts.length === 4 &&
      todoParts[0] === 'api' && todoParts[1] === 'todos' && todoParts[3] === 'resolve') {
    const todoId = todoParts[2];
    let body = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch { body = {}; }
    const okRes = body.resolution === 'reject' ? tasks.dismissTodo(todoId)
      : tasks.resolveTodo(todoId, body.resolution ?? 'approve');
    sendJson(res, okRes ? 200 : 400, { ok: okRes, error: okRes ? undefined : '待办不存在或已处理' });
    return true;
  }

  // ---------- 群消息 ----------
  const groupMsg = /^\/api\/groups\/([^/]+)\/messages$/.exec(pathname);
  if (groupMsg) {
    const groupId = groupMsg[1];
    const group = tasks.getGroup(groupId);
    if (!group) { sendJson(res, 404, { ok: false, error: '群不存在' }); return true; }

    if (method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
      sendJson(res, 200, { ok: true, group: groupView(group, tasks, { withMessages: limit }) });
      return true;
    }
    if (method === 'POST') {
      let body = {};
      try {
        const text = await readBody(req);
        body = JSON.parse(text || '{}');
      } catch { body = {}; }
      if (!body.body || !String(body.body).trim()) {
        sendJson(res, 400, { ok: false, error: '消息内容为空' });
        return true;
      }
      const id = tasks.addMessage({
        group_id: groupId,
        sender_kind: 'human',
        body: String(body.body).trim(),
      });
      log.info(`人往群 ${group.name} 发了一条消息`);
      sendJson(res, 200, { ok: true, id });
      return true;
    }
  }

  return false;
}
