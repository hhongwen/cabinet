// 中台主体：HTTP 服务 + 面板 + API + 调度循环 + 事件源生命周期。
// 单机版里 hub 和 worker 是同一个进程，所以没有长轮询接单，直接本地派活。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createLogger, nowIso, parseJson } from './util.mjs';
import { CABINET_ROOT, expandAgentArgs } from './config.mjs';
import { createStore, openDb } from './db.mjs';
import { RuleStore } from './rules.mjs';
import { createRunner } from './runner.mjs';
import { createQueue } from './queue.mjs';
import { createNotifier } from './notify.mjs';
import { createCronSource } from './sources/cron.mjs';
import { createWatchSource } from './sources/watch.mjs';
import { createHttpSource } from './sources/http.mjs';

const log = createLogger('hub');

const PUBLIC_DIR = path.join(CABINET_ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** 组装运行时（CLI 和 hub 共用，彼此职责清晰）。 */
export function createRuntime(cfg, { logger = log } = {}) {
  // 先把 agents 里的 %APPDATA% / ~ / ${VAR} 展开好，后面 runner 和 queue 都读展开后的值
  const agents = expandAgentArgs(cfg.agents);
  const runtimeCfg = { ...cfg, agents };

  const store = createStore(openDb(cfg._meta.dbPath));
  const ruleStore = new RuleStore(cfg._meta.rulesPath);
  const rulesResult = ruleStore.load();
  const runner = createRunner(runtimeCfg, store);
  const notifier = createNotifier(cfg);
  const queue = createQueue({ cfg: runtimeCfg, store, ruleStore, runner, notifier });

  return { cfg: runtimeCfg, store, ruleStore, runner, notifier, queue, agents, rulesResult, logger };
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // 防目录穿越
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (!abs.startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, 403, 'forbidden');
    return;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    sendText(res, 404, 'not found');
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(abs).pipe(res);
}

/** 面板要的 job 视图：把 JSON 字符串字段解开，补上事件摘要。 */
function jobView(job, store, { full = false } = {}) {
  if (!job) return null;
  const ev = job.event_id ? store.getEvent(job.event_id) : null;
  const base = {
    id: job.id,
    status: job.status,
    rule_id: job.rule_id,
    agent: job.agent,
    cwd: job.cwd,
    created_at: job.created_at,
    started_at: job.started_at,
    ended_at: job.ended_at,
    needs_attention: !!job.needs_attention,
    duplicate_count: job.duplicate_count ?? 0,
    approval: job.approval,
    model: job.model,
    sandbox: job.sandbox,
    exit_code: job.exit_code,
    error: job.error,
    event: ev
      ? { id: ev.id, source: ev.source, type: ev.type, subject: ev.subject, summary: ev.summary, link: ev.link }
      : null,
    summary: ev?.summary ?? null,
    last_message: job.last_message,
    decision: job.decision,
    decision_note: job.decision_note,
    duration_ms:
      job.started_at && job.ended_at
        ? new Date(job.ended_at).getTime() - new Date(job.started_at).getTime()
        : null,
  };
  if (full) {
    base.prompt = job.prompt;
    base.transcript_path = job.transcript_path;
    base.log_path = job.log_path;
    base.command = job.command;
    base.notify_when = parseJson(job.notify_when, []);
  }
  return base;
}

/**
 * 起 hub。返回 { server, runtime, close }。
 * 前台阻塞直到 SIGINT/SIGTERM。
 */
export async function startHub(cfg, { port } = {}) {
  const rt = createRuntime(cfg);
  const { store, ruleStore, runner, queue, notifier } = rt;

  // 启动清理：上次没跑完的 running 一律标 interrupted（单机版没有别的进程在跑它们）
  const cleaned = store.markRunningInterrupted('进程重启，任务被中断');
  if (cleaned) log.warn(`有 ${cleaned} 个上次未结束的 running job，已标为 interrupted`);

  if (rt.rulesResult.error) log.warn(`规则文件告警: ${rt.rulesResult.error}`);
  log.info(`规则已加载 ${ruleStore.get().length} 条 ← ${cfg._meta.rulesPath}`);

  // 事件源统一往 queue.ingest 投
  const emit = (ev) => queue.ingest(ev);
  const httpSource = createHttpSource({ cfg, queue });
  const sources = [];
  const cron = createCronSource(cfg, emit);
  const watch = createWatchSource(cfg, emit);
  sources.push(cron, watch);

  const startedAt = nowIso();
  let tickTimer = null;
  let tickBusy = false;

  function safeTick() {
    if (tickBusy) return;
    tickBusy = true;
    try {
      // 先热加载规则，再调度
      ruleStore.maybeReload();
      queue.tick();
    } catch (err) {
      log.error(`tick 出错: ${err.stack ?? err.message}`);
    } finally {
      tickBusy = false;
    }
  }

  // ---------- 路由 ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method ?? 'GET';

    try {
      // --- 静态资源 ---
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        serveStatic(res, pathname);
        return;
      }

      // --- 状态 ---
      if (method === 'GET' && pathname === '/api/state') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500);
        const status = url.searchParams.get('status');
        const all = url.searchParams.get('all') === '1';
        const jobs = store
          .listJobs({ status: status || undefined, limit: all ? 1000 : limit })
          .map((j) => jobView(j, store, { full: false }));
        sendJson(res, 200, {
          jobs,
          stats: store.stats(),
          rules: ruleStore.summary(),
          rulesError: ruleStore.error,
          config: {
            port: cfg.port,
            workers: cfg.workers,
            host: cfg.host,
            rulesPath: cfg._meta.rulesPath,
            dbPath: cfg._meta.dbPath,
            logsDir: cfg._meta.logsDir,
            sources: {
              cron: (cfg.sources?.cron ?? []).map((c) => c.id ?? c.type),
              watch: (cfg.sources?.watch ?? []).map((w) => w.subject),
              http: cfg.sources?.http?.enabled !== false,
            },
            agents: Object.keys(cfg.agents ?? {}),
          },
          startedAt,
          now: nowIso(),
        });
        return;
      }

      // --- 单个 job 详情（含 transcript 尾部）---
      const jobDetail = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && jobDetail) {
        const job = store.getJob(jobDetail[1]);
        if (!job) {
          sendJson(res, 404, { ok: false, error: 'job 不存在' });
          return;
        }
        const view = jobView(job, store, { full: true });
        view.transcript_tail = tailTranscript(job.transcript_path, 200);
        view.events = store.listEvents(500).filter((e) => e.job_id === job.id).slice(0, 20);
        sendJson(res, 200, { ok: true, job: view });
        return;
      }

      // --- 审批 ---
      const action = /^\/api\/jobs\/([^/]+)\/(approve|reject)$/.exec(pathname);
      if (method === 'POST' && action) {
        const [, jobId, verb] = action;
        let body = {};
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : {};
        } catch {
          body = {};
        }
        if (!httpSource.checkToken(req)) {
          sendJson(res, 401, { ok: false, error: 'token 无效' });
          return;
        }
        const note = body?.note == null ? null : String(body.note);
        try {
          const result = verb === 'approve' ? queue.approve(jobId, note) : queue.reject(jobId, note);
          // 审批放行的立刻尝试拉起来，别等下一个 tick
          if (result.status === 'queued') safeTick();
          sendJson(res, 200, { ok: true, ...result, job: jobView(store.getJob(jobId), store, { full: true }) });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
        }
        return;
      }

      // --- 收事件 ---
      if (method === 'POST' && pathname === '/api/events') {
        if (!httpSource.enabled) {
          sendJson(res, 404, { ok: false, error: 'http 源已禁用' });
          return;
        }
        if (!httpSource.checkToken(req)) {
          sendJson(res, 401, { ok: false, error: 'token 无效' });
          return;
        }
        let body;
        try {
          const text = await readBody(req);
          body = JSON.parse(text || '{}');
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `JSON 解析失败: ${err.message}` });
          return;
        }
        const result = httpSource.accept(body);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        safeTick();
        sendJson(res, 200, result);
        return;
      }

      // --- 健康检查 ---
      if (method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          uptimeMs: Date.now() - new Date(startedAt).getTime(),
          running: store.countRunning(),
          queued: store.listQueued().length,
          rules: ruleStore.get().length,
          rulesError: ruleStore.error,
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: `没有这个接口: ${method} ${pathname}` });
    } catch (err) {
      log.error(`请求处理失败 ${method} ${pathname}: ${err.stack ?? err.message}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
      else res.end();
    }
  });

  function tailTranscript(file, n) {
    if (!file || !fs.existsSync(file)) return '';
    try {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      return lines.slice(-n).join('\n');
    } catch {
      return '';
    }
  }

  // ---------- 启动 ----------
  const listenPort = Number(port ?? cfg.port ?? 8787);
  const host = cfg.host ?? '127.0.0.1';

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  for (const s of sources) {
    try {
      s.start();
    } catch (err) {
      log.error(`${s.name} 源启动失败: ${err.message}`);
    }
  }

  tickTimer = setInterval(safeTick, Number(cfg.tickMs) > 0 ? Number(cfg.tickMs) : 1000);
  tickTimer.unref?.();
  safeTick(); // 启动就把队列里的活拉起来

  const actualPort = server.address()?.port ?? listenPort;
  // --port 覆盖过的话，让面板和 API 都显示实际端口
  cfg.port = actualPort;
  log.info(`面板: http://${host}:${actualPort}`);
  log.info(`worker 上限 ${cfg.workers}｜db: ${cfg._meta.dbPath}`);
  log.info(`日志: ${cfg._meta.logsDir}`);

  // ---------- 优雅退出 ----------
  let closing = false;
  /** @returns {Promise<void>} 收尾完成（子进程退出 + running 标 interrupted + server 关掉） */
  async function close(reason = 'shutdown') {
    if (closing) return;
    closing = true;
    log.info(`收到 ${reason}，开始收尾...`);
    if (tickTimer) clearInterval(tickTimer);

    // 1. 先停事件源，别再投新事件
    for (const s of sources) {
      try {
        s.stop();
      } catch (err) {
        log.warn(`${s.name} 停止失败: ${err.message}`);
      }
    }

    // 2. 先把 running 标 interrupted —— 必须在 killAll 之前，
    //    否则子进程被杀后 runner 的 close 回调会先把它写成 failed(exit 1)。
    //    finishJob 看到 interrupted 会跳过，不再覆盖。
    const interrupted = (() => {
      try {
        const n = store.markRunningInterrupted(`hub 退出(${reason})，任务被中断`);
        if (n) log.warn(`${n} 个 running job 标记为 interrupted`);
        return n;
      } catch (err) {
        log.warn(`标记 interrupted 失败: ${err.message}`);
        return 0;
      }
    })();

    // 3. 杀掉还在跑的子进程
    try {
      runner.killAll();
    } catch (err) {
      log.warn(`终止子进程失败: ${err.message}`);
    }
    void interrupted;

    // 4. 给子进程一点时间退出（kill 是异步的，等它真正死掉）
    await new Promise((r) => setTimeout(r, 1200));

    // 5. 关 http server，最后关库
    await new Promise((r) => {
      try {
        server.close(() => r());
        // 有 keep-alive 连接时 close 可能一直不回调，兜底
        setTimeout(r, 1500).unref?.();
      } catch {
        r();
      }
    });

    store.close();
    log.info('已退出');
  }

  return {
    server,
    runtime: rt,
    port: actualPort,
    host,
    close,
    store,
    queue,
    ruleStore,
    runner,
    notifier,
  };
}

export { jobView };
