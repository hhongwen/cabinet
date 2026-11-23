// 调度器：把 tasks 接上 runner，跑通「ready → running → 终结态」。
//
// 沿用原 queue.mjs 的核心思路，但换了驱动对象：
//   原来：事件 → 规则 → job
//   现在：ready 任务 → 依赖检查 → 排序 → 并发限制 → 起 run
//
// 三个不能妥协的点：
//   1. blocked 现算，不落库（避免「前置完成但忘记解锁」）
//   2. claim 用条件 UPDATE 抢占（多进程 / tick 重叠时不重复拉起）
//   3. 结论里的「需要决策：」协议保留（HANDOFF 第六节，别删）
import fs from 'node:fs';
import path from 'node:path';
import { needsDecision } from './runner.mjs';
import { createLogger, nowIso } from './util.mjs';

const log = createLogger('sched');

/** 终结态：这些不再调度。 */
const FINAL = new Set(['done', 'failed', 'rejected']);

/**
 * @param {object} deps
 *   tasks      taskStore
 *   runner     createRunner 的返回（复用其拼命令 / stdin / JSONL 能力）
 *   cfg        完整配置
 *   magpie     Magpie 客户端（额度刹车用）
 *   groups     群助手 { project(task), taskGroup(task) }
 */
export function createScheduler({ tasks, runner, cfg, magpie = null, groups = null }) {
  const pending = new Set();   // 跑着的 promise
  const active = new Map();    // runId -> { taskId, startedAt }

  // ---------- 群 ----------

  /** 确保任务相关的群都存在，返回 { projectGroup, taskGroup }。 */
  function ensureGroups(task) {
    const out = { projectGroup: null, taskGroup: null };
    if (!groups) return out;
    try {
      if (task.project_id) out.projectGroup = groups.project(task);
      out.taskGroup = groups.task(task);
    } catch (err) {
      log.warn(`建群失败: ${err.message}`);
    }
    return out;
  }

  /** 往群里投一条系统消息。失败不影响主流程。 */
  function postMessage(groupId, body, { taskId = null, runId = null, senderKind = 'system', senderId = null } = {}) {
    if (!groupId) return null;
    try {
      return tasks.addMessage({
        group_id: groupId,
        sender_kind: senderKind,
        sender_id: senderId,
        task_id: taskId,
        run_id: runId,
        body: String(body ?? ''),
      });
    } catch (err) {
      log.warn(`投消息失败: ${err.message}`);
      return null;
    }
  }

  // ---------- 并发限制 ----------

  /**
   * 算本轮允许的并发上限。
   * 三重限制取最小：全局 workers / 项目上限 / 额度刹车。
   * 一期额度刹车只降级 + 记日志，不做花哨自适应。
   */
  function computeLimits() {
    let workers = Number(cfg.workers) > 0 ? Number(cfg.workers) : 1;
    let throttleReason = null;

    if (magpie) {
      const t = magpie.isThrottled(cfg.quotaThresholdPct ?? 15);
      if (t.throttled) {
        workers = 1;
        throttleReason = t.reason;
      }
    }
    return { workers, throttleReason };
  }

  // ---------- 一轮调度 ----------

  /**
   * 一次调度。尽量把 ready 且依赖满足的任务拉起来。
   * @returns {{started:number, skipped:number, throttle:string|null}}
   */
  function tick() {
    const { workers, throttleReason } = computeLimits();
    let running = tasks.countRunning();
    let started = 0;
    let skipped = 0;

    const ready = tasks.listReady();
    if (ready.length === 0) return { started: 0, skipped: 0, throttle: throttleReason };

    for (const task of ready) {
      if (running >= workers) break;

      // 依赖现算：blocked 从不落库
      const dep = tasks.depsSatisfied(task.id);
      if (!dep.ok) {
        skipped++;
        continue;
      }

      // 项目级并发
      const project = task.project_id ? tasks.getProject(task.project_id) : null;
      const projMax = Number(project?.max_concurrency) || 0;
      if (projMax > 0) {
        const projRunning = tasks.listTasks({ projectId: task.project_id, status: 'running', limit: 500 }).length;
        if (projRunning >= projMax) {
          skipped++;
          continue;
        }
      }

      // 抢占式迁态：ready → running。失败说明被别的进程抢了
      if (!tasks.claimTask(task.id, 'ready', 'running')) continue;

      running++;
      started++;

      const claimed = tasks.getTask(task.id);
      const promise = runTask(claimed)
        .catch((err) => {
          log.error(`task ${claimed.id} 执行异常: ${err.message}`);
          try {
            safeFinish(claimed.id, { status: 'failed', error: err.message, lastMessage: null });
          } catch {
            /* store 已关 */
          }
        })
        .finally(() => pending.delete(promise));

      pending.add(promise);
    }

    return { started, skipped, throttle: throttleReason };
  }

  // ---------- 跑一个任务 ----------

  /**
   * 跑一个任务：建 run → 拼 prompt（含未读消息）→ 起 agent → 收尾。
   * 首轮用 exec，续轮用 resume（有 session_id 时）。
   */
  async function runTask(task) {
    const g = ensureGroups(task);
    const attempt = (task.attempt ?? 0) + 1;
    const agentCfg = cfg.agents?.[task.agent];

    // 上一轮的结局决定这一轮是「重试」还是「追加轮」：
    //   上一轮失败 → 重试，必须开新会话（在错的上下文里接着聊只会更错）
    //   上一轮成功 → 追加轮（群里有新消息），续用会话保持记忆
    const prevRun = tasks.latestRun(task.id);
    const isRetry = !!prevRun && prevRun.status === 'failed';

    if (!agentCfg) {
      tasks.updateTask(task.id, {
        status: 'failed', ended_at: nowIso(), attempt,
      });
      tasks.logEvent({
        task_id: task.id, actor: 'system', action: 'failed',
        detail: `agent 未配置: ${task.agent}`,
      });
      postMessage(g.taskGroup, `✗ 无法执行：agent 「${task.agent}」未配置`);
      tasks.addTodo({
        kind: 'failed', task_id: task.id,
        title: `任务失败：agent 未配置`,
        detail: `任务「${task.title}」指定的 agent「${task.agent}」在配置里不存在。`,
      });
      return;
    }

    // 建 run 记录
    const runId = tasks.insertRun({
      task_id: task.id,
      attempt,
      agent: task.agent,
      model: task.model,
      status: 'running',
    });
    tasks.updateRun(runId, { status: 'running', started_at: nowIso() });
    tasks.updateTask(task.id, { attempt });
    active.set(runId, { taskId: task.id, startedAt: Date.now() });

    tasks.logEvent({
      task_id: task.id, run_id: runId, actor: 'system', action: 'run.started',
      detail: `第 ${attempt} 次尝试，agent=${task.agent}`,
    });
    postMessage(g.taskGroup, `▶ 开始执行（第 ${attempt} 次尝试，${task.agent}）`, {
      taskId: task.id, runId,
    });

    // 拼 prompt：任务本身 + 群里未读消息
    const prompt = buildTaskPrompt(task, g, runId, { attempt, isRetry });

    let result;
    try {
      result = await runner.startRun({
        task,
        run: tasks.getRun(runId),
        agentCfg,
        prompt,
        // 重试开新会话；追加轮续用旧会话
        resumeSessionId: isRetry ? null : task.session_id,
      });
    } catch (err) {
      result = { status: 'failed', error: `执行异常: ${err.message}`, lastMessage: null, exitCode: null };
    } finally {
      active.delete(runId);
    }

    // 日志路径落库：面板要靠它找 transcript 和日志
    if (runId) {
      const paths = {};
      if (result?.logPath) paths.log_path = result.logPath;
      if (result?.transcriptPath) paths.transcript_path = result.transcriptPath;
      if (Object.keys(paths).length > 0) tasks.updateRun(runId, paths);
    }

    // session id 落库（续轮要用）
    if (result?.agentSessionId) {
      tasks.updateTask(task.id, { session_id: result.agentSessionId });
      tasks.logEvent({
        task_id: task.id, run_id: runId, actor: 'system', action: 'session.bound',
        detail: result.agentSessionId,
      });
    }

    // 把这一轮读到的消息标记已读
    if (g.taskGroup) {
      const lastMsg = tasks.listMessages(g.taskGroup, { limit: 1 });
      if (lastMsg.length > 0) {
        tasks.setReadWatermark(g.taskGroup, task.session_id ?? runId, lastMsg[0].id);
      }
    }

    safeFinish(task.id, { ...result, runId, groups: g });
  }

  /**
   * 拼一轮的 prompt。
   *
   * 关键设计：每轮都把「群里未读的消息」强制喂进去（DESIGN.md 6.2）。
   * 不指望模型自己去查消息——那等于把可靠性押在它的自觉上。
   */
  /**
   * 收集前置任务的产出，供下游直接用。
   * 依赖不只是「等它做完」，而是「拿到它做出来的东西」。
   */
  function collectDepOutputs(task) {
    const ids = tasks.listDeps(task.id);
    const out = [];
    for (const id of ids) {
      const dep = tasks.getTask(id);
      if (!dep) continue;
      if (dep.status !== 'done') {
        log.warn('task ' + task.id + ' 的前置 ' + id + ' 状态是 ' + dep.status + '，不该被调度');
        continue;
      }
      const run = tasks.latestRun(id);
      out.push({
        title: dep.title,
        doneWhen: dep.done_when,
        output: run && run.last_message ? clip(run.last_message, 1500) : null,
        artifacts: listArtifacts(dep, run),
      });
    }
    return out;
  }

  /** 找这一轮新产生的文件，作为产出提示给下游。 */
  function listArtifacts(task, run) {
    if (!task.cwd) return [];
    try {
      const files = fs.readdirSync(task.cwd).filter((f) => !f.startsWith('.'));
      const since = run && run.ended_at ? new Date(run.ended_at).getTime() - 60000 : 0;
      return files.filter((f) => {
        try {
          const st = fs.statSync(path.join(task.cwd, f));
          return st.isFile() && st.mtimeMs >= since;
        } catch { return false; }
      }).slice(0, 10);
    } catch { return []; }
  }
  function buildTaskPrompt(task, g, runId, { attempt = 1, isRetry = false } = {}) {
    const lines = [];
    lines.push(`# 任务：${task.title}`);
    if (isRetry) {
      // 只在真是重试时才说「前面失败了」。追加轮不该这么讲，会误导模型。
      lines.push('');
      lines.push(`（这是第 ${attempt} 次尝试。前面 ${attempt - 1} 次没有成功，这次请换一种做法。）`);
    }
    if (task.body) lines.push('', task.body);
    if (task.done_when) {
      lines.push('', '## 验收标准');
      lines.push(task.done_when);
    }
    // 前置任务的结论：没有这一段，下游会不知道上游干了什么（端到端实测踩过）。
    const depOutputs = collectDepOutputs(task);
    if (depOutputs.length > 0) {
      lines.push('', '## 前置任务的结果（已完成，直接用，不要再问人）');
      for (const d of depOutputs) {
        lines.push('### ' + d.title);
        if (d.doneWhen) lines.push('验收标准：' + d.doneWhen);
        lines.push(d.output ? ('结论：' + d.output) : '结论：（上游没有给出结论）');
        if (d.artifacts && d.artifacts.length) lines.push('产出文件：' + d.artifacts.join(', '));
      }
    }

    // 未读消息：续轮时这是主要输入
    if (g.taskGroup) {
      const sid = task.session_id ?? runId;
      const unread = tasks.unreadMessages(g.taskGroup, sid, 30);
      if (unread.length > 0) {
        lines.push('', '## 群里这段时间的新消息');
        for (const m of unread) {
          const who = m.sender_kind === 'human' ? '我' : m.sender_kind === 'session' ? `另一个会话` : '系统';
          lines.push(`- [${who}] ${m.body}`);
        }
      }
    }

    // 人机协议：沿用 HANDOFF 第六节的约定，别删
    lines.push('', '## 收尾要求');
    lines.push('完成后给出结论。如果有必须由人拍板的事，单独写一段，以「需要决策：」开头。');
    return lines.join('\n');
  }

  // ---------- 收尾 ----------

  /** 收尾的唯一入口。store 可能已被关闭（进程退出），要能安全跳过。 */
  function safeFinish(taskId, res) {
    if (tasks.isClosed?.()) return;
    try {
      finish(taskId, res);
    } catch (err) {
      log.error(`收尾失败 task=${taskId}: ${err.message}`);
    }
  }

  function finish(taskId, res) {
    const task = tasks.getTask(taskId);
    if (!task) return;

    // 被中断的不再改状态（沿用原 queue.mjs 修过的 bug #3）
    if (task.status === 'interrupted') {
      log.warn(`task ${taskId} 已标记 interrupted，忽略回调`);
      return;
    }

    const runId = res.runId ?? null;
    const g = res.groups ?? ensureGroups(task);
    const decision = needsDecision(res.lastMessage);

    if (runId) {
      tasks.updateRun(runId, {
        status: res.status ?? 'failed',
        exit_code: res.exitCode ?? null,
        last_message: res.lastMessage ?? null,
        error: res.error ?? null,
        ended_at: nowIso(),
        needs_attention: res.status === 'failed' || decision ? 1 : 0,
      });
    }

    const patch = {
      ended_at: nowIso(),
      ...(res.lastMessage ? {} : {}),
    };

    if (res.status === 'failed') {
      const attempt = task.attempt ?? 1;
      const maxAttempts = task.max_attempts ?? 3;

      if (attempt < maxAttempts) {
        // 重试：新建一次 run，不动已有记录
        patch.status = 'ready';
        tasks.updateTask(taskId, patch);
        tasks.logEvent({
          task_id: taskId, run_id: runId, actor: 'system', action: 'run.retry',
          detail: `第 ${attempt} 次失败: ${res.error ?? '未知'}，准备第 ${attempt + 1} 次`,
        });
        postMessage(g.taskGroup, `↻ 第 ${attempt} 次失败，将重试（上限 ${maxAttempts} 次）\n${clip(res.error, 200)}`, {
          taskId, runId,
        });
        return;
      }

      // 到上限：置 failed 并进待办
      patch.status = 'failed';
      tasks.updateTask(taskId, patch);
      tasks.logEvent({
        task_id: taskId, run_id: runId, actor: 'system', action: 'failed',
        detail: `已重试 ${attempt} 次仍失败: ${res.error ?? '未知'}`,
      });
      postMessage(g.taskGroup, `✗ 失败（已重试 ${attempt} 次）\n${clip(res.error, 300)}`, { taskId, runId });
      if (matchesNotify(task, 'failed')) {
        tasks.addTodo({
          kind: 'failed', task_id: taskId, run_id: runId,
          title: `任务失败：${task.title}`,
          detail: res.error ?? '无错误详情',
        });
      }
      return;
    }

    // 成功，但 agent 要求决策 → review + 待办
    if (decision) {
      patch.status = 'review';
      tasks.updateTask(taskId, patch);
      tasks.logEvent({
        task_id: taskId, run_id: runId, actor: 'session', action: 'needs_decision',
        detail: clip(res.lastMessage, 500),
      });
      postMessage(g.taskGroup, `🤔 需要你拍板：\n${clip(res.lastMessage, 800)}`, { taskId, runId });
      tasks.addTodo({
        kind: 'decision', task_id: taskId, run_id: runId,
        title: `需要决策：${task.title}`,
        detail: res.lastMessage ?? null,
        options: ['approve', 'reject'],
      });
      return;
    }

    // 正常完成
    patch.status = 'done';
    tasks.updateTask(taskId, patch);
    tasks.logEvent({
      task_id: taskId, run_id: runId, actor: 'session', action: 'done',
      detail: clip(res.lastMessage, 500),
    });
    postMessage(g.taskGroup, `✓ 完成\n${clip(res.lastMessage, 800)}`, { taskId, runId });
  }

  /** 该任务要不要为某个原因通知。默认都通知，配置可覆盖。 */
  function matchesNotify(task, reason) {
    const when = task.notify_when ?? cfg.defaultNotifyWhen ?? null;
    if (!when) return true; // 没配就全通知，别漏
    const list = Array.isArray(when) ? when : String(when).split(',').map((s) => s.trim());
    return list.includes('*') || list.includes('all') || list.includes(reason);
  }

  function clip(text, n) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  // ---------- 审批 / 决策回流 ----------

  /**
   * 人在面板或飞书上批了一个 review 任务。
   * review → done，并解掉对应待办。
   */
  function approve(taskId, note = null) {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (task.status !== 'review') {
      throw new Error(`任务 ${taskId} 当前状态 ${task.status}，不能 approve`);
    }
    tasks.updateTask(taskId, { status: 'done', ended_at: task.ended_at ?? nowIso() });
    tasks.logEvent({
      task_id: taskId, actor: 'human', action: 'approved', detail: note,
    });
    const run = tasks.latestRun(taskId);
    if (run?.needs_attention) tasks.updateRun(run.id, { needs_attention: 0 });
    const g = ensureGroups(task);
    postMessage(g.taskGroup, `✓ 已确认${note ? `：${note}` : ''}`, { taskId });
    return { status: 'done' };
  }

  /** 驳回：review / ready / awaiting_plan → rejected。 */
  function reject(taskId, note = null) {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    if (!['review', 'ready', 'awaiting_plan', 'failed'].includes(task.status)) {
      throw new Error(`任务 ${taskId} 当前状态 ${task.status}，不能 reject`);
    }
    tasks.updateTask(taskId, { status: 'rejected', ended_at: nowIso() });
    tasks.logEvent({ task_id: taskId, actor: 'human', action: 'rejected', detail: note });
    const g = ensureGroups(task);
    postMessage(g.taskGroup, `✗ 已驳回${note ? `：${note}` : ''}`, { taskId });
    return { status: 'rejected' };
  }

  /**
   * 改优先级 / 改指派。这是「调整优先级」这条需求的落点。
   */
  function updateTask(taskId, patch) {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);
    const allowed = {};
    if (patch.priority !== undefined) allowed.priority = Number(patch.priority) || 0;
    if (patch.agent !== undefined) allowed.agent = patch.agent;
    if (patch.model !== undefined) allowed.model = patch.model;
    if (Object.keys(allowed).length === 0) throw new Error('没有可改的字段');

    tasks.updateTask(taskId, allowed);
    tasks.logEvent({
      task_id: taskId, actor: 'human', action: 'updated',
      detail: JSON.stringify(allowed),
    });
    return tasks.getTask(taskId);
  }

  // ---------- 生命周期 ----------

  /** 等所有跑着的任务结束（测试 / 优雅退出用）。 */
  async function drain() {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  /** tick + drain 循环，直到没有可跑的任务（CLI 用）。 */
  async function runUntilIdle({ maxRounds = 500 } = {}) {
    for (let i = 0; i < maxRounds; i++) {
      tick();
      if (pending.size === 0) {
        const ready = tasks.listReady();
        const claimable = ready.some((t) => tasks.depsSatisfied(t.id).ok);
        if (!claimable && tasks.countRunning() === 0) return;
      }
      await new Promise((r) => setTimeout(r, pending.size > 0 ? 150 : 100));
      if (pending.size > 0) await Promise.allSettled([...pending]);
    }
  }

  /** 进程退出时把所有 running 标 interrupted。必须在 kill 之前调。 */
  function markInterrupted(reason = '进程退出') {
    const running = tasks.listTasks({ status: 'running', limit: 1000 });
    for (const t of running) {
      tasks.updateTask(t.id, { status: 'interrupted' });
      tasks.logEvent({
        task_id: t.id, actor: 'system', action: 'interrupted', detail: reason,
      });
    }
    return running.length;
  }

  return {
    tick,
    approve,
    reject,
    updateTask,
    drain,
    runUntilIdle,
    markInterrupted,
    pending,
    active,
    _ensureGroups: ensureGroups,
    _buildTaskPrompt: buildTaskPrompt,
  };
}
