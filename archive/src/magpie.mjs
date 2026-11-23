// Magpie 对接层：Cabinet 唯一允许「知道有哪些模型」的地方。
//
// 两条通道，冷热分开：
//   热路径（调度循环里会用）→ 网关 HTTP，实测 90ms
//   冷路径（doctor / 诊断）  → CLI，实测 12~40s，绝不能进调度循环
//
// 设计原则：取不到就降级，绝不让 Magpie 挂了导致 Cabinet 跟着挂。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createLogger } from './util.mjs';

const log = createLogger('magpie');

/** 默认网关地址。Magpie 的端口偶尔会变，所以支持配置覆盖和自动探测。 */
const DEFAULT_GATEWAY = 'http://127.0.0.1:3425/v1';

/** 模型清单缓存时长：网关只要 90ms，没必要缓存太久，但避免每 tick 都打。 */
const MODELS_TTL_MS = 5 * 60 * 1000;
/** 额度缓存时长：CLI 要 12 秒，必须长缓存 + 后台刷新。 */
const QUOTA_TTL_MS = 10 * 60 * 1000;
/** 网关不响应时的冷却，避免每个 tick 都卡在连接超时上。 */
const FAILURE_COOLDOWN_MS = 60 * 1000;

/**
 * 建 Magpie 客户端。
 * @param {object} opts
 * @param {string} [opts.gateway]   网关地址，默认探测
 * @param {string} [opts.cliPath]   magpie 可执行文件路径（只有冷路径用）
 * @param {number} [opts.timeoutMs] 单次 HTTP 超时
 */
export function createMagpie(opts = {}) {
  const cfg = {
    gateway: (opts.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, ''),
    cliPath: opts.cliPath ?? null,
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 5000,
  };

  const cache = {
    models: { at: 0, data: null, error: null },
    quota: { at: 0, data: null, error: null, inflight: null },
    gatewayDownUntil: 0,
  };

  // ---------- 网关（热路径） ----------

  /** 带超时的 GET。Node 内置 fetch + AbortSignal.timeout，零依赖。 */
  async function httpGet(url, timeoutMs = cfg.timeoutMs) {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  /** 探测网关是否活着。会更新冷却窗口。 */
  async function probeGateway(timeoutMs = 1500) {
    if (Date.now() < cache.gatewayDownUntil) return false;
    try {
      await httpGet(`${cfg.gateway}/models`, timeoutMs);
      return true;
    } catch {
      cache.gatewayDownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      return false;
    }
  }

  /**
   * 拿全部可用模型（热路径）。
   * 走网关 /v1/models，返回归一化后的结构；失败返回 null（调用方自己决定降级）。
   * @returns {Promise<{models: Array, groups: Array, at: string}|null>}
   */
  async function listModels({ force = false } = {}) {
    const fresh = Date.now() - cache.models.at < MODELS_TTL_MS;
    if (!force && fresh && cache.models.data) return cache.models.data;
    if (Date.now() < cache.gatewayDownUntil) {
      return cache.models.data; // 有旧数据就给旧的，没有就 null
    }

    try {
      const raw = await httpGet(`${cfg.gateway}/models`);
      const data = normalizeModels(raw);
      cache.models = { at: Date.now(), data, error: null };
      return data;
    } catch (err) {
      cache.gatewayDownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      cache.models.error = err.message;
      log.warn(`读模型清单失败（${err.message}），${cache.models.data ? '用旧缓存' : '无缓存可用'}`);
      return cache.models.data;
    }
  }

  /** 把网关的 model 数组拆成「具体模型」和「routing group」两类。 */
  function normalizeModels(raw) {
    const list = Array.isArray(raw?.data) ? raw.data : [];
    const models = [];
    const groups = [];
    for (const m of list) {
      const id = String(m.id ?? '');
      if (!id) continue;
      const item = {
        id,
        label: m.display_name ?? m.magpie_label ?? id,
        contextLength: m.context_length ?? m.context_window ?? null,
        reasoning: m.reasoning === true,
        reasoningLevels: Array.isArray(m.reasoning_levels) ? m.reasoning_levels : [],
        modalities: m.modalities?.input ?? null,
        ownedBy: m.owned_by ?? null,
      };
      // routing group 单独归一类：给拆解器选「自动路由」时用
      if (m.magpie_label && /routing group/i.test(m.magpie_label)) groups.push(item);
      else models.push(item);
    }
    return { models, groups, at: new Date().toISOString() };
  }

  // ---------- CLI（冷路径，只给 doctor / 诊断用） ----------

  /** 跑一次 magpie CLI，返回 stdout。带超时，失败返回 { ok:false, error }。 */
  function runCli(args, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve) => {
      const exe = cfg.cliPath ?? findMagpieExe();
      if (!exe) {
        resolve({ ok: false, error: '找不到 magpie 可执行文件（配置 magpie.cliPath 指定）' });
        return;
      }
      let child;
      try {
        child = spawn(exe, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ ok: false, error: `spawn 失败: ${err.message}` });
        return;
      }

      let stdout = '';
      let stderr = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: `超时 ${timeoutMs}ms` });
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));

      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });

      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // magpie 会往 stderr 打插件日志，那不是错误，别被它带偏
        if (code !== 0) {
          resolve({ ok: false, error: `退出码 ${code}: ${cleanLogs(stderr || stdout).slice(0, 300)}` });
          return;
        }
        resolve({ ok: true, stdout: cleanLogs(stdout) });
      });
    });
  }

  /**
   * 把 magpie 的 JSON 输出从插件日志里剥出来。
   * 它会在 stderr 打 "plugin: host starts with ..."，偶尔也漏进 stdout。
   */
  function cleanLogs(text) {
    const s = String(text ?? '');
    const i = s.search(/^\s*[[{]/m);
    if (i < 0) return s.trim();
    return s.slice(i).trim();
  }

  /** 从 CLI 输出里解析 JSON；解析不了返回 null。 */
  function parseCliJson(result) {
    if (!result?.ok) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      return null;
    }
  }

  /**
   * 读额度（冷路径 + 长缓存）。
   * 12 秒的 CLI，绝不能同步等。首次返回 null，后台刷新，下次就有。
   * @returns {object|null} 立即可用的数据（可能是旧的）
   */
  function quotaSnapshot() {
    return cache.quota.data;
  }

  /**
   * 触发一次后台额度刷新。已经在跑就不重复起。
   * @returns {Promise<object|null>} 刷新完的数据；失败返回旧数据
   */
  function refreshQuota({ force = false } = {}) {
    const fresh = Date.now() - cache.quota.at < QUOTA_TTL_MS;
    if (!force && fresh && cache.quota.data) return Promise.resolve(cache.quota.data);
    if (cache.quota.inflight) return cache.quota.inflight;

    const p = (async () => {
      const res = await runCli(['quota', '--json'], { timeoutMs: 90_000 });
      const parsed = parseCliJson(res);
      if (!parsed) {
        cache.quota.error = res.error ?? '输出不是合法 JSON';
        log.warn(`读额度失败: ${cache.quota.error}`);
        return cache.quota.data;
      }
      const data = normalizeQuota(parsed);
      cache.quota = { at: Date.now(), data, error: null, inflight: null };
      return data;
    })()
      .catch((err) => {
        cache.quota.error = err.message;
        return cache.quota.data;
      })
      .finally(() => {
        cache.quota.inflight = null;
      });

    cache.quota.inflight = p;
    return p;
  }

  /** 额度归一化：只留调度器需要的字段，别把整坨塞进内存。 */
  function normalizeQuota(list) {
    const arr = Array.isArray(list) ? list : [];
    const providers = arr.map((p) => ({
      provider: p.provider ?? null,
      kind: p.kind ?? null,
      plan: p.plan ?? null,
      balance: p.balance ?? null,
      windows: (p.windows ?? []).map((w) => ({
        name: w.name ?? null,
        used: typeof w.used === 'number' ? w.used : null,
        remaining: typeof w.remaining === 'number' ? w.remaining : null,
        resetsAt: w.resetsAt ?? null,
      })),
      readAt: p.readAt ?? null,
    }));
    return { providers, at: new Date().toISOString() };
  }

  /**
   * 是否该给调度器踩刹车。
   * 判据：任一 provider 的最紧窗口剩余低于阈值。
   * 阈值可配，默认 15%。
   */
  function isThrottled(thresholdPct = 15) {
    const data = cache.quota.data;
    if (!data) return { throttled: false, reason: '没有额度数据，不拦' };
    for (const p of data.providers) {
      for (const w of p.windows) {
        if (w.remaining == null) continue;
        if (w.remaining < thresholdPct) {
          return {
            throttled: true,
            reason: `${p.provider} 的「${w.name}」只剩 ${w.remaining.toFixed(0)}%`,
            provider: p.provider,
            window: w.name,
            remaining: w.remaining,
            resetsAt: w.resetsAt,
          };
        }
      }
    }
    return { throttled: false };
  }

  // ---------- 诊断（doctor 用） ----------

  /**
   * 探测本机的 agent 与当前模型。慢（CLI），只在 doctor / 手工诊断时调。
   * @returns {Promise<{ok:boolean, agents:Array, error?:string}>}
   */
  async function listAgents() {
    const res = await runCli(['ls'], { timeoutMs: 90_000 });
    if (!res.ok) return { ok: false, agents: [], error: res.error };
    const agents = parseLs(res.stdout);
    return { ok: true, agents };
  }

  /** 造一个可用模型 id 作为兜底（拆解器没指定时用）。 */
  function pickDefaultModel() {
    const data = cache.models.data;
    if (!data) return null;
    // 优先 routing group：它是 Magpie 自己的智能路由，最省心
    if (data.groups.length > 0) return data.groups[0].id;
    return data.models[0]?.id ?? null;
  }

  /** 该模型支持哪些推理强度。 */
  function reasoningLevelsOf(modelId) {
    const data = cache.models.data;
    if (!data) return null;
    const all = [...data.models, ...data.groups];
    return all.find((m) => m.id === modelId)?.reasoningLevels ?? null;
  }

  return {
    gateway: cfg.gateway,
    probeGateway,
    listModels,
    reasoningLevelsOf,
    pickDefaultModel,
    quotaSnapshot,
    refreshQuota,
    isThrottled,
    listAgents,
    runCli,
    _cache: cache,
  };
}

/**
 * 解析 `magpie ls` 的表格输出。
 * 形如：  Codex              gpt-6.1-sol  ·  effort low          ~\.codex\config.toml
 * 列宽动态，按「两个以上空格」切，不按固定位置。
 */
export function parseLs(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/plugin: host starts/i.test(line)) continue;
    if (/^\s*(agent|name)\b/i.test(line)) continue;
    const m = /^\s{2}(\S.*?)\s{2,}(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const rest = m[2].trim();
    if (!name || /^[-=]+$/.test(name)) continue;
    const model = rest.split(/\s{2,}/)[0].split('·')[0].trim();
    out.push({ name, model: model === '—' || model === '-' ? null : model, raw: rest });
  }
  return out;
}

/** 把 magpie 的 JSON 从插件日志里剥出来。 */
export function stripMagpieLogs(text) {
  const s = String(text ?? '');
  const i = s.search(/^\s*[[{]/m);
  return i < 0 ? s.trim() : s.slice(i).trim();
}

/** 找 magpie 可执行文件。按常见安装位置猜，找不到返回 null。 */
export function findMagpieExe() {
  if (process.env.MAGPIE_PATH) return process.env.MAGPIE_PATH;
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'magpie-windows-amd64.exe' : 'magpie';
  const candidates = [
    isWin ? 'D:/Tools/magpie' : '/opt/homebrew/bin',
    path.join(os.homedir(), 'Tools', 'magpie'),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const dir of candidates) {
    const p = path.join(dir, exe);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}
