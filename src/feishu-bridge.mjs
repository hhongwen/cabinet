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

  // 已处理过的卡片消息，防止重复点击触发两次（飞书可能重推事件）
  const handledMessages = new Set();

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
    const messageId = evt.message_id ?? null;
    const verb = value?.action;
    const taskId = value?.taskId;
    const todoId = value?.todoId;

    log.info(`卡片操作: ${verb} task=${taskId} msg=${messageId}`);

    // 幂等：同一条卡片消息只处理一次，防止连点
    if (messageId && handledMessages.has(messageId)) {
      log.warn(`卡片 ${messageId} 已经处理过了，忽略重复点击`);
      return;
    }

    if (!verb || !taskId) return;
    if (operator && !isAllowed(operator)) {
      log.warn(`非白名单用户点了卡片: ${operator}`);
      return;
    }
    if (messageId) handledMessages.add(messageId);

    let resultText = '';
    let okFlag = true;

    try {
      const t = tasks.getTask(taskId);
      if (!t) throw new Error('任务不存在');

      // 已经处理过的任务：不重复动作，只把卡片刷新成现状
      const alreadyDone = ['done', 'rejected', 'accepted'].includes(t.status);
      if (alreadyDone) {
        resultText = `这条已经是「${t.status}」了，不用再处理。`;
        okFlag = false;
      } else if (verb === 'approve') {
        if (t.status === 'awaiting_plan') {
          const n = ingest.approvePlan(taskId);
          if (todoId) tasks.resolveTodo(todoId, 'approve');
          resultText = `已放行 ${n} 个任务。`;
        } else {
          sched?.approve(taskId, '飞书确认');
          if (todoId) tasks.resolveTodo(todoId, 'approve');
          resultText = `已通过：${t.title}`;
        }
      } else if (verb === 'reject') {
        if (t.status === 'awaiting_plan') {
          ingest.rejectPlan(taskId);
          if (todoId) tasks.dismissTodo(todoId);
          resultText = `已驳回整个拆解。`;
        } else {
          sched?.reject(taskId, '飞书驳回');
          if (todoId) tasks.dismissTodo(todoId);
          resultText = `已驳回：${t.title}`;
        }
      } else {
        resultText = `未知动作：${verb}`;
        okFlag = false;
      }
    } catch (err) {
      log.warn(`卡片操作失败: ${err.message}`);
      resultText = `操作失败：${err.message}`;
      okFlag = false;
    }

    // 关键：把卡片改成「已处理」的样子，按钮消失。
    // 不这么做的话，那张卡片还能一直被点。
    if (messageId) {
      const original = safeParse(evt.card_content);
      const settled = settledCard({
        title: original?.header?.title?.content ?? '已处理',
        result: resultText,
        ok: okFlag,
      });
      sender.patchCard?.(messageId, settled).catch?.(() => {});
    }

    notify(resultText);
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

  // 卡片回调单独一个消费者（同一时刻每种事件只能有一个消费者）
  const cardConn = createFeishuLongConn({
    cliPath: cfg.cliPath,
    profile,
    onEvent: (evt) => {
      const type = evt.type ?? evt.event_type;
      if (type === EVENT_CARD || evt.action_value) handleCardEvent(evt);
    },
    onError: (e) => log.warn(`[卡片] ${e}`),
    restartDelayMs: cfg.restartDelayMs ?? 10_000,
  });

  return {
    start() {
      log.info(`飞书长连接启动（profile=${profile ?? '默认'}）`);
      // 消息和卡片回调是两个独立的事件流，必须各起一个消费者。
      // 只起消息那个的话，点卡片按钮不会触发任何动作。
      const jobs = [conn.start(EVENT_MESSAGE)];
      if (cfg.watchCards !== false) jobs.push(cardConn.start(EVENT_CARD));
      return Promise.all(jobs);
    },
    stop() {
      conn.stop();
      cardConn.stop();
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
    get stats() {
      const a = conn.stats;
      const b = cardConn.stats;
      return {
        running: a.running || b.running,
        eventsSeen: a.eventsSeen + b.eventsSeen,
        cardEvents: b.eventsSeen,
        restarts: a.restarts + b.restarts,
        lastEventAt: a.lastEventAt ?? b.lastEventAt,
        lastError: a.lastError ?? b.lastError,
      };
    },
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

/** 安全解析 JSON 字符串，失败返回 null。 */
function safeParse(text) {
  if (typeof text !== 'string' || !text) return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 处理完的卡片长什么样：按钮消失，只剩一句结果。
 * 这是防重复点击的核心 —— 按钮不在了就没法再点。
 */
export function settledCard({ title, result, ok = true }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: ok ? 'green' : 'grey',
      title: { tag: 'plain_text', content: String(title || '已处理').slice(0, 100) },
    },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: String(result ?? '') } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '已处理，这条不用再点' }] },
    ],
  };
}
