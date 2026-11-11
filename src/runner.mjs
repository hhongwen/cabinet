// 执行层：把 job 变成一次无头 agent 调用。
//
// 两条铁律（Windows 上踩过坑）：
//   1. shell: false —— 绝不经过 cmd.exe，避免 .cmd 引号地狱；
//   2. prompt 走 stdin —— 绝不拼进命令行参数。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, nowIso, truncate, createLogger } from './util.mjs';

const log = createLogger('runner');

/** 这些占位符为 null/空时，把它们所在的「flag + 值」整对剔除。 */
const OPTIONAL_PLACEHOLDERS = new Set(['model', 'sandbox', 'reasoning', 'profile', 'configProfile']);

/** 结论里出现这些字样，说明 agent 在等人拍板。 */
const DECISION_RE = /需要决策\s*[:：]|NEEDS_DECISION/;

/** 是否为「选项」参数（`-x` / `--xx` / `--xx=vv`）。单独一个 `-` 不算（表示 stdin）。 */
function isFlagArg(a) {
  return typeof a === 'string' && a.length > 1 && a.startsWith('-');
}

function isPlaceholderToken(a) {
  return typeof a === 'string' && /^\{[A-Za-z0-9_]+\}$/.test(a);
}

/** 取占位符名，例如 `{cwd}` → `cwd`；不是纯占位符返回 null。 */
function placeholderName(a) {
  if (!isPlaceholderToken(a)) return null;
  return a.slice(1, -1);
}

/**
 * 渲染单个参数里的所有 {xxx}。返回 { text, nulls:Set<name> }。
 * 若整个参数就是一个值为 null 的占位符，text 为 null（表示该参数应被剔除）。
 */
function renderArg(arg, vars) {
  const only = placeholderName(arg);
  if (only) {
    const v = vars[only];
    if (v === undefined || v === null || v === '') return { text: null, missing: only };
    return { text: String(v), missing: null };
  }
  let missing = null;
  const text = arg.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') {
      if (OPTIONAL_PLACEHOLDERS.has(name)) missing = name;
      return '';
    }
    return String(v);
  });
  return { text, missing };
}

/**
 * 拼命令行。
 * @returns {{ command, args, promptViaStdin, promptArg, env }}
 */
export function buildCommand(agentCfg, job, opts = {}) {
  if (!agentCfg) throw new Error(`未配置 agent: ${job.agent}`);
  const promptViaStdin = agentCfg.promptViaStdin !== false; // 默认走 stdin
  const vars = {
    cwd: job.cwd ?? null,
    sandbox: job.sandbox ?? null,
    model: job.model ?? null,
    reasoning: job.reasoning ?? null,
    lastMessageFile: job.last_message_file ?? null,
    prompt: promptViaStdin ? null : (job.prompt ?? ''),
  };

  const rawArgs = Array.isArray(agentCfg.args) ? agentCfg.args : [];
  const rendered = rawArgs.map((a) => renderArg(String(a), vars));

  const args = [];
  for (let i = 0; i < rendered.length; i++) {
    const cur = rendered[i];
    const raw = String(rawArgs[i]);

    if (cur.text === null) {
      // 整个参数就是 null 占位符：它和前面那个 flag 一起删掉（若前面是 flag）
      const prev = args.length > 0 ? args[args.length - 1] : null;
      const prevWasFlag = prev && isFlagArg(prev) && !prev.includes('=');
      if (prevWasFlag) {
        // 只有当前占位符是「可选」的，才连带删 flag；必填的（cwd/prompt）保留空值更安全
        const name = placeholderName(raw);
        if (OPTIONAL_PLACEHOLDERS.has(name)) args.pop();
      }
      continue;
    }

    // `--flag={model}` 且 model 为 null → 整个参数剔除
    if (cur.missing && OPTIONAL_PLACEHOLDERS.has(cur.missing)) {
      const name = cur.missing;
      if (raw.includes(`{${name}}`) && !raw.startsWith('{')) {
        // 形如 "--opt={model}"：整条丢掉
        continue;
      }
    }
    if (cur.missing) continue; // 含可选占位符但没解析出来，丢掉这个参数

    args.push(cur.text);
  }

  const command = agentCfg.command;
  if (!command) throw new Error(`agent ${job.agent} 缺少 command`);

  const env = {
    ...process.env,
    // 子进程里禁用分页/颜色/交互，避免挂住
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    NO_COLOR: '1',
    CI: process.env.CI ?? '1',
    ...(agentCfg.env ?? {}),
  };

  return {
    command,
    args,
    promptViaStdin,
    // 不走 stdin 时 prompt 作为最后一个位置参数（上面 args 里若用 {prompt} 已替换好）
    promptArg: promptViaStdin ? null : (job.prompt ?? ''),
    env,
  };
}

/** 从一行 JSON（codex --json 的 JSONL）里挖出 assistant 文本，格式不匹配返回 null。 */
export function extractAssistantText(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // 形态 A（旧版）：{"msg": {"type": "agent_message", "message": "..."}}
  const msg = obj.msg;
  if (msg && typeof msg === 'object') {
    if (msg.type === 'agent_message' && typeof msg.message === 'string') return msg.message;
    if (msg.type === 'agent_message_delta' && typeof msg.delta === 'string') return msg.delta;
  }
  // 形态 B（新版）：{"type":"item.completed","item":{"type":"agent_message","text":"..."}}
  const item = obj.item;
  if (item && typeof item === 'object' && item.type === 'agent_message') {
    if (typeof item.text === 'string') return item.text;
    if (Array.isArray(item.content)) {
      const t = item.content
        .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
        .join('')
        .trim();
      if (t) return t;
    }
  }
  // 形态 C：{"type":"agent_message","message":"..."} 直接平铺
  if (obj.type === 'agent_message') {
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.text === 'string') return obj.text;
  }
  return null;
}

/**
 * 单次运行的执行器。killAll 供优雅退出用。
 */
export function createRunner(cfg, store) {
  const active = new Map(); // jobId -> child

  function logPathFor(job) {
    return job.log_path || path.join(cfg._meta.logsDir, `${job.id}.log`);
  }
  function transcriptPathFor(job) {
    return job.transcript_path || path.join(cfg._meta.logsDir, `${job.id}.transcript.jsonl`);
  }
  function lastMessagePathFor(job) {
    return job.last_message_file || path.join(cfg._meta.logsDir, `${job.id}.last.txt`);
  }

  /**
   * 真正跑一个 job。调用前 job 必须已经是 running（由 queue 抢占）。
   * @returns {Promise<{status, exitCode, lastMessage, error}>} 结果状态
   */
  function start(job, agentCfg) {
    ensureDir(cfg._meta.logsDir);
    const logPath = logPathFor(job);
    const transcriptPath = transcriptPathFor(job);
    const lastMessagePath = lastMessagePathFor(job);

    const prepared = {
      ...job,
      last_message_file: lastMessagePath,
      log_path: logPath,
      transcript_path: transcriptPath,
    };

    let built;
    try {
      built = buildCommand(agentCfg, prepared);
    } catch (err) {
      return Promise.resolve({ status: 'failed', exitCode: null, error: err.message, lastMessage: null });
    }

    store.updateJob(job.id, {
      command: [built.command, ...built.args].map(quoteForDisplay).join(' '),
      log_path: logPath,
      transcript_path: transcriptPath,
      last_message_file: lastMessagePath,
    });

    // 清掉上一轮的产物，避免读到旧结论
    for (const f of [lastMessagePath, transcriptPath]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }

    const logStream = fs.createWriteStream(logPath, { flags: 'w' });
    const writeLog = (chunk) => {
      try {
        logStream.write(chunk);
      } catch {
        /* ignore */
      }
    };
    writeLog(`# cabinet job ${job.id}\n# rule=${job.rule_id} agent=${job.agent}\n`);
    writeLog(`# cwd=${job.cwd} sandbox=${job.sandbox ?? '-'} model=${job.model ?? '-'}\n`);
    writeLog(`# argv: ${JSON.stringify([built.command, ...built.args])}\n`);
    writeLog(`# prompt (${built.promptViaStdin ? 'stdin' : 'arg'}):\n${indent(job.prompt ?? '')}\n# --- output ---\n`);

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(built.command, built.args, {
          cwd: job.cwd || cfg._meta.baseDir,
          env: built.env,
          shell: false, // 绝不 shell
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        logStream.end();
        resolve({ status: 'failed', exitCode: null, error: `spawn 失败: ${err.message}`, lastMessage: null });
        return;
      }

      active.set(job.id, child);
      let stdoutBuf = '';
      let stderrBuf = '';
      let lastAssistant = null;
      let transcriptStream = null;
      let killedByTimeout = false;
      let spawnError = null;

      const timeoutMs = Number(job.timeout_ms ?? cfg.defaultTimeoutMs ?? 15 * 60 * 1000);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              killedByTimeout = true;
              writeLog(`\n# 超时 ${Math.round(timeoutMs / 1000)}s，发送 SIGTERM\n`);
              killTree(child);
            }, timeoutMs)
          : null;

      child.on('error', (err) => {
        spawnError = err;
        writeLog(`\n# 进程错误: ${err.message}\n`);
      });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      // stdout：全量进日志；--json 模式下逐行解析成 transcript
      child.stdout.on('data', (chunk) => {
        writeLog(chunk);
        stdoutBuf += chunk;
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line.trim()) continue;
          handleStdoutLine(line);
        }
      });

      child.stderr.on('data', (chunk) => {
        writeLog(chunk);
        stderrBuf = (stderrBuf + chunk).slice(-8000);
      });

      /** 一行 stdout：能 parse 成 JSON 就当 JSONL 处理，否则忽略（已在日志里）。 */
      function handleStdoutLine(line) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          return;
        }
        if (!transcriptStream) {
          transcriptStream = fs.createWriteStream(transcriptPath, { flags: 'a' });
        }
        transcriptStream.write(line + '\n');
        const text = extractAssistantText(obj);
        if (text) lastAssistant = text;
      }

      function finish(exitCode, signal) {
        if (timer) clearTimeout(timer);
        // 处理最后一行没有换行的 stdout
        if (stdoutBuf.trim()) handleStdoutLine(stdoutBuf.trim().replace(/\r$/, ''));
        active.delete(job.id);
        if (transcriptStream) {
          transcriptStream.end();
          transcriptStream = null;
        }
        writeLog(`\n# --- exit code=${exitCode} signal=${signal ?? '-'} ---\n`);
        logStream.end();

        // 最终结论优先取 lastMessageFile（codex -o），其次 JSONL 里最后一条 assistant
        const fromFile = readIfExists(lastMessagePath);
        let lastMessage = fromFile && fromFile.trim() ? fromFile.trim() : null;
        if (!lastMessage && lastAssistant) lastMessage = lastAssistant.trim();
        if (!lastMessage) lastMessage = null;

        let status;
        let error = null;
        if (spawnError) {
          status = 'failed';
          error = `spawn 失败: ${spawnError.message}`;
        } else if (killedByTimeout) {
          status = 'failed';
          error = `超时 ${Math.round(timeoutMs / 1000)}s 被终止`;
        } else if (exitCode !== 0) {
          status = 'failed';
          const tailText = lastMessage ? `；结论: ${truncate(lastMessage, 200)}` : '';
          error = `退出码 ${exitCode}${signal ? ` (signal ${signal})` : ''}${tailText}\n${truncate(stderrBuf.trim(), 800)}`;
        } else {
          status = 'done';
        }
        resolve({ status, exitCode, error, lastMessage });
      }

      child.on('close', (code, signal) => finish(code, signal));

      // prompt 写入 stdin —— 唯一的传 prompt 方式
      if (built.promptViaStdin) {
        try {
          child.stdin.write(job.prompt ?? '');
          child.stdin.end();
        } catch (err) {
          writeLog(`\n# 写 stdin 失败: ${err.message}\n`);
        }
      } else {
        try {
          child.stdin.end();
        } catch {
          /* ignore */
        }
      }
    });
  }

  /** SIGINT 时把所有跑着的 job 干掉。 */
  function killAll() {
    for (const [id, child] of active) {
      log.warn(`终止子进程 job=${id} pid=${child.pid}`);
      killTree(child);
    }
  }

  return { start, killAll, active };
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      // Windows 上 SIGTERM 不传播给子进程，用 taskkill 整棵树
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000).unref?.();
    }
  } catch (err) {
    log.warn(`kill 失败: ${err.message}`);
  }
}

/** 只用于落库展示：含空格/引号的参数加引号，路径统一成平台分隔符。 */
function quoteForDisplay(arg) {
  const s = String(arg);
  const normalized = s.includes('/') && s.includes('\\') ? s.replace(/\//g, path.sep) : s;
  return /[\s"]/.test(normalized) ? `"${normalized.replace(/"/g, '\\"')}"` : normalized;
}

function indent(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => `#   ${l}`)
    .join('\n');
}

function readIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 结论里是否在等人拍板。 */
export function needsDecision(text) {
  if (!text) return false;
  return DECISION_RE.test(text);
}

export { nowIso };
