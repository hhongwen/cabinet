// 定时事件源。两种写法：
//   { "id":"morning-brief", "type":"schedule.daily", "at":"08:30" }   每天这个点
//   { "id":"poll", "type":"schedule.tick", "every":"15m" }           每 15 分钟
// 规则：同一分钟内只发一次；进程重启不补跑历史（只在启动后用「当前时间之后」的时点）。
import { createLogger, newId, nowIso } from '../util.mjs';

const log = createLogger('cron');

/** 解析 "15m" / "30s" / "2h" / "1d" → 毫秒。纯数字按分钟。 */
export function parseEvery(spec) {
  if (typeof spec === 'number' && spec > 0) return spec * 60_000;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(String(spec ?? '').trim());
  if (!m) throw new Error(`无法解析间隔: ${spec}（支持 30s/15m/2h/1d）`);
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.round(n * mult);
}

/** "08:30" → {hour:8, minute:30}。 */
export function parseAt(spec) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(spec ?? '').trim());
  if (!m) throw new Error(`无法解析时刻: ${spec}（格式 HH:MM）`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`时刻越界: ${spec}`);
  return { hour, minute };
}

/**
 * 构建 cron 源。
 * @param {object} cfg  完整配置
 * @param {(ev:object)=>void} emit  投递事件的回调（一般是 queue.ingest）
 */
export function createCronSource(cfg, emit) {
  const defs = Array.isArray(cfg?.sources?.cron) ? cfg.sources.cron : [];
  const parsed = [];
  const fired = new Set(); // `${id}@${yyyy-mm-dd HH:MM}` 已发标记
  let timer = null;
  let lastMinuteKey = null;

  for (const def of defs) {
    try {
      if (def.at) {
        const { hour, minute } = parseAt(def.at);
        parsed.push({
          id: def.id ?? `cron-${hour}-${minute}`,
          type: def.type ?? 'schedule.daily',
          subject: def.subject ?? def.id ?? 'cron',
          summary: def.summary ?? `定时任务 ${def.id ?? def.at}`,
          mode: 'daily',
          hour,
          minute,
          payload: def.payload ?? null,
        });
      } else if (def.every) {
        const ms = parseEvery(def.every);
        parsed.push({
          id: def.id ?? `cron-${ms}`,
          type: def.type ?? 'schedule.tick',
          subject: def.subject ?? def.id ?? 'cron',
          summary: def.summary ?? `定时任务 ${def.id ?? def.every}`,
          mode: 'every',
          intervalMs: ms,
          nextAt: Date.now() + ms, // 启动后一个周期才第一次触发，不补跑
          payload: def.payload ?? null,
        });
      } else {
        log.warn(`cron 项 ${def.id ?? '(无 id)'} 既没有 at 也没有 every，跳过`);
      }
    } catch (err) {
      log.error(`cron 配置解析失败 ${JSON.stringify(def)}: ${err.message}`);
    }
  }

  function minuteKey(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 每个 tick 检查一次（默认 20s 一次，足够覆盖分钟级）。 */
  function check() {
    const now = new Date();
    const mk = minuteKey(now);

    for (const def of parsed) {
      if (def.mode === 'daily') {
        if (now.getHours() !== def.hour || now.getMinutes() !== def.minute) continue;
        const key = `${def.id}@${mk}`;
        if (fired.has(key)) continue;
        fired.add(key);
        send(def, mk);
      } else {
        if (Date.now() < def.nextAt) continue;
        def.nextAt = Date.now() + def.intervalMs;
        send(def, minuteKey());
      }
    }

    // 清理过老的已发记录，避免无限增长
    if (mk !== lastMinuteKey) {
      lastMinuteKey = mk;
      if (fired.size > 500) {
        const keep = new Set([...fired].slice(-100));
        fired.clear();
        for (const k of keep) fired.add(k);
      }
    }
  }

  function send(def, slot) {
    const ev = {
      id: newId('evt'),
      source: 'cron',
      type: def.type,
      subject: def.subject,
      summary: def.summary,
      link: null,
      payload: { cronId: def.id, firedAt: nowIso(), slot, ...(def.payload ?? {}) },
      // 去重键带上时间槽：同一个 job 没跑完时再来一次会被 queue 合并
      dedupe_key: `${def.id}@${slot}`,
      received_at: nowIso(),
    };
    log.info(`cron 触发 ${def.id} (${def.type})`);
    fire(ev);
  }

  function fire(ev) {
    try {
      emit(ev);
    } catch (err) {
      log.error(`cron 投递失败: ${err.message}`);
    }
  }

  return {
    name: 'cron',
    start() {
      check(); // 启动立刻对齐一次（刚好处在该分钟内也能发）
      timer = setInterval(check, 20_000);
      timer.unref?.();
      log.info(`cron 启动：${parsed.length} 条定时`);
      for (const d of parsed) {
        log.info(`  - ${d.id} ${d.mode === 'daily' ? `每天 ${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}` : `每 ${d.intervalMs / 60000}m`} → ${d.type}/${d.subject}`);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 测试用：手动推一次检查。 */
    _check: check,
    _defs: parsed,
  };
}
