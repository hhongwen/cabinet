#!/usr/bin/env node
// Cabinet CLI。所有子命令都是「进程短命」的：起 runtime、干活、退出。
// 只有 start 是常驻的。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import {
  CABINET_ROOT,
  DEFAULT_CONFIG_PATH,
  expandAgentArgs,
  loadConfig,
  prepareDirs,
} from '../src/config.mjs';
import { openDb, createStore } from '../src/db.mjs';
import { RuleStore } from '../src/rules.mjs';
import { createRuntime } from '../src/hub.mjs';
import { parseJson, fmtTime, fmtDuration, pad, truncate, tailFile } from '../src/util.mjs';

const argv = process.argv.slice(2);
const command = argv[0];

function parseFlags(list) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = list[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

const { flags, rest } = parseFlags(argv.slice(1));

const C = process.stdout.isTTY
  ? {
      reset: '\x1b[0m',
      dim: '\x1b[2m',
      bold: '\x1b[1m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[36m',
      gray: '\x1b[90m',
    }
  : { reset: '', dim: '', bold: '', red: '', green: '', yellow: '', blue: '', gray: '' };

const ok = (m) => `${C.green}✓${C.reset} ${m}`;
const bad = (m) => `${C.red}✗${C.reset} ${m}`;
const warn = (m) => `${C.yellow}!${C.reset} ${m}`;

/** 配置文件优先级：--config > 环境变量 CABINET_CONFIG > 项目根 cabinet.config.json */
function configPath() {
  const fromFlag = flags.config ? path.resolve(String(flags.config)) : null;
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.CABINET_CONFIG;
  if (fromEnv) return path.resolve(String(fromEnv));
  return DEFAULT_CONFIG_PATH;
}

function loadCfg() {
  const cfg = loadConfig(configPath());
  prepareDirs(cfg);
  return cfg;
}

/* ------------------------------------------------------------------ doctor */
function cmdDoctor() {
  const results = [];
  const push = (good, label, detail = '') => results.push({ good, label, detail });

  // 1. node 版本
  const major = Number(process.versions.node.split('.')[0]);
  push(major >= 22, `Node ${process.versions.node}`, major >= 22 ? '' : '需要 >= 22（node:sqlite）');
  push(
    typeof process.versions.node === 'string' && major >= 24,
    `node:sqlite 可用性`,
    major >= 24 ? '内置，无需 flag' : 'Node 22 需要 --experimental-sqlite',
  );

  // 2. 配置文件
  let cfg = null;
  const cfgPath = configPath();
  if (!fs.existsSync(cfgPath)) {
    push(false, `配置文件 ${cfgPath}`, '不存在');
  } else {
    try {
      cfg = loadConfig(cfgPath);
      push(true, `配置文件 ${path.basename(cfgPath)}`, `port=${cfg.port} workers=${cfg.workers}`);
    } catch (err) {
      push(false, `配置文件解析`, err.message);
    }
  }

  // 3. 目录
  if (cfg) {
    try {
      prepareDirs(cfg);
      push(true, `logs 目录`, cfg._meta.logsDir);
    } catch (err) {
      push(false, `logs 目录`, err.message);
    }
    try {
      const parent = path.dirname(cfg._meta.dbPath);
      fs.mkdirSync(parent, { recursive: true });
      const test = path.join(parent, `.cabinet-write-test-${process.pid}`);
      fs.writeFileSync(test, 'x');
      fs.rmSync(test, { force: true });
      push(true, `db 目录可写`, parent);
    } catch (err) {
      push(false, `db 目录可写`, err.message);
    }
  }

  // 4. 规则文件
  if (cfg) {
    const rs = new RuleStore(cfg._meta.rulesPath);
    const res = rs.load();
    if (!fs.existsSync(cfg._meta.rulesPath)) {
      push(false, `规则文件 ${cfg._meta.rulesPath}`, '不存在（可 cp rules.example.json rules.json）');
    } else if (res.error) {
      push(false, `规则文件解析`, res.error);
    } else {
      push(true, `规则文件 ${res.rules.length} 条`, `← ${cfg._meta.rulesPath}`);
    }
    if (res.rules.length) {
      for (const r of res.rules) {
        push(true, `  规则 ${r.id}`, `agent=${r.agent} approval=${r.approval ?? 'never'}${r.concurrency ? ` 并发=${r.concurrency.key}:${r.concurrency.max}` : ''}`);
      }
    }
  }

  // 5. db 能否打开
  if (cfg) {
    try {
      const db = openDb(cfg._meta.dbPath);
      const store = createStore(db);
      const n = store.stats().total;
      store.close();
      push(true, `SQLite 可打开`, `${cfg._meta.dbPath}（${n} 个历史 job）`);
    } catch (err) {
      push(false, `SQLite 可打开`, err.message);
    }
  }

  // 6. agent 可执行文件
  if (cfg) {
    const agents = expandAgentArgs(cfg.agents);
    for (const [name, agent] of Object.entries(agents)) {
      const probe = probeAgent(agent, cfg._meta.baseDir);
      push(probe.ok, `agent ${name}`, probe.detail);
      for (const hint of probe.hints ?? []) push(true, '  ↳ 提示', hint);
    }
    if (Object.keys(agents).length === 0) push(false, 'agents 配置', '一个都没有');
  }

  // 7. 端口占用
  if (cfg) {
    const used = isPortBusy(cfg.host, cfg.port);
    push(!used, `端口 ${cfg.host}:${cfg.port}`, used ? '已被占用（hub 可能已经在跑）' : '空闲');
  }

  // 输出
  console.log(`\n${C.bold}Cabinet doctor${C.reset}  ${C.gray}${CABINET_ROOT}${C.reset}\n`);
  let fails = 0;
  for (const r of results) {
    if (!r.good) fails++;
    const line = r.good ? ok(r.label) : bad(r.label);
    console.log(`${line}${r.detail ? ` ${C.gray}${r.detail}${C.reset}` : ''}`);
  }
  console.log('');
  if (fails === 0) {
    console.log(`${C.green}全部通过${C.reset} 可以 start 了`);
  } else {
    console.log(`${C.red}${fails} 项有问题${C.reset}，见上面 ✗`);
  }
  return fails === 0 ? 0 : 1;
}

/** 检查 agent 的 command/args 是否可执行。.js 入口用 node 跑时检查文件存在。 */
function probeAgent(agent, baseDir) {
  const cmd = agent.command;
  if (!cmd) return { ok: false, detail: '缺少 command' };
  const base = path.basename(cmd).toLowerCase();
  const firstArg = agent.args?.[0];

  // node <script.js> 或 node <pkg/bin.js> 形式：检查脚本存在
  if ((base === 'node' || base === 'node.exe') && firstArg && /\.(c|m)?js$/i.test(String(firstArg))) {
    const raw = String(firstArg);
    const scriptPath = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseDir ?? CABINET_ROOT, raw);
    if (fs.existsSync(scriptPath)) {
      return { ok: true, detail: `${cmd} ${truncate(scriptPath, 72)}` };
    }
    return {
      ok: false,
      detail: `脚本不存在: ${scriptPath}`,
      hints: [
        'codex 没装的话：npm i -g @openai/codex',
        '或把 agents.*.args[0] 改成实际路径（支持 %APPDATA% / ~ 展开）',
      ],
    };
  }

  // 裸命令：先看是不是绝对路径，再查 PATH
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return { ok: true, detail: cmd };
  const found = whichSync(cmd);
  if (found) return { ok: true, detail: `${found}` };
  return { ok: false, detail: `PATH 里找不到 ${cmd}`, hints: [`which ${cmd} 看看装没装`] };
}

function whichSync(cmd) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, cmd + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function isPortBusy(host, port) {
  const res = spawnSync(
    process.execPath,
    [
      '-e',
      `const net=require('net');const s=net.connect(${Number(port)}, ${JSON.stringify(host)});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>{s.destroy();process.exit(1)},1500);`,
    ],
    { encoding: 'utf8' },
  );
  return res.status === 0;
}

/* ------------------------------------------------------------------- start */
async function cmdStart() {
  const cfg = loadCfg();
  const { startHub } = await import('../src/hub.mjs');
  const port = flags.port ? Number(flags.port) : undefined;
  const hub = await startHub(cfg, { port });

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 兜底：收尾卡住也要退出
    setTimeout(() => process.exit(0), 6000).unref?.();
    hub.close(sig).then(
      () => process.exit(0),
      (err) => {
        console.error(`收尾出错: ${err.message}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error(`未捕获异常: ${err.stack ?? err.message}`);
  });
  process.on('unhandledRejection', (err) => {
    console.error(`未处理的 rejection: ${err?.stack ?? err}`);
  });

  // 前台常驻：靠 interval 撑住事件循环（http server 也会撑）
  await new Promise(() => {});
}

/* -------------------------------------------------------------------- emit */
async function cmdEmit() {
  const cfg = loadCfg();
  if (!flags.source) {
    console.error('用法: emit --source cli --type manual --subject test --summary "..." [--link url] [--payload json]');
    return 2;
  }
  const payload = flags.payload ? parseJson(String(flags.payload), null) : null;
  if (flags.payload && payload === null) {
    console.error(`--payload 不是合法 JSON: ${flags.payload}`);
    return 2;
  }

  const rt = createRuntime(cfg);
  const ev = {
    source: String(flags.source),
    type: String(flags.type ?? 'manual'),
    subject: flags.subject == null ? null : String(flags.subject),
    summary: flags.summary == null ? null : String(flags.summary),
    link: flags.link == null ? null : String(flags.link),
    payload,
    dedupe_key: flags['dedupe-key'] ? String(flags['dedupe-key']) : null,
  };

  const res = rt.queue.ingest(ev);
  console.log(`事件 ${res.eventId} → ${res.action}${res.jobId ? ` (job ${res.jobId})` : ''}`);

  if (res.action === 'no_rule') {
    console.log(warn('没有命中任何规则，检查 rules.json 的 catch-all'));
    rt.store.close();
    return 1;
  }
  if (res.action === 'duplicate') {
    console.log(warn(`同一事件还在处理中，已合并到 ${res.jobId}`));
    rt.store.close();
    return 0;
  }

  // --yes：直接放行审批，一路跑完
  if (flags.yes || flags.y) {
    const job = rt.store.getJob(res.jobId);
    if (job?.status === 'awaiting_approval') {
      rt.queue.approve(res.jobId, 'CLI --yes 自动放行');
      console.log(`${C.gray}已自动放行审批${C.reset}`);
    }
  }

  const awaiting = rt.store.getJob(res.jobId)?.status === 'awaiting_approval';
  if (awaiting) {
    // 停在审批，不起服务也能跑：直接跑 queue 的调度直到没有可跑的
    rt.store.close();
    printJobBrief(res.jobId, cfg);
    console.log('');
    console.log(warn(`这个规则要事前审批（approval: before），job 停在 awaiting_approval。`));
    console.log(`  放行: node bin/cabinet.mjs approve ${res.jobId}`);
    console.log(`  拒绝: node bin/cabinet.mjs reject ${res.jobId} --note "不需要"`);
    console.log(`  下次想一路跑完: 加 --yes`);
    return 0;
  }

  console.log(`${C.gray}开始执行...${C.reset}`);
  await rt.queue.runUntilIdle();
  const job = rt.store.getJob(res.jobId);
  rt.store.close();
  console.log('');
  console.log(`job      ${job.id}`);
  console.log(`规则     ${job.rule_id}  (agent=${job.agent})`);
  console.log(`状态     ${statusColored(job.status)}`);
  console.log(`耗时     ${fmtDuration(job.started_at && job.ended_at ? new Date(job.ended_at) - new Date(job.started_at) : null)}`);
  if (job.exit_code != null) console.log(`退出码   ${job.exit_code}`);
  if (job.error) {
    console.log(`${C.red}错误${C.reset}`);
    console.log(indentBlock(clipLines(job.error, 12, 900)));
  }
  if (job.last_message) {
    console.log(`${C.bold}结论${C.reset}`);
    console.log(indentBlock(job.last_message, 2));
  } else {
    console.log(`${C.gray}（没有拿到结论，检查 logs: ${job.log_path}）${C.reset}`);
  }
  return job.status === 'failed' ? 1 : 0;
}

function printJobBrief(jobId, cfg) {
  const store = createStore(openDb(cfg._meta.dbPath));
  const job = store.getJob(jobId);
  store.close();
  if (!job) return;
  console.log('');
  console.log(`job    ${job.id}`);
  console.log(`规则   ${job.rule_id}  (agent=${job.agent})`);
  console.log(`状态   ${statusColored(job.status)}`);
  if (job.cwd) console.log(`cwd    ${job.cwd}`);
}

function statusColored(status) {
  const map = {
    queued: C.gray,
    awaiting_approval: C.yellow,
    running: C.blue,
    review: C.yellow,
    done: C.green,
    accepted: C.green,
    failed: C.red,
    rejected: C.gray,
    interrupted: C.gray,
  };
  return `${map[status] ?? ''}${status}${C.reset}`;
}

function indentBlock(text, n = 2) {
  const sp = ' '.repeat(n);
  return String(text)
    .trimEnd()
    .split(/\r?\n/)
    .map((l) => sp + l)
    .join('\n');
}

/* -------------------------------------------------------------------- jobs */
function cmdJobs() {
  const cfg = loadCfg();
  const store = createStore(openDb(cfg._meta.dbPath));
  const limit = Number(flags.limit ?? 30);
  const jobs = store.listJobs({ status: flags.status ? String(flags.status) : undefined, limit });
  if (jobs.length === 0) {
    console.log(C.gray + '（没有任务）' + C.reset);
    store.close();
    return 0;
  }
  const rows = [['ID', 'STATUS', 'RULE', 'AGENT', 'SUMMARY', 'CREATED']];
  for (const j of jobs) {
    const ev = j.event_id ? store.getEvent(j.event_id) : null;
    rows.push([
      j.id,
      `${j.needs_attention ? '＊' : ' '}${j.status}`,
      j.rule_id ?? '-',
      j.agent ?? '-',
      truncate(ev?.summary ?? ev?.subject ?? '-', 40),
      fmtTime(j.created_at),
    ]);
  }
  store.close();

  const widths = [0, 1, 2, 3, 4].map((c) => Math.max(...rows.map((r) => displayWidthLocal(r[c]))));
  for (const [i, r] of rows.entries()) {
    const line = r
      .map((cell, c) => (c === r.length - 1 ? cell : pad(cell, widths[c])))
      .join('  ');
    if (i === 0) console.log(`${C.bold}${line}${C.reset}`);
    else console.log(line.replace(/^(\s*)＊/, `$1${C.red}＊${C.reset}`));
  }
  console.log(`\n${C.gray}共 ${jobs.length} 条  ＊=需要你留意${C.reset}`);
  return 0;
}

function displayWidthLocal(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}

/* -------------------------------------------------------------------- show */
function cmdShow() {
  const id = rest[0] ?? flags.id;
  if (!id) {
    console.error('用法: show <jobId>');
    return 2;
  }
  const cfg = loadCfg();
  const store = createStore(openDb(cfg._meta.dbPath));
  const job = store.getJob(String(id));
  if (!job) {
    console.error(bad(`找不到 job: ${id}`));
    store.close();
    return 1;
  }
  const ev = job.event_id ? store.getEvent(job.event_id) : null;
  store.close();

  const line = (k, v) => console.log(`${C.gray}${pad(k, 14)}${C.reset}${v ?? C.gray + '-' + C.reset}`);
  console.log('');
  console.log(`${C.bold}job ${job.id}${C.reset}`);
  line('状态', statusColored(job.status) + (job.needs_attention ? `  ${C.red}需要留意${C.reset}` : ''));
  line('规则', job.rule_id ?? '-');
  line('agent', `${job.agent}${job.model ? ` model=${job.model}` : ''}${job.sandbox ? ` sandbox=${job.sandbox}` : ''}`);
  line('cwd', job.cwd ?? '-');
  line('事件', ev ? `${ev.source}/${ev.type}/${ev.subject ?? '-'}` : '-');
  if (ev?.summary) line('摘要', ev.summary);
  if (ev?.link) line('链接', ev.link);
  line('创建', fmtTime(job.created_at));
  line('开始', fmtTime(job.started_at));
  line('结束', fmtTime(job.ended_at));
  line('耗时', fmtDuration(job.started_at && job.ended_at ? new Date(job.ended_at) - new Date(job.started_at) : null));
  line('退出码', job.exit_code != null ? job.exit_code : '-');
  if (job.duplicate_count) line('重复合并', `${job.duplicate_count} 次`);
  if (job.decision) line('决策', `${job.decision}${job.decision_note ? ` — ${job.decision_note}` : ''}`);
  if (job.command) line('命令', C.gray + truncate(job.command, 160) + C.reset);
  line('日志', job.log_path ?? '-');

  if (job.error) {
    console.log(`\n${C.red}${C.bold}错误${C.reset}`);
    console.log(indentBlock(job.error));
  }

  console.log(`\n${C.bold}prompt${C.reset}`);
  console.log(indentBlock(job.prompt ?? '-'));

  console.log(`\n${C.bold}结论${C.reset}`);
  console.log(indentBlock(job.last_message ?? C.gray + '（空）' + C.reset));

  const tail = tailFile(job.transcript_path, 40);
  console.log(`\n${C.bold}transcript 尾部 40 行${C.reset} ${C.gray}${job.transcript_path ?? ''}${C.reset}`);
  if (tail) {
    console.log(tail);
  } else {
    // 没有 JSONL 就退回去看日志尾部
    const logTail = tailFile(job.log_path, 40);
    console.log(logTail ? `${C.gray}(无 JSONL，显示日志尾部)${C.reset}\n${logTail}` : C.gray + '（空）' + C.reset);
  }
  console.log('');
  return 0;
}

/* ------------------------------------------------------- approve / reject */
async function cmdDecide(verb) {
  const id = rest[0] ?? flags.id;
  if (!id) {
    console.error(`用法: ${verb} <jobId> [--note "说明"]`);
    return 2;
  }
  const cfg = loadCfg();
  // 审批时如果 hub 正在跑，它会自己 tick 拉起；这里也顺手推一次，方便没起 hub 时直接用 CLI 跑完
  const rt = createRuntime(cfg);
  let res;
  try {
    res = verb === 'approve' ? rt.queue.approve(String(id), flags.note ?? null) : rt.queue.reject(String(id), flags.note ?? null);
    console.log(`${verb === 'approve' ? ok('已放行') : warn('已拒绝')} job ${id} → ${statusColored(res.status)}`);
  } catch (err) {
    console.error(bad(err.message));
    rt.store.close();
    return 1;
  }

  if (res.status !== 'queued') {
    rt.store.close();
    return 0;
  }

  // 放行了：在当前进程里等它跑完（等不到也不影响 hub 那边的调度）
  const deadline = Date.now() + Number(flags.timeout ?? 20 * 60 * 1000);
  let last = null;
  while (Date.now() < deadline) {
    rt.queue.tick();
    const job = rt.store.getJob(String(id));
    if (!job) break;
    last = job;
    if (['done', 'failed', 'review', 'accepted', 'rejected', 'interrupted'].includes(job.status)) {
      rt.store.close();
      return printDone(String(id), job);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  rt.store.close();
  if (last) {
    console.log(warn(`等待超时，job 仍在 ${last.status}；hub 在跑的话它会接手`));
    return 0;
  }
  return 0;
}

function printDone(jobId, job) {
  console.log('');
  console.log(`job    ${jobId}`);
  console.log(`状态   ${statusColored(job.status)}`);
  console.log(`耗时   ${fmtDuration(job.started_at && job.ended_at ? new Date(job.ended_at) - new Date(job.started_at) : null)}`);
  if (job.error) {
    // 错误可能多行（stderr 尾巴），保留换行
    console.log(`${C.red}错误${C.reset}`);
    console.log(indentBlock(clipLines(job.error, 12, 900)));
  }
  if (job.last_message) {
    console.log(`${C.bold}结论${C.reset}`);
    console.log(indentBlock(job.last_message));
  } else {
    console.log(`${C.gray}（无结论，看日志 ${job.log_path}）${C.reset}`);
  }
  return job.status === 'failed' ? 1 : 0;
}

/** 截断多行文本：最多 n 行、total 个字符。 */
function clipLines(text, n = 10, total = 800) {
  const s = String(text ?? '');
  const lines = s.split(/\r?\n/);
  const kept = lines.slice(0, n).join('\n');
  const out = kept.length > total ? kept.slice(0, total) + '…' : kept;
  return lines.length > n ? out + `\n…（还有 ${lines.length - n} 行，见日志）` : out;
}

/* ------------------------------------------------------------------- stats */
function cmdStats() {
  const cfg = loadCfg();
  const store = createStore(openDb(cfg._meta.dbPath));
  const s = store.stats();
  store.close();

  console.log(`\n${C.bold}Cabinet 统计${C.reset}\n`);
  console.log(`总计 ${C.bold}${s.total}${C.reset}  今天 ${s.today}  需要留意 ${s.needsAttention ? C.red + s.needsAttention + C.reset : 0}\n`);

  console.log(`${C.bold}按状态${C.reset}`);
  const order = ['queued', 'awaiting_approval', 'running', 'review', 'done', 'accepted', 'failed', 'rejected', 'interrupted'];
  for (const st of order) {
    const n = s.byStatus[st] ?? 0;
    if (n === 0 && !['queued', 'awaiting_approval', 'running', 'review'].includes(st)) continue;
    console.log(`  ${pad(statusColored(st).replace(/\x1b\[[0-9;]*m/g, ''), 18)}${String(n).padStart(4)}`);
  }

  console.log(`\n${C.bold}按规则${C.reset}`);
  const rows = [['RULE', 'TOTAL', 'DONE', 'FAILED', 'AVG']];
  for (const r of s.byRule) {
    rows.push([r.rule_id, String(r.total), String(r.ok), String(r.failed), fmtDuration(r.avgMs)]);
  }
  if (rows.length === 1) rows.push(['-', '0', '0', '0', '-']);
  const w = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => displayWidthLocal(r[c]))));
  for (const [i, r] of rows.entries()) {
    const line = r.map((cell, c) => (c === 4 ? cell : pad(cell, w[c]))).join('  ');
    console.log(i === 0 ? `${C.bold}${line}${C.reset}` : `  ${line}`);
  }
  console.log('');
  return 0;
}

/* -------------------------------------------------------------------- main */
function usage() {
  console.log(`
${C.bold}Cabinet${C.reset} — 单机版个人 Agent 自动化中台

${C.bold}用法${C.reset}
  node bin/cabinet.mjs <命令> [选项]

${C.bold}命令${C.reset}
  doctor                        环境自检（node / agent / 规则 / db / 端口）
  start [--port 8787]           起中台 + worker（前台常驻）
  emit --source <s> --type <t>  手动投一个事件并跑一次
       --subject <s> --summary <text> [--link url] [--payload json] [--yes]
  jobs [--status <s>] [--limit n]  任务列表
  show <jobId>                  任务详情 + transcript 尾部
  approve <jobId> [--note txt]  批
  reject  <jobId> [--note txt]  驳
  stats                         状态计数 + 按规则耗时

${C.bold}全局${C.reset}
  --config <path>               指定配置文件（默认 cabinet.config.json）

${C.bold}示例${C.reset}
  node bin/cabinet.mjs emit --source cli --type manual --subject test --summary "回复两个字：收到"
  node bin/cabinet.mjs approve job_xxx
  node bin/cabinet.mjs jobs --status awaiting_approval
`);
}

async function main() {
  switch (command) {
    case 'doctor':
      process.exitCode = cmdDoctor();
      return;
    case 'start':
      await cmdStart();
      return;
    case 'emit':
      process.exitCode = await cmdEmit();
      return;
    case 'jobs':
    case 'ls':
      process.exitCode = cmdJobs();
      return;
    case 'show':
      process.exitCode = cmdShow();
      return;
    case 'approve':
      process.exitCode = await cmdDecide('approve');
      return;
    case 'reject':
      process.exitCode = await cmdDecide('reject');
      return;
    case 'stats':
      process.exitCode = cmdStats();
      return;
    case 'help':
    case undefined:
    case '--help':
    case '-h':
      usage();
      process.exitCode = 0;
      return;
    default:
      console.error(`未知命令: ${command}\n`);
      usage();
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`${C.red}出错了${C.reset} ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
