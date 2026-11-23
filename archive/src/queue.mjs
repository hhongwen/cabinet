// 排队层：入库去重 → 派给规则 → 受并发限制拉起 runner。
// 状态机见 README；这里是唯一改状态的入口，CLI 和 HTTP 都走同一套函数。
import crypto from 'node:crypto';
import path from 'node:path';
import { ACTIVE_STATUSES } from './db.mjs';
import { findRule } from './rules.mjs';
import { needsDecision } from './runner.mjs';
import { createLogger, expandVars, newId, nowIso, truncate } from './util.mjs';

const log = createLogger('queue');

/** 生成去重键：优先用事件自带 dedupe_key，否则由 source/type/subject 决定。 */
export function makeDedupeKey(ev) {
  if (ev.dedupe_key) return String(ev.dedupe_key);
  const basis = [ev.source, ev.type, ev.subject].map((x) => x ?? '').join('|');
  if (!basis.replace(/\|/g, '')) return null;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

/** 规则的 cwd 支持 ~ / %VAR% 展开；相对路径以工作目录为基准，`.` 表示仓库根。 */
function resolveCwd(cwd, cfg) {
  if (!cwd) return cfg?._meta?.baseDir ?? process.cwd();
  const expanded = expandVars(String(cwd));
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(cfg?._meta?.baseDir ?? process.cwd(), expanded);
}

/** 规则里 concurrency.key 支持 $cwd / $subject / $agent 这种动态键。 */
function resolveConcurrencyKey(rule, job) {
  const conf = rule?.concurrency;
  if (!conf?.key) return null;
  const map = { $cwd: job.cwd, $subject: job.subject, $agent: job.agent, $rule: rule.id };
  return map[conf.key] ?? String(conf.key);
}

/**
 * 队列。依赖：store、ruleStore、runner、cfg、notifier。
 */
export function createQueue({ cfg, store, ruleStore, runner, notifier }) {
  const pending = new Set(); // 跑着的 promise，优雅退出时等它们

  // ---------- 入库 ----------
  /**
   * 收一个事件：落库 → 匹配规则 → 去重 → 建 job。
   * @returns {{action:'queued'|'awaiting_approval'|'no_rule'|'duplicate', eventId, jobId?}}
   */
  function ingest(input) {
    const ev = {
      id: input.id ?? newId('evt'),
      source: input.source ?? 'unknown',
      type: input.type ?? 'unknown',
      subject: input.subject ?? null,
      summary: input.summary ?? null,
      link: input.link ?? null,
      payload: input.payload ?? null,
      received_at: input.received_at ?? nowIso(),
      dedupe_key: makeDedupeKey(input),
      status: 'received',
    };
    store.insertEvent(ev);

    const rule = findRule(ruleStore.get(), ev);
    if (!rule) {
      store.updateEvent(ev.id, { status: 'no_rule', error: '没有命中任何规则' });
      log.info(`事件 ${ev.id} 未命中规则，丢弃（${ev.source}/${ev.type}/${ev.subject ?? '-'}）`);
      return { action: 'no_rule', eventId: ev.id };
    }

    // 去重：同一 dedupe_key 还有未终结的 job → 丢掉新事件，旧 job 计数 +1
    const active = store.findActiveByDedupe(ev.dedupe_key);
    if (active) {
      store.bumpDuplicate(active.id);
      store.updateEvent(ev.id, {
        status: 'duplicate',
        rule_id: rule.id,
        job_id: active.id,
        error: '同一事件仍在处理中，已合并',
      });
      log.info(`事件 ${ev.id} 与 job ${active.id} 重复，已合并（duplicate_count+1）`);
      return { action: 'duplicate', eventId: ev.id, jobId: active.id };
    }

    const approval = rule.approval ?? 'never';
    const job = {
      id: newId('job'),
      event_id: ev.id,
      rule_id: rule.id,
      agent: rule.agent,
      cwd: resolveCwd(rule.cwd ?? input.cwd, cfg),
      status: approval === 'before' ? 'awaiting_approval' : 'queued',
      prompt: buildPrompt(rule, ev),
      dedupe_key: ev.dedupe_key,
      approval,
      notify_when: rule.notifyWhen ?? [],
      model: rule.model ?? null,
      sandbox: rule.sandbox ?? null,
      reasoning: rule.reasoning ?? null,
      timeout_ms: rule.timeoutMs ?? cfg.defaultTimeoutMs ?? null,
      created_at: nowIso(),
      needs_attention: approval === 'before' ? 1 : 0,
    };
    job.concurrency_key = resolveConcurrencyKey(rule, { ...job, subject: ev.subject });
    store.insertJob(job);
    store.updateEvent(ev.id, { status: job.status === 'queued' ? 'queued' : 'awaiting', rule_id: rule.id, job_id: job.id });

    log.info(
      `事件 ${ev.id} → 规则 ${rule.id} → job ${job.id} (${job.status}, agent=${job.agent})`,
    );

    if (job.status === 'awaiting_approval') {
      notifySafe({ job, reason: 'awaiting_approval' });
    }
    return { action: job.status === 'awaiting_approval' ? 'awaiting_approval' : 'queued', eventId: ev.id, jobId: job.id };
  }

  /** 把事件摘要拼进 prompt 模板后面，让 agent 知道到底发生了什么。 */
  function buildPrompt(rule, ev) {
    const lines = [];
    if (rule.prompt) lines.push(String(rule.prompt).trim());
    lines.push('');
    lines.push('---');
    lines.push('事件：');
    lines.push(`- source: ${ev.source}`);
    lines.push(`- type: ${ev.type}`);
    if (ev.subject) lines.push(`- subject: ${ev.subject}`);
    if (ev.summary) lines.push(`- summary: ${ev.summary}`);
    if (ev.link) lines.push(`- link: ${ev.link}`);
    if (ev.payload && Object.keys(ev.payload).length) {
      let payloadText;
      try {
        payloadText = JSON.stringify(ev.payload);
      } catch {
        payloadText = String(ev.payload);
      }
      lines.push(`- payload: ${truncate(payloadText, 2000)}`);
    }
    return lines.join('\n');
  }

  // ---------- 审批 ----------
  /** 事前审批通过：awaiting_approval → queued。返回是否成功。 */
  function approve(jobId, note = null) {
    const job = store.getJob(jobId);
    if (!job) throw new Error(`job 不存在: ${jobId}`);
    if (job.status === 'review') {
      // 事后确认通过
      store.updateJob(jobId, {
        status: 'accepted',
        decision: 'approved',
        decision_note: note ?? null,
        ended_at: job.ended_at ?? nowIso(),
        needs_attention: 0,
      });
      log.info(`job ${jobId} 事后确认通过 → accepted`);
      notifySafe({ job: store.getJob(jobId), reason: 'accepted' });
      return { status: 'accepted' };
    }
    if (job.status !== 'awaiting_approval') {
      throw new Error(`job ${jobId} 当前状态 ${job.status}，不能 approve`);
    }
    store.updateJob(jobId, {
      status: 'queued',
      decision: 'approved',
      decision_note: note ?? null,
      needs_attention: 0,
    });
    log.info(`job ${jobId} 审批通过 → queued${note ? `（${note}）` : ''}`);
    return { status: 'queued' };
  }

  /** 拒绝：awaiting_approval / review / queued → rejected。 */
  function reject(jobId, note = null) {
    const job = store.getJob(jobId);
    if (!job) throw new Error(`job 不存在: ${jobId}`);
    if (!['awaiting_approval', 'review', 'queued'].includes(job.status)) {
      throw new Error(`job ${jobId} 当前状态 ${job.status}，不能 reject`);
    }
    store.updateJob(jobId, {
      status: 'rejected',
      decision: 'rejected',
      decision_note: note ?? null,
      ended_at: nowIso(),
      needs_attention: 0,
    });
    log.info(`job ${jobId} 被拒绝${note ? `（${note}）` : ''}`);
    notifySafe({ job: store.getJob(jobId), reason: 'rejected' });
    return { status: 'rejected' };
  }

  // ---------- 调度 ----------
  /**
   * 一次调度：尽量把 queued 的 job 拉起来。
   * 并发上限两重：全局 cfg.workers + 每条规则的 concurrency.max。
   */
  function tick() {
    const queued = store.listQueued();
    if (queued.length === 0) return { started: 0 };

    const maxWorkers = Number(cfg.workers) > 0 ? Number(cfg.workers) : 1;
    let running = store.countRunning();
    let started = 0;

    // 规则可能被热更新，用最新规则里的 concurrency 配置
    const rules = ruleStore.get();

    for (const job of queued) {
      if (running >= maxWorkers) break;

      const rule = rules.find((r) => r.id === job.rule_id) ?? null;
      const key = job.concurrency_key ?? (rule ? resolveConcurrencyKey(rule, job) : null);
      const max = rule?.concurrency?.max;

      if (key && max) {
        const n = store.countRunningByKey(key);
        if (n >= Number(max)) {
          log.debug(`job ${job.id} 受 concurrency(${key}) 限制，等 ${n}/${max}`);
          continue;
        }
      }

      if (!store.claimJob(job.id, 'queued')) continue; // 被别的进程抢了
      running++;
      started++;

      const claimed = store.getJob(job.id);
      const agentCfg = cfg.agents?.[claimed.agent];
      if (!agentCfg) {
        store.updateJob(job.id, {
          status: 'failed',
          ended_at: nowIso(),
          error: `agent 未配置: ${claimed.agent}`,
          needs_attention: 1,
        });
        notifySafe({ job: store.getJob(job.id), reason: 'failed' });
        continue;
      }

      const p = runner
        .start(claimed, agentCfg)
        .then((res) => finishJob(claimed.id, res))
        .catch((err) => {
          log.error(`job ${claimed.id} 执行异常: ${err.message}`);
          try {
            finishJob(claimed.id, { status: 'failed', exitCode: null, error: err.message, lastMessage: null });
          } catch {
            /* store 已关，忽略 */
          }
        })
        .finally(() => pending.delete(p));
      pending.add(p);
    }

    return { started };
  }

  /** runner 跑完之后收尾：定终态、判是否需要人、通知。 */
  function finishJob(jobId, res) {
    // 进程退出时 store 可能已经关了，回调才姗姗来迟
    if (store.isClosed?.()) return;
    const job = store.getJob(jobId);
    if (!job) return;

    // 被中断的（进程退出）不再改状态
    if (job.status === 'interrupted') {
      log.warn(`job ${jobId} 已被标记 interrupted，忽略回调`);
      return;
    }

    const approval = job.approval ?? 'never';
    const decision = needsDecision(res.lastMessage);

    const patch = {
      ended_at: nowIso(),
      exit_code: res.exitCode ?? null,
      last_message: res.lastMessage ?? null,
      error: res.error ?? null,
    };

    let notifyReason = null;

    if (res.status === 'failed') {
      patch.status = 'failed';
      patch.needs_attention = 1;
      notifyReason = 'failed';
    } else if (approval === 'after' || (approval === 'review' && decision)) {
      // 事后确认：after 一律要你点头；review 只在 agent 主动要求决策时
      patch.status = 'review';
      patch.needs_attention = 1;
      notifyReason = 'needs_decision';
    } else {
      patch.status = 'done';
      // approval 为 before / never，但 agent 说需要决策 → 不卡流程，只标记留意
      patch.needs_attention = decision ? 1 : 0;
      notifyReason = decision ? 'needs_decision' : 'done';
    }

    store.updateJob(jobId, patch);
    log.info(
      `job ${jobId} 结束: ${patch.status} (exit=${res.exitCode ?? '-'})${
        res.lastMessage ? ` 结论: ${truncate(res.lastMessage, 60)}` : ''
      }`,
    );
    notifySafe({ job: store.getJob(jobId), reason: notifyReason });
  }

  function notifySafe(payload) {
    if (!notifier) return;
    try {
      const r = notifier.notify(payload);
      if (r && typeof r.catch === 'function') r.catch((e) => log.warn(`通知失败: ${e.message}`));
    } catch (err) {
      log.warn(`通知失败: ${err.message}`);
    }
  }

  /** 等所有跑着的 job 结束（测试 / 优雅退出用）。 */
  async function drain() {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  /** tick + drain 循环，直到队列空且没有 running（CLI emit 用）。 */
  async function runUntilIdle({ maxRounds = 200 } = {}) {
    for (let i = 0; i < maxRounds; i++) {
      tick();
      if (pending.size === 0 && store.listQueued().length === 0) {
        const running = store.countRunning();
        if (running === 0) return;
        // 可能别的进程正在跑，等一轮
        await new Promise((r) => setTimeout(r, 200));
        if (store.countRunning() === 0 && pending.size === 0) return;
        continue;
      }
      await new Promise((r) => setTimeout(r, 100));
      if (pending.size === 0) {
        // 全部跑完了但队列里还有（并发受限），继续下一轮
        continue;
      }
      await Promise.allSettled([...pending]);
    }
    return;
  }

  return { ingest, approve, reject, tick, drain, runUntilIdle, pending, ACTIVE_STATUSES };
}
