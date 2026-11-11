// 飞书桥：长连接收事件 → 建任务；任务状态 → 推飞书。
//
// 收：lark-cli 子进程 stdout 的 JSON 行（见 feishu-cli.mjs）
// 发：lark-cli im +messages-send
// 都不需要公网地址。
import { createLogger } from './util.mjs';
import { createFeishuLongConn, createFeishuCliSender, EVENT_MESSAGE, EVENT_CARD } from './feishu-cli.mjs';

const log = createLogger('fs-bridge');

/**
 * @param {object} deps { tasks, ingest, sched, cfg }
 */
export function createFeishuBridge({ tasks, ingest, sched = null, cfg = {} }) {
  const profile = cfg.profile ?? null;
  let sender = createFeishuCliSender({ cliPath: cfg.cliPath, profile });

  // 白名单：空 = 第一个跟机器人说话的人就是主人
  const allowed = Array.isArray(cfg.allowedOpenIds) && cfg.allowedOpenIds.length > 0
    ? new Set(cfg.allowedOpenIds) : null;
  let ownerOpenId = cfg.openId ?? null;

  // 会话 id 缓存：open_id → chat_id（回消息用）
  const chatOf = new Map();

  function isAllowed(openId) {
    if (!openId) return false;
    if (!allowed) return true;
    return allowed.has(openId);
  }

  function remember(openId, chatId) {
    if (openId && ownerOpenId !== openId) {
      if (!ownerOpenId) log.info(`认下主人: ${openId}`);
      ownerOpenId = openId;
    }
    if (openId && chatId) chatOf.set(openId, chatId);
  }

  /** 发文本给某人；不传就发给主人。 */
  async function notify(text, { openId = null } = {}) {
    const target = openId ?? ownerOpenId;
    if (!target) {
      log.warn('还没有主人 open_id，等对方先说一句');
      return { ok: false, error: 'no owner' };
    }
    try {
      return await sender.sendText(text, target);
    } catch (err) {
      log.warn(`推送失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** 发卡片。 */
  async function notifyCard(card, { openId = null } = {}) {
    const target = openId ?? ownerOpenId;
    if (!target) return { ok: false, error: 'no owner' };
    try {
      return await sender.sendCard(card, target);
    } catch (err) {
      log.warn(`推卡片失败: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // ---------- 消息处理 ----------

  /** lark-cli 吐出来的一条消息事件。 */
  function handleMessageEvent(evt) {
    // 只处理用户发来的文本
    if (evt.sender_type && evt.sender_type !== 'user') return;
    if (evt.message_type && evt.message_type !== 'text') return;

    const openId = evt.sender_id ?? null;
    const chatId = evt.chat_id ?? null;

    let text = '';
    try {
      const c = typeof evt.content === 'string' ? JSON.parse(evt.content) : evt.content;
      text = String(c?.text ?? '');
    } catch {
      text = String(evt.content ?? '');
    }
    // 去掉 @机器人
    text = text.replace(/@_user_\d+/g, '').trim();
    if (!text) return;

    if (!isAllowed(openId)) {
      log.warn(`非白名单: ${openId}`);
      return;
    }
    remember(openId, chatId);

    // 命令词
    if (/^(帮助|help|\?)$/i.test(text)) {
      notify([
        '发一句话就是要建的任务。',
        '',
        '例：「整理这周的会议记录归档」',
        '',
        '其他命令：',
        '· 状态 —— 当前任务概况',
        '· 待办 —— 等你处理的事',
      ].join('\n'), { openId });
      return;
    }

    if (/^(状态|status)$/i.test(text)) {
      const st = tasks.stats();
      const running = tasks.listTasks({ status: 'running', limit: 5 });
      let s = `共 ${st.total} 个任务，${st.running} 个在跑，${st.openTodos} 个等你处理。`;
      if (running.length) s += '\n\n在跑：\n' + running.map((t) => '· ' + t.title).join('\n');
      notify(s, { openId });
      return;
    }

    if (/^(待办|todo|todos)$/i.test(text)) {
      const list = tasks.listTodos({ status: 'open', limit: 10 });
      if (list.length === 0) {
        notify('没有待办，清净。', { openId });
      } else {
        notify('等你处理：\n\n' + list.map((t, i) =>
          `${i + 1}. ${t.title}\n   ${String(t.detail ?? '').slice(0, 100)}`).join('\n\n'), { openId });
      }
      return;
    }

    // 普通消息 = 新任务
    const r = ingest.accept({
      title: text.slice(0, 100),
      body: text,
      cwd: cfg.defaultCwd ?? null,
      source: 'feishu',
      sourceRef: evt.message_id ?? null,
    });
    log.info(`飞书来任务 ${r.id}: ${text.slice(0, 40)}`);
    notify(`收到，开始拆解。\n\n「${text.slice(0, 80)}」\n\n拆完我告诉你。`, { openId });
  }

  /** 卡片按钮。 */
  function handleCardEvent(evt) {
    let value = evt.action_value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { value = null; }
    }
    const operator = evt.operator_id ?? null;
    const verb = value?.action;
    const taskId = value?.taskId;
    const todoId = value?.todoId;

    log.info(`卡片操作: ${verb} task=${taskId}`);
    if (!verb || !taskId) return;
    if (operator && !isAllowed(operator)) return;

    try {
      const t = tasks.getTask(taskId);
      if (!t) throw new Error('任务不存在');

      if (verb === 'approve') {
        if (t.status === 'awaiting_plan') {
          const n = ingest.approvePlan(taskId);
          if (todoId) tasks.resolveTodo(todoId, 'approve');
          notify(`已放行 ${n} 个任务。`);
        } else {
          sched?.approve(taskId, '飞书确认');
          if (todoId) tasks.resolveTodo(todoId, 'approve');
          notify(`已通过：${t.title}`);
        }
      } else if (verb === 'reject') {
        if (t.status === 'awaiting_plan') {
          ingest.rejectPlan(taskId);
          if (todoId) tasks.dismissTodo(todoId);
          notify(`已驳回整个拆解。`);
        } else {
          sched?.reject(taskId, '飞书驳回');
          if (todoId) tasks.dismissTodo(todoId);
          notify(`已驳回：${t.title}`);
        }
      }
    } catch (err) {
      log.warn(`卡片操作失败: ${err.message}`);
      notify(`操作失败：${err.message}`);
    }
  }

  // ---------- 长连接 ----------

  const conn = createFeishuLongConn({
    cliPath: cfg.cliPath,
    profile,
    onEvent: (evt) => {
      const type = evt.type ?? evt.event_type;
      if (type === EVENT_MESSAGE) handleMessageEvent(evt);
      else if (type === EVENT_CARD) handleCardEvent(evt);
      else log.debug(`忽略事件: ${type}`);
    },
    onError: (e) => log.warn(e),
    restartDelayMs: cfg.restartDelayMs ?? 10_000,
  });

  return {
    start() {
      log.info(`飞书长连接启动（profile=${profile ?? '默认'}）`);
      return conn.start(EVENT_MESSAGE);
    },
    stop() {
      conn.stop();
    },
    notify,
    notifyCard,
    /** 测试用：替换发送实现，避免真调 CLI。 */
    _setSender(s2) { sender = s2; },
    pushTodo(todo) {
      if (!todo) return { ok: false };
      const card = buildCard({
        title: todo.title,
        body: String(todo.detail ?? ''),
        taskId: todo.task_id,
        todoId: todo.id,
      });
      return notifyCard(card);
    },
    pushStatus(task, reason) {
      if (!task) return { ok: false };
      const icon = { done: '✓', failed: '✗', review: '🤔' }[reason] ?? '·';
      const run = tasks.latestRun(task.id);
      let s = `${icon} ${task.title}`;
      if (run?.last_message) s += `\n\n${String(run.last_message).slice(0, 500)}`;
      if (run?.error) s += `\n\n错误：${String(run.error).slice(0, 300)}`;
      return notify(s);
    },
    get stats() { return conn.stats; },
    get ownerOpenId() { return ownerOpenId; },
    _handleMessageEvent: handleMessageEvent,
    _handleCardEvent: handleCardEvent,
  };
}

/** 造一张「等你拍板」的卡片。 */
export function buildCard({ title, body, taskId, todoId }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: String(title || '需要你拍板').slice(0, 100) },
    },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: String(body ?? '').slice(0, 1500) } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '通过' },
            type: 'primary',
            value: { action: 'approve', taskId, todoId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '驳回' },
            type: 'danger',
            value: { action: 'reject', taskId, todoId },
          },
        ],
      },
    ],
  };
}
