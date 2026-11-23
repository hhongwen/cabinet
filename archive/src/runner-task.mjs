// 任务版 runner：给 scheduler 用，和原 runner.mjs 的 job 版并存。
//
// 为什么不直接改 runner.mjs：原版有 44 项 selftest 覆盖，动它风险大。
// 这里复用它的 buildCommand / extractAssistantText / needsDecision，
// 只补「首轮 exec / 续轮 resume」这一层差异。
//
// 实测事实（2026-11-11）：
//   codex exec ... --json            → 首轮，stdout 首行有 thread.started/thread_id
//   codex exec resume <id> --json    → 续轮，同样返回 thread_id
//   resume 不支持 -C / -s，只能靠 cwd 和 config.toml 里的 sandbox_mode
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildCommand, extractAssistantText } from './runner.mjs';
import { ensureDir, nowIso, truncate, createLogger } from './util.mjs';

const log = createLogger('runner2');

/** resume 不支持这些参数，续轮时要剔除。 */
const RESUME_UNSUPPORTED = new Set(['-C', '--cd', '-s', '--sandbox']);

/**
 * 从 agent 配置里拆出「exec 参数」和「resume 前置参数」。
 * resume 的形态是：codex exec resume <id> --json -o file
 * 即 exec 和 resume 共享大部分 flag，但 resume 不认 -C/-s。
 */
function splitResumeArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const base = a.split('=')[0];
    if (RESUME_UNSUPPORTED.has(base)) {
      // 带值的形式：连同值一起跳过
      if (!a.includes('=') && i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * 给 scheduler 用的执行器。
 * @param {object} cfg    完整配置（已展开 %VAR%）
 */
export function createTaskRunner(cfg) {
  const active = new Map(); // runId -> child

  function logPathFor(run) {
    return run.log_path || path.join(cfg._meta.logsDir, `${run.id}.log`);
  }
  function transcriptPathFor(run) {
    return run.transcript_path || path.join(cfg._meta.logsDir, `${run.id}.transcript.jsonl`);
  }
  function lastMessagePathFor(run) {
    return path.join(cfg._meta.logsDir, `${run.id}.last.txt`);
  }

  /**
   * 跑一次任务。
   * @param {object} p
   *   task             任务行
   *   run              run 行（id 已生成）
   *   agentCfg         agent 配置（command/args 已展开）
   *   prompt           本轮 prompt
   *   resumeSessionId  有值则续轮，否则首轮
   * @returns {Promise<{status, exitCode, lastMessage, error, agentSessionId}>}
   */
  function startRun({ task, run, agentCfg, prompt, resumeSessionId = null }) {
    ensureDir(cfg._meta.logsDir);
    const logPath = logPathFor(run);
    const transcriptPath = transcriptPathFor(run);
    const lastMessagePath = lastMessagePathFor(run);

    const isResume = !!(resumeSessionId && agentCfg.supportsResume !== false);

    // 用原 buildCommand 的占位符能力拼基础参数，再按首轮/续轮调整
    let built;
    try {
      built = buildCommand(agentCfg, {
        agent: task.agent,
        cwd: task.cwd ?? cfg._meta.baseDir,
        sandbox: task.sandbox ?? agentCfg.defaultSandbox ?? null,
        model: task.model ?? null,
        reasoning: task.reasoning ?? null,
        last_message_file: lastMessagePath,
        prompt,
      });
    } catch (err) {
      // 拼命令就失败了，路径还没算出来，给调用方留空
      return Promise.resolve({
        status: 'failed', exitCode: null, error: err.message, lastMessage: null,
        agentSessionId: null, logPath: null, transcriptPath: null, lastMessagePath: null,
      });
    }

    // 拼最终的 args
    let command = built.command;
    let args;
    let promptViaStdin = built.promptViaStdin;

    if (isResume) {
      // 形如 [ "...codex.js", "exec", "--json", ... ] →
      // 插入 resume <id>：["...codex.js", "exec", "resume", "<id>", "--json", ...]
      const idx = built.args.findIndex((a) => a === 'exec');
      if (idx >= 0) {
        const resumeArgs = splitResumeArgs(built.args);
        // 去掉未渲染干净的可选占位残留
        const clean = resumeArgs.filter((a) => !/^\{[A-Za-z0-9_]+\}$/.test(a));
        args = [...clean.slice(0, clean.indexOf('exec') + 1), 'resume', resumeSessionId,
          ...clean.slice(clean.indexOf('exec') + 1)];
      } else {
        log.warn(`agent ${task.agent} 的 args 里没有 exec，无法续轮，退回首轮`);
        args = built.args.map((a) => String(a).replace(/^\{.*\}$/, '')).filter(Boolean);
      }
    } else {
      args = built.args;
    }

    // 清掉上一轮产物，避免读到旧结论
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
    writeLog(`# cabinet task ${task.id} run ${run.id} attempt ${run.attempt}\n`);
    writeLog(`# agent=${task.agent} mode=${isResume ? `resume(${resumeSessionId})` : 'fresh'}\n`);
    writeLog(`# cwd=${task.cwd} model=${task.model ?? '-'}\n`);
    writeLog(`# argv: ${JSON.stringify([command, ...args])}\n`);
    writeLog(`# prompt (stdin):\n${indent(prompt)}\n# --- output ---\n`);

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, {
          cwd: task.cwd || cfg._meta.baseDir,
          env: built.env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        logStream.end();
        resolve({
          status: 'failed', exitCode: null,
          error: `spawn 失败: ${err.message}`, lastMessage: null, agentSessionId: null,
          logPath, transcriptPath, lastMessagePath,
        });
        return;
      }

      active.set(run.id, child);

      let stdoutBuf = '';
      let stderrBuf = '';
      let lastAssistant = null;
      let agentSessionId = null;
      let transcriptStream = null;
      let killedByTimeout = false;
      let spawnError = null;

      const timeoutMs = Number(task.timeout_ms ?? cfg.defaultTimeoutMs ?? 15 * 60 * 1000);
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            killedByTimeout = true;
            writeLog(`\n# 超时 ${Math.round(timeoutMs / 1000)}s，终止\n`);
            killTree(child);
          }, timeoutMs)
        : null;

      child.on('error', (err) => {
        spawnError = err;
        writeLog(`\n# 进程错误: ${err.message}\n`);
      });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk) => {
        writeLog(chunk);
        stdoutBuf += chunk;
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line.trim()) continue;
          handleLine(line);
        }
      });

      child.stderr.on('data', (chunk) => {
        writeLog(chunk);
        stderrBuf = (stderrBuf + chunk).slice(-8000);
      });

      function handleLine(line) {
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

        // 抓 session id：续轮的命脉
        if (obj.type === 'thread.started' && obj.thread_id) agentSessionId = obj.thread_id;

        const text = extractAssistantText(obj);
        if (text) lastAssistant = text;
      }

      function done(exitCode, signal) {
        if (timer) clearTimeout(timer);
        if (stdoutBuf.trim()) handleLine(stdoutBuf.trim().replace(/\r$/, ''));
        active.delete(run.id);
        if (transcriptStream) {
          transcriptStream.end();
          transcriptStream = null;
        }
        writeLog(`\n# --- exit=${exitCode} signal=${signal ?? '-'} session=${agentSessionId ?? '-'} ---\n`);
        logStream.end();

        const fromFile = readIfExists(lastMessagePath);
        let lastMessage = fromFile && fromFile.trim() ? fromFile.trim() : null;
        if (!lastMessage && lastAssistant) lastMessage = lastAssistant.trim();

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
          const tail = lastMessage ? `；结论: ${truncate(lastMessage, 200)}` : '';
          error = `退出码 ${exitCode}${signal ? ` (signal ${signal})` : ''}${tail}\n${truncate(stderrBuf.trim(), 800)}`;
        } else {
          status = 'done';
        }
        resolve({ status, exitCode, error, lastMessage, agentSessionId,
          logPath, transcriptPath, lastMessagePath });
      }

      child.on('close', (code, signal) => done(code, signal));

      try {
        if (promptViaStdin) {
          child.stdin.write(prompt ?? '');
          child.stdin.end();
        } else {
          child.stdin.end();
        }
      } catch (err) {
        writeLog(`\n# 写 stdin 失败: ${err.message}\n`);
      }
    });
  }

  function killAll() {
    for (const [id, child] of active) {
      log.warn(`终止子进程 run=${id} pid=${child.pid}`);
      killTree(child);
    }
  }

  return { startRun, killAll, active, _splitResumeArgs: splitResumeArgs };
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5000).unref?.();
    }
  } catch (err) {
    log.warn(`kill 失败: ${err.message}`);
  }
}

function indent(text) {
  return String(text).split(/\r?\n/).map((l) => `#   ${l}`).join('\n');
}

function readIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
