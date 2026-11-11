// 任务入口：把一句话变成任务图。
//
// 流程（DESIGN.md 3.x）：
//   收下 → 建 inbox 任务 → 立刻返回（不让用户等）
//                          ↓ 后台
//                       拆解 → 落库 → ready
//                          ↓
//                    需要人审就进待办
//
// 为什么立刻返回：拆解要 7~25 秒，串在入口上「发消息→看到任务」会卡很久。
import { createLogger, nowIso } from './util.mjs';

const log = createLogger('ingest');

/**
 * @param {object} deps { tasks, planner, magpie, sched }
 */
export function createIngest({ tasks, planner, magpie, sched = null }) {

  /** store 可能在后台拆解途中被关闭（进程退出），所有写操作前都要过这一关。 */
  function safe(fn, fallback = null) {
    if (tasks.isClosed?.()) return fallback;
    try {
      return fn();
    } catch (err) {
      if (/database is not open|finalized/i.test(err.message)) {
        log.warn('库已关闭，跳过写操作');
        return fallback;
      }
      throw err;
    }
  }

  /** 正在拆的 task id，防重复。 */
  const planning = new Set();

  /**
   * 收一个任务。立刻返回 inbox 任务 id，拆解在后台跑。
   * @returns {{id: string, status: 'inbox'}}
   */
  function accept({ title, body = null, cwd = null, project = null, priority = 0, source = 'panel', sourceRef = null }) {
    let proj = null;
    if (cwd) proj = tasks.upsertProject({ name: project ?? cwd, cwd: String(cwd) });

    const id = tasks.insertTask({
      project_id: proj?.id ?? null,
      title: String(title ?? '').trim() || '(无标题)',
      body,
      cwd: cwd ?? proj?.cwd ?? null,
      status: 'inbox',
      priority: Number(priority) || 0,
      source,
      source_ref: sourceRef,
    });

    tasks.logEvent({
      task_id: id, actor: source === 'feishu' ? 'human' : 'human',
      action: 'created', detail: `来自 ${source}`,
    });

    // 后台拆解，不阻塞调用方
    planInBackground(id, { project: proj });

    return { id, status: 'inbox' };
  }

  /** 起一个后台拆解。同一个 task 不会被拆两次。 */
  function planInBackground(taskId, ctx = {}) {
    if (planning.has(taskId)) return null;
    if (!planner) {
      log.warn('没有 planner，任务停在 inbox');
      return null;
    }
    planning.add(taskId);

    const p = (async () => {
      try {
        await planTask(taskId, ctx);
      } catch (err) {
        // 进程正在退出时库已关，这是正常情况，不该刷错误日志
        if (tasks.isClosed?.() || /database is not open|finalized/i.test(err.message)) {
          log.warn(`拆解 task ${taskId} 途中库已关闭，放弃收尾`);
          return;
        }
        log.error(`拆解 task ${taskId} 失败: ${err.message}`);
        // 拆解崩了也要让人看见，不能静默
        safe(() => tasks.updateTask(taskId, { status: 'awaiting_plan' }));
        safe(() => tasks.addTodo({
          kind: 'plan_review', task_id: taskId,
          title: `拆解失败，需人工处理：${tasks.getTask(taskId)?.title ?? taskId}`,
          detail: err.message,
        }));
      } finally {
        planning.delete(taskId);
      }
    })();
    return p;
  }

  /** 拆一个任务并落库。 */
  async function planTask(taskId, ctx = {}) {
    if (tasks.isClosed?.()) return null;
    const task = tasks.getTask(taskId);
    if (!task) return null;
    if (task.status !== 'inbox') {
      log.debug(`task ${taskId} 状态是 ${task.status}，跳过拆解`);
      return null;
    }

    // 已有人工建好的子任务就不重复拆
    const existing = tasks.listChildren(taskId);
    if (existing.length > 0) {
      log.info(`task ${taskId} 已有 ${existing.length} 个子任务，不重复拆`);
      tasks.updateTask(taskId, { status: 'done' });
      return { reused: true };
    }

    // 给拆解器一点上下文：有哪些 agent、哪些模型
    const models = magpie ? await magpie.listModels() : null;
    const agentNames = ['codex', 'opencode'];

    const res = await planner.plan(task, {
      project: ctx.project ?? (task.project_id ? tasks.getProject(task.project_id) : null),
      agents: agentNames,
      models: models?.groups?.map((g) => g.id).slice(0, 5) ?? [],
      siblings: tasks.listTasks({ status: 'ready', limit: 5 }),
    });

    tasks.logEvent({
      task_id: taskId, actor: 'system', action: 'planned',
      detail: res.ok
        ? `kind=${res.plan.kind} 子任务=${res.plan.tasks?.length ?? 0} 耗时=${res.attempts}次`
        : `拆解失败: ${res.error}`,
    });

    if (!res.ok) {
      tasks.updateTask(taskId, { status: 'awaiting_plan' });
      tasks.addTodo({
        kind: 'plan_review', task_id: taskId,
        title: `拆解失败：${task.title}`,
        detail: `${res.error}\n\n原始输出：\n${String(res.raw ?? '').slice(0, 800)}`,
      });
      return { ok: false };
    }

    const plan = res.plan;

    // 原子任务：不拆，本身就是要执行的
    if (plan.kind === 'atomic') {
      const s0 = plan.tasks[0] ?? {};
      tasks.updateTask(taskId, {
        status: res.needsReview ? 'awaiting_plan' : 'ready',
        agent: s0.agent ?? task.agent ?? 'codex',
        model: s0.model ?? task.model ?? null,
        done_when: s0.done_when ?? task.done_when ?? null,
        effect: s0.effect ?? 'read_only',
        cwd: task.cwd ?? s0.cwd ?? null,
      });
      if (res.needsReview) {
        addPlanTodo(taskId, res);
      }
      return { ok: true, kind: 'atomic', needsReview: res.needsReview };
    }

    // 计划：建子任务 + 依赖
    const ids = [];
    for (const s of plan.tasks) {
      ids.push(tasks.insertTask({
        project_id: task.project_id,
        parent_id: taskId,
        root_id: task.root_id ?? taskId,
        title: s.title,
        body: s.body ?? null,
        cwd: s.cwd ?? task.cwd ?? null,
        agent: s.agent ?? 'codex',
        model: s.model ?? null,
        done_when: s.done_when ?? null,
        effect: s.effect ?? 'read_only',
        // 要人审就先别 ready，否则调度器会直接跑
        status: res.needsReview ? 'awaiting_plan' : 'ready',
        priority: task.priority ?? 0,
        source: task.source,
      }));
    }

    // 依赖：deps 是下标
    for (let i = 0; i < plan.tasks.length; i++) {
      for (const d of plan.tasks[i].deps ?? []) {
        const target = ids[Number(d)];
        if (target && target !== ids[i]) {
          if (!tasks.wouldCycle(ids[i], target)) tasks.addDep(ids[i], target);
        }
      }
    }

    // 父任务标记完成（它的价值就是那张图）
    tasks.updateTask(taskId, { status: 'done', ended_at: nowIso() });
    tasks.logEvent({
      task_id: taskId, actor: 'system', action: 'planned.done',
      detail: `拆成 ${ids.length} 个子任务`,
    });

    if (res.needsReview) {
      addPlanTodo(taskId, res);
    } else {
      // 不需要人审的，立刻催一次调度，别等下一个 tick
      if (sched) {
        try { sched.tick(); } catch (err) { log.warn(`催调度失败: ${err.message}`); }
      }
    }

    return { ok: true, kind: 'plan', childIds: ids, needsReview: res.needsReview };
  }

  function addPlanTodo(taskId, res) {
    tasks.addTodo({
      kind: 'plan_review',
      task_id: taskId,
      title: `拆解结果需要确认：${tasks.getTask(taskId)?.title ?? taskId}`,
      detail: res.reasons?.length
        ? res.reasons.join('\n')
        : '拆解器认为这里有不确定的地方，需要你看一眼。',
      options: ['approve', 'reject'],
    });
  }

  /**
   * 人审通过拆解：把 awaiting_plan 的子任务改成 ready。
   * 这是「自动拆 + 模糊才审」里的那一环。
   */
  function approvePlan(taskId) {
    const kids = tasks.listChildren(taskId);
    let n = 0;
    for (const c of kids) {
      if (c.status === 'awaiting_plan') {
        tasks.updateTask(c.id, { status: 'ready' });
        n++;
      }
    }
    // 原子任务本身在 awaiting_plan
    const self = tasks.getTask(taskId);
    if (self && self.status === 'awaiting_plan' && kids.length === 0) {
      tasks.updateTask(taskId, { status: 'ready' });
      n++;
    }
    tasks.logEvent({
      task_id: taskId, actor: 'human', action: 'plan.approved',
      detail: `放行 ${n} 个任务`,
    });
    if (sched && n > 0) {
      try { sched.tick(); } catch (err) { log.warn(`催调度失败: ${err.message}`); }
    }
    return n;
  }

  /** 驳回拆解：整条链作废。 */
  function rejectPlan(taskId) {
    const kids = tasks.listChildren(taskId);
    for (const c of kids) {
      if (!['done', 'failed'].includes(c.status)) {
        tasks.updateTask(c.id, { status: 'rejected' });
      }
    }
    const self = tasks.getTask(taskId);
    if (self && !['done', 'failed'].includes(self.status)) {
      tasks.updateTask(taskId, { status: 'rejected', ended_at: nowIso() });
    }
    tasks.logEvent({ task_id: taskId, actor: 'human', action: 'plan.rejected' });
    return kids.length;
  }

  return { accept, planTask, planInBackground, approvePlan, rejectPlan, planning };
}
