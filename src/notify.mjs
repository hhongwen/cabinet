// 通知 adapter。只做一件事：job 到了需要你知道的状态时，往外喊一声。
// 单机版默认 panel —— 面板自己在轮询 /api/state，这里什么都不用做。
import { createLogger, truncate } from './util.mjs';

const log = createLogger('notify');

/** 判断某个 notify 原因是否在该 job / 规则的 notifyWhen 里。 */
export function shouldNotify(notifyWhen, reason) {
  if (!reason) return false;
  const list = Array.isArray(notifyWhen)
    ? notifyWhen
    : typeof notifyWhen === 'string'
      ? safeParseList(notifyWhen)
      : [];
  if (list.length === 0) return false;
  if (list.includes('*') || list.includes('all')) return true;
  return list.includes(reason);
}

function safeParseList(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [String(v)];
  } catch {
    return [s];
  }
}

/** 把 job 压成一条便于阅读的通知。 */
export function formatMessage(job, reason) {
  const titleMap = {
    awaiting_approval: '🙋 有活等你批',
    needs_decision: '🤔 Agent 需要你拍板',
    failed: '❌ 任务失败',
    done: '✅ 任务完成',
    accepted: '✅ 已确认',
    rejected: '🚫 已拒绝',
  };
  const title = titleMap[reason] ?? `📌 ${reason}`;
  const lines = [
    `${title}｜${job.rule_id ?? 'no_rule'}`,
    `job: ${job.id}`,
    `事件: ${job.event_id ?? '-'}`,
  ];
  if (job.last_message) lines.push('', truncate(job.last_message, 500));
  if (job.error) lines.push('', `错误: ${truncate(job.error, 300)}`);
  return lines.join('\n');
}

/** panel adapter：什么都不做，面板轮询自己会看到。 */
export const panelAdapter = {
  name: 'panel',
  send() {
    return { ok: true, skipped: true };
  },
};

/** webhook adapter：POST JSON 到 url。 */
export function createWebhookAdapter({ url, headers = {}, timeoutMs = 5000 } = {}) {
  return {
    name: 'webhook',
    async send({ job, reason }) {
      if (!url) return { ok: false, error: 'webhook.url 未配置' };
      const payload = {
        reason,
        title: `Cabinet: ${reason}`,
        text: formatMessage(job, reason),
        job: {
          id: job.id,
          rule_id: job.rule_id,
          status: job.status,
          agent: job.agent,
          cwd: job.cwd,
          event_id: job.event_id,
          last_message: job.last_message,
          error: job.error,
          created_at: job.created_at,
        },
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 飞书 adapter —— 空壳，要用的话填这里：
 *   1. 在飞书开放平台建自建应用，开「机器人」能力，拿 app_id / app_secret；
 *   2. 把机器人拉进目标群，拿 chat_id；
 *   3. 用 app_id/app_secret 换 tenant_access_token
 *      POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
 *      body {app_id, app_secret} → {tenant_access_token, expire}
 *   4. 发卡片/文本：POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id
 *      header Authorization: Bearer <tenant_access_token>
 *      body {receive_id, msg_type:"text"|"interactive", content}
 *      想做成「批奏折」按钮，用 msg_type:"interactive" + card 里的
 *      actions → button.url = 面板的 /?job=<id>（单机版没公网，链接只在
 *      你本机浏览器里有效；跨机就配 Tailscale 域名）。
 *   5. token 有效期 2 小时，缓存起来，过期再换。
 */
export function createFeishuAdapter(opts = {}) {
  return {
    name: 'feishu',
    async send({ job, reason }) {
      // TODO(接飞书时实现)：见上方注释 1-5 步。
      log.warn(`feishu adapter 未实现，丢弃通知（${reason} / ${job.id}）`);
      return { ok: false, error: 'feishu adapter 未实现' };
    },
  };
}

/**
 * Telegram adapter —— 空壳，要用的话填这里：
 *   1. 找 @BotFather 建 bot，拿 token；
 *   2. 拿 chat_id（给 bot 发条消息后调 getUpdates，或把 bot 拉群里看 update）；
 *   3. POST https://api.telegram.org/bot<TOKEN>/sendMessage
 *      body { chat_id, text, parse_mode:"Markdown", reply_markup: {inline_keyboard:[[{text:"通过",url:<面板链接>}]]} }
 */
export function createTelegramAdapter(opts = {}) {
  return {
    name: 'telegram',
    async send({ job, reason }) {
      // TODO(接 Telegram 时实现)：见上方注释 1-3 步。
      log.warn(`telegram adapter 未实现，丢弃通知（${reason} / ${job.id}）`);
      return { ok: false, error: 'telegram adapter 未实现' };
    },
  };
}

/**
 * 组装 notifier。cfg.notify 形如：
 *   { "panel": true, "webhook": { "url": "https://..." }, "feishu": {...}, "telegram": {...} }
 */
export function createNotifier(cfg) {
  const conf = cfg?.notify ?? {};
  const adapters = [];

  if (conf.panel !== false) adapters.push(panelAdapter);
  if (conf.webhook?.url) adapters.push(createWebhookAdapter({ url: conf.webhook.url, headers: conf.webhook.headers }));
  if (conf.feishu) adapters.push(createFeishuAdapter(conf.feishu));
  if (conf.telegram) adapters.push(createTelegramAdapter(conf.telegram));

  return {
    adapters,
    /** job 的 notifyWhen 命中才发。 */
    notify({ job, reason }) {
      if (!job) return;
      if (!shouldNotify(job.notify_when, reason)) return;
      const text = formatMessage(job, reason);
      log.info(`通知(${reason}) → ${adapters.map((a) => a.name).join(',')}: ${truncate(text.split('\n')[0], 80)}`);
      for (const a of adapters) {
        try {
          const r = a.send({ job, reason, text });
          if (r && typeof r.catch === 'function') r.catch((e) => log.warn(`${a.name} 通知失败: ${e.message}`));
        } catch (err) {
          log.warn(`${a.name} 通知失败: ${err.message}`);
        }
      }
    },
  };
}
